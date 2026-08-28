/**
 * Tool error classifier + sink.
 *
 * Subscribes to dsh's `tools/execute` and `tools/post-execute` waterfalls
 * via the `cordis` event bus. Classifies every failed tool call into one
 * of three buckets and records it (rotating log + in-memory per-session
 * queue). Does **not** mutate the waterfall — `next()` is always called
 * with the original result. The agent's current task is sacred.
 *
 * @module dsh-doctor/tool-errors
 */
import { promises as fs, mkdirSync, accessSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { StatePaths, ensureDir } from './state.js';
import { DoctorLog } from './doctor-log.js';
/** Default per-session queue (FIFO with cap). */
export class ToolErrorQueue {
    cap;
    items = [];
    bySession = new Map();
    constructor(cap) {
        this.cap = Math.max(1, cap);
    }
    push(entry) {
        this.items.push(entry);
        if (entry.sessionId) {
            const list = this.bySession.get(entry.sessionId) ?? [];
            list.push(entry);
            while (list.length > this.cap)
                list.shift();
            this.bySession.set(entry.sessionId, list);
        }
        while (this.items.length > this.cap) {
            const removed = this.items.shift();
            if (removed?.sessionId) {
                const list = this.bySession.get(removed.sessionId);
                if (list) {
                    const idx = list.indexOf(removed);
                    if (idx >= 0)
                        list.splice(idx, 1);
                    if (list.length === 0)
                        this.bySession.delete(removed.sessionId);
                }
            }
        }
    }
    /** Drain the per-session queue; entries are removed. */
    drain(sessionId, max) {
        const limit = Math.max(1, Math.min(this.cap, max));
        if (!sessionId) {
            const out = this.items.slice(-limit);
            return out;
        }
        const list = this.bySession.get(sessionId) ?? [];
        const out = list.slice(-limit);
        this.bySession.set(sessionId, []);
        return out;
    }
    /** Read-only summary for `dsh_doctor_status`. */
    summary(sinceMs) {
        const cutoff = Date.now() - sinceMs;
        let transient = 0;
        let agent = 0;
        let business = 0;
        for (const e of this.items) {
            if (Date.parse(e.ts) < cutoff)
                continue;
            if (e.klass === 'transient')
                transient++;
            else if (e.klass === 'agent')
                agent++;
            else
                business++;
        }
        return { transient, agent, business, total: transient + agent + business };
    }
}
/**
 * Default classifier. Order matters:
 *   1. Network / timeout / 5xx / 429 → transient
 *   2. Auth / quota / unknown-model / context-overflow → agent
 *   3. Everything else (4xx other than 429, application throws) → business
 */
const TRANSIENT_PATTERNS = [
    /\bnetwork\b/i,
    /\bECONNRESET\b/,
    /\bETIMEDOUT\b/,
    /\bEAI_AGAIN\b/,
    /\benotfound\b/i,
    /\beconnreset\b/i,
    /\btime[ -]?out\b/i,
    /\baborted\b/i,
    /\b429\b/,
    /\b5\d\d\b/,
    /\bserver error\b/i,
    /\bupstream\b/i,
    /\brate[-_ ]?limit\b/i,
    /\boverload(ed)?\b/i,
    // Provider-level transient errors (4xx-class but recoverable by retry)
    /\bPI_AI_ERROR\b/,
    /\bProvider returned error\b/i,
];
const AGENT_PATTERNS = [
    /\b401\b/,
    /\b403\b/,
    /\bunauthori[sz]ed\b/i,
    /\bforbidden\b/i,
    /\bcredential\b/i,
    /\bapi[-_ ]?key\b/i,
    /\bquota\b/i,
    /\bbalance\b/i,
    /\bbilling\b/i,
    /\bunknown[-_ ]model\b/i,
    /\bcontext[-_ ]?length\b/i,
    /\bcontext[-_ ]?overflow\b/i,
    /\bmax[-_ ]?tokens\b/i,
    /\btoo large\b/i,
    /\bnot found\b.*\bmodel\b/i,
    // Tool-orchestration errors that are *ours* (we made a bad call)
    // and recoverable by retrying. The agent will re-do the tool call
    // with the correct path / after reading the file.
    /\brequires reading\b.*\bfirst\b/i,
    /\bToolCallError\b/,
    /\bcannot get property\b.*\bwithout inject\b/i,
    /\bENOENT\b.*\bnode_modules\b/i,
];
export function defaultClassify(ctx) {
    const haystack = `${ctx.message} ${ctx.info?.code ?? ''} ${ctx.info?.name ?? ''}`;
    for (const re of TRANSIENT_PATTERNS) {
        if (re.test(haystack))
            return 'transient';
    }
    for (const re of AGENT_PATTERNS) {
        if (re.test(haystack))
            return 'agent';
    }
    return 'business';
}
export function defaultPolicy(_ctx, klass) {
    if (klass === 'transient')
        return { record: true, log: true, defer: false };
    if (klass === 'agent')
        return { record: true, log: true, defer: true };
    // Business errors are also written to logs/tool-errors.log so the
    // operator has a permanent record (the in-memory queue is volatile).
    // They are NOT deferred because the agent may already be handling the
    // error in-band (a 4xx is part of normal API use, not a hang).
    return { record: true, log: true, defer: false };
}
/** Wire the capture into a cordis `Context`. */
export function installToolErrorCapture(ctx, cfg, log, classifier, policy) {
    // Make sure the destination directory + file exist before the listener
    // fires (e.g. when run from a test that did not go through install).
    void ensureToolErrorLogFileSync(cfg);
    const queue = new ToolErrorQueue(cfg.toolErrorMaxQueue);
    let total = 0;
    const file = path.join(StatePaths.logsDir(), 'tool-errors.log');
    const toolErrLog = new DoctorLog({ file, maxBytes: cfg.logMaxBytes, backups: cfg.logBackups });
    let installed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const offExecute = ctx.on?.('tools/execute', async (exec, next) => {
        const result = await next();
        // Inspect the result; if it's a failure, classify and record.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = result;
        if (r && typeof r === 'object' && r.isError === true && r.error) {
            const toolName = exec.name ?? 'unknown';
            const info = r.error.info && typeof r.error.info === 'object'
                ? { name: String(r.error.info.name ?? ''), code: String(r.error.info.code ?? '') }
                : null;
            const message = typeof r.error.message === 'string' ? r.error.message : String(r.error);
            const sessionId = exec.sessionId ?? null;
            const agentId = exec.agent
                ? typeof exec.agent === 'string'
                    ? (exec.agent)
                    : (exec.agent.id ?? null)
                : null;
            const c = { toolName, info, message, sessionId, agentId };
            const userKlass = classifier ? classifier(c) : null;
            const klass = (userKlass ?? defaultClassify(c));
            const p = (policy ?? defaultPolicy)(c, klass);
            const entry = {
                ts: new Date().toISOString(),
                toolName,
                klass,
                message,
                info,
                sessionId,
                agentId,
                policy: p.defer ? 'deferred' : p.record ? 'recorded' : 'silenced',
            };
            if (p.record) {
                queue.push(entry);
                total++;
                if (p.log) {
                    await toolErrLog.write('WARN', `[${klass}] ${toolName} session=${sessionId ?? '-'} agent=${agentId ?? '-'} ${message}`);
                }
                await log.debug(`tool error captured: ${toolName} → ${klass} (${entry.policy})`);
            }
        }
        return result;
    });
    // Also listen to `tools/post-execute` for a final marker — this fires after
    // the dispatch waterfall settled. We use it only to update the doctor log
    // (no extra work; the result is already in `tools/execute`).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const offPost = ctx.on?.('tools/post-execute', async (_exec, _result, next) => {
        return next();
    });
    installed = offExecute !== undefined;
    if (!installed) {
        // dsh-tools is on a version that does not expose the tools/* events;
        // degrade gracefully — no error, just no capture.
        void log;
    }
    return {
        queue,
        total: () => total,
        dispose: () => {
            try {
                offExecute?.();
            }
            catch { /* noop */ }
            try {
                offPost?.();
            }
            catch { /* noop */ }
        },
    };
}
/** Read the latest summary for the `status` tool. */
export function readSummary(capture, windowMs = 60 * 60 * 1000) {
    const s = capture.queue.summary(windowMs);
    return { ...s, queueSize: capture.queue.summary(Number.POSITIVE_INFINITY).total };
}
/** Make sure the tool-errors log file exists (touch). */
export async function ensureToolErrorLogFile(cfg) {
    await ensureDir(StatePaths.logsDir());
    const file = path.join(StatePaths.logsDir(), 'tool-errors.log');
    try {
        await fs.access(file);
    }
    catch {
        await fs.writeFile(file, '', { mode: 0o600 });
        void cfg;
    }
    return file;
}
/** Synchronous variant for paths that must exist before the listener fires. */
function ensureToolErrorLogFileSync(cfg) {
    try {
        mkdirSync(StatePaths.logsDir(), { recursive: true });
    }
    catch {
        // ignore
    }
    const file = path.join(StatePaths.logsDir(), 'tool-errors.log');
    try {
        accessSync(file);
    }
    catch {
        try {
            writeFileSync(file, '', { mode: 0o600 });
        }
        catch {
            // ignore
        }
    }
    void cfg;
    return file;
}
//# sourceMappingURL=tool-errors.js.map