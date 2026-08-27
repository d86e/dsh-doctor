/**
 * @d86e/dsh-doctor — plugin entry.
 *
 * Registers the `dsh_doctor_*` tools on the `tools` service and refuses to
 * load if the resolved `@deepseek-ai/dsh-tools` is outside the tested
 * range (see version.ts).
 *
 * Dual mode:
 *   1. Static package — mount as a DSH composition row (see cordis.patch.yml).
 *      The loader invokes `apply(ctx, config)` and the nine tools become
 *      available to every agent after the next `dsh web` start.
 *   2. Dynamic sandbox — paste the *built* `lib/index.js` into the
 *      `code.host` field of `cordis_define` and run it. The sandbox supplies
 *      the `harness` global, which we adapt to the same `ctx.tools` shape.
 *
 * @module @d86e/dsh-doctor
 */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { Config, resolveConfig } from './config.js';
import { StatePaths, doctorBase, ensureDir, readFileOrNull, tailFile, pidAlive, writeFileAtomic, } from './state.js';
import { satisfiesCaret, TESTED_PEER_RANGE } from './version.js';
import { DoctorLog } from './doctor-log.js';
import { triage, diagnose } from './triage.js';
import { applySafeModePatch, clearSafeModePatch, isSafeModeActive } from './safe-mode.js';
import { buildServiceSpec, writeServiceSpec, removeServiceSpec, currentPlatform, } from './platform.js';
import { installWatchdogScript, isWatchdogInstalled, pluginVersion, } from './watchdog.js';
import { WATCHDOG_STANDALONE_BODY } from './watchdog.standalone.js';
import { installToolErrorCapture, readSummary, ensureToolErrorLogFile, } from './tool-errors.js';
import { installSessionWatch, } from './session-watch.js';
const execFile = promisify(execFileCb);
const require = createRequire(import.meta.url);
export const name = 'dsh-doctor';
export const inject = ['tools', 'agents'];
/** Snapshot of the resolved @deepseek-ai/dsh-tools version. Exposed for tests. */
export function resolvedDshToolsVersion() {
    try {
        const pkg = require('@deepseek-ai/dsh-tools/package.json');
        return pkg.version ?? 'unknown';
    }
    catch {
        return 'unresolved';
    }
}
/** Turn a silent peer mismatch into a loud, actionable load error. */
export function assertPeerCompatible() {
    const v = resolvedDshToolsVersion();
    if (!satisfiesCaret(v, TESTED_PEER_RANGE)) {
        throw new Error(`@d86e/dsh-doctor: resolved @deepseek-ai/dsh-tools ${v}, but this plugin is tested with `
            + `${TESTED_PEER_RANGE}. Upgrade DeepSeek Harness to 0.1.0-rc.6 or later, then reinstall. `
            + 'See the Troubleshooting section in the README.');
    }
}
function makeHarness(_ctx) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sandboxHarness = typeof globalThis.harness !== 'undefined' ? globalThis.harness : null;
    if (sandboxHarness) {
        return {
            defineTool: (def) => sandboxHarness.defineTool(def),
            registerTool: (c, def) => sandboxHarness.registerTool(c, def),
        };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolsPkg = require('@deepseek-ai/dsh-tools');
    return {
        defineTool: (def) => toolsPkg.defineTool(def),
        registerTool: (c, def) => c.tools.register(def),
    };
}
function jsonContent(value) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}
const JSON_OUTPUT = {
    schema: { type: 'json' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render: (_args, value) => jsonContent(value),
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function execBody(fn) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return fn;
}
// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------
export function apply(ctx, config) {
    assertPeerCompatible();
    const harness = makeHarness(ctx);
    const log = new DoctorLog({
        file: StatePaths.doctorLog(),
        maxBytes: config.logMaxBytes,
        backups: config.logBackups,
    });
    const cfg = config;
    // Wire tool error capture (degrades silently if the host does not expose
    // the tools/* event waterfalls).
    let capture = null;
    if (cfg.toolErrorCapture) {
        try {
            capture = installToolErrorCapture(ctx, cfg, log);
            void ensureToolErrorLogFile(cfg);
        }
        catch (e) {
            void log.warn(`tool error capture failed to install: ${e.message}`);
            capture = null;
        }
    }
    // Wire session watcher (degrades silently if the host does not expose
    // ctx.agents / session/event).
    let watch = null;
    if (cfg.watchEnabled) {
        try {
            const watchCfg = {
                watchEnabled: cfg.watchEnabled,
                idleThresholdMs: cfg.watchIdleThresholdMs,
                nudgeCooldownMs: cfg.watchNudgeCooldownMs,
                maxNudgesPerSession: cfg.watchMaxNudgesPerSession,
                continueText: cfg.watchContinueText,
                tickIntervalMs: cfg.watchTickIntervalMs,
            };
            watch = installSessionWatch(ctx, watchCfg, log);
        }
        catch (e) {
            void log.warn(`session watch failed to install: ${e.message}`);
            watch = null;
        }
    }
    // ---- dsh_doctor_install ----
    harness.registerTool(ctx, defineTool({
        name: 'dsh_doctor_install',
        description: 'Install the dsh-doctor watchdog: write the standalone Node script, register the platform service ' +
            '(LaunchAgent / systemd / Task Scheduler), and start it. Idempotent.',
        parameters: {
            port: { type: 'number', description: 'DSH web port to probe. Defaults to DSH_WEB_PORT or 3080.' },
            dryRun: { type: 'boolean', description: 'Build all files but do not register or start the service.', default: false },
        },
        output: JSON_OUTPUT,
        execute: execBody(async (args, _exec) => {
            const port = args.port ?? (Number(process.env.DSH_WEB_PORT) || 3080);
            const result = {
                ok: false,
                installedAt: new Date().toISOString(),
                watchdogPath: '',
                platform: currentPlatform(),
                serviceLabel: '',
                started: false,
                dryRun: !!args.dryRun,
            };
            await ensureDir(StatePaths.doctorHome());
            await ensureDir(StatePaths.logsDir());
            await ensureToolErrorLogFile(cfg);
            const resolved = resolveConfig(cfg);
            await writeFileAtomic(StatePaths.configJson(), JSON.stringify(resolved, null, 2));
            result.watchdogPath = await installWatchdogScript();
            await log.info(`watchdog script written at ${result.watchdogPath}`);
            let spec;
            try {
                spec = await buildServiceSpec({
                    nodeBin: process.execPath,
                    dshHome: doctorBase(),
                    webPort: port,
                });
                await writeServiceSpec(spec);
                result.serviceLabel = spec.label;
                await log.info(`platform service spec: ${spec.label} → ${spec.file}`);
            }
            catch (e) {
                await log.warn(`platform spec generation failed: ${e.message}`);
                throw e;
            }
            await writeFileAtomic(StatePaths.installedMarker(), JSON.stringify({ installedAt: result.installedAt, version: pluginVersion() }, null, 2));
            if (result.dryRun) {
                result.ok = true;
                await log.info('dry-run: not registering or starting the service');
                return result;
            }
            try {
                await execFile(spec.registerCmd[0], spec.registerCmd.slice(1), {
                    env: { ...process.env, DSH_HOME: doctorBase(), DSH_WEB_PORT: String(port) },
                });
                await log.info(`platform service registered: ${spec.label}`);
            }
            catch (e) {
                await log.warn(`register command failed (continuing): ${e.message}`);
            }
            try {
                await execFile(spec.startCmd[0], spec.startCmd.slice(1), {
                    env: { ...process.env, DSH_HOME: doctorBase(), DSH_WEB_PORT: String(port) },
                });
                await log.info(`platform service start requested: ${spec.label}`);
            }
            catch (e) {
                await log.warn(`start command failed (continuing): ${e.message}`);
            }
            result.started = true;
            result.ok = true;
            return result;
        }),
    }));
    // ---- dsh_doctor_uninstall ----
    harness.registerTool(ctx, defineTool({
        name: 'dsh_doctor_uninstall',
        description: 'Unregister the platform service, remove state files. Logs are kept by default.',
        parameters: {
            purgeLogs: { type: 'boolean', description: 'Also delete $DSH_HOME/doctor/logs/.', default: false },
        },
        output: JSON_OUTPUT,
        execute: execBody(async (args, _exec) => {
            const removed = [];
            try {
                const spec = await buildServiceSpec({
                    nodeBin: process.execPath,
                    dshHome: doctorBase(),
                    webPort: Number(process.env.DSH_WEB_PORT) || 3080,
                });
                try {
                    await execFile(spec.stopCmd[0], spec.stopCmd.slice(1));
                    removed.push(`stopped ${spec.label}`);
                }
                catch (e) {
                    await log.warn(`stop command failed (continuing): ${e.message}`);
                }
                try {
                    await execFile(spec.unregisterCmd[0], spec.unregisterCmd.slice(1));
                    removed.push(`unregistered ${spec.label}`);
                }
                catch (e) {
                    await log.warn(`unregister command failed (continuing): ${e.message}`);
                }
            }
            catch (e) {
                await log.warn(`platform spec build failed during uninstall: ${e.message}`);
            }
            for (const f of [
                StatePaths.installedMarker(),
                StatePaths.stoppedMarker(),
                StatePaths.restartLock(),
                StatePaths.watchdogPid(),
                StatePaths.configJson(),
                StatePaths.lastKnownGood(),
                StatePaths.safeModePatch(),
                StatePaths.watchdogScript(),
            ]) {
                try {
                    await fs.unlink(f);
                    removed.push(f);
                }
                catch (err) {
                    if (err.code !== 'ENOENT') {
                        await log.warn(`unlink failed for ${f}: ${err.message}`);
                    }
                }
            }
            await removeServiceSpec();
            removed.push(`${StatePaths.platformDir()}/`);
            if (args.purgeLogs) {
                try {
                    const entries = await fs.readdir(StatePaths.logsDir());
                    for (const e of entries) {
                        await fs.rm(path.join(StatePaths.logsDir(), e), { force: true });
                        removed.push(`${StatePaths.logsDir()}/${e}`);
                    }
                }
                catch (err) {
                    if (err.code !== 'ENOENT') {
                        await log.warn(`log purge failed: ${err.message}`);
                    }
                }
            }
            capture?.dispose();
            watch?.dispose();
            await log.info(`uninstall complete: ${removed.length} paths removed`);
            return {
                ok: true,
                removed,
                logsPurged: !!args.purgeLogs,
                platform: currentPlatform(),
            };
        }),
    }));
    // ---- dsh_doctor_status ----
    harness.registerTool(ctx, defineTool({
        name: 'dsh_doctor_status',
        description: 'Snapshot: installed, running, last 5 recoveries, uptime, port, current mode, tool-error counts.',
        parameters: {},
        output: JSON_OUTPUT,
        execute: execBody(async (_args, _exec) => {
            const installed = await isWatchdogInstalled();
            let running = false;
            let pid = null;
            let uptime = null;
            if (installed) {
                const raw = await readFileOrNull(StatePaths.watchdogPid());
                if (raw) {
                    const n = Number(raw.trim());
                    if (Number.isInteger(n) && n > 0 && pidAlive(n)) {
                        running = true;
                        pid = n;
                        uptime = 'unknown (pid alive)';
                    }
                }
            }
            const cfgResolved = resolveConfig(cfg);
            const recent = await readRecentRecoveries(5);
            const safeMode = await isSafeModeActive();
            const paused = (await readFileOrNull(StatePaths.stoppedMarker())) !== null;
            return {
                installed,
                running,
                pid,
                uptime,
                platform: currentPlatform(),
                webPort: Number(process.env.DSH_WEB_PORT) || 3080,
                paused,
                safeMode,
                config: cfgResolved,
                recent,
                toolErrors: capture ? readSummary(capture) : null,
                toolErrorCaptureEnabled: !!capture,
                watchActive: !!watch?.isActive,
                trackedSessions: watch ? watch.list().length : 0,
                version: pluginVersion(),
            };
        }),
    }));
    // ---- dsh_doctor_pause ----
    harness.registerTool(ctx, defineTool({
        name: 'dsh_doctor_pause',
        description: 'Pause the watchdog: probes continue, recovery is skipped.',
        parameters: {},
        output: JSON_OUTPUT,
        execute: execBody(async (_args, _exec) => {
            await writeFileAtomic(StatePaths.stoppedMarker(), new Date().toISOString());
            await log.info('watchdog paused');
            return { ok: true, paused: true };
        }),
    }));
    // ---- dsh_doctor_resume ----
    harness.registerTool(ctx, defineTool({
        name: 'dsh_doctor_resume',
        description: 'Resume the watchdog after a pause.',
        parameters: {},
        output: JSON_OUTPUT,
        execute: execBody(async (_args, _exec) => {
            try {
                await fs.unlink(StatePaths.stoppedMarker());
            }
            catch (err) {
                if (err.code !== 'ENOENT')
                    throw err;
            }
            await log.info('watchdog resumed');
            return { ok: true, paused: false };
        }),
    }));
    // ---- dsh_doctor_diagnose ----
    harness.registerTool(ctx, defineTool({
        name: 'dsh_doctor_diagnose',
        description: 'One-shot triage of the current dsh web failure. Returns the verdict without restarting.',
        parameters: {
            logLines: { type: 'number', description: 'How many log lines to consider. Defaults to 200.', default: 200 },
        },
        output: JSON_OUTPUT,
        execute: execBody(async (args, _exec) => {
            const n = Math.max(10, Math.min(2000, args.logLines ?? 200));
            const lines = await tailFile(StatePaths.watchdogLog(), n);
            const d = diagnose(lines);
            return {
                ok: true,
                matched: d.matched ? d.matched.id : null,
                reason: d.reason,
                plan: d.plan,
                logLines: lines.length,
            };
        }),
    }));
    // ---- dsh_doctor_safe_mode_enter ----
    harness.registerTool(ctx, defineTool({
        name: 'dsh_doctor_safe_mode_enter',
        description: 'Manually enable the safe-mode patch layer. Useful for debugging plugin-induced boot failures.',
        parameters: {},
        output: JSON_OUTPUT,
        execute: execBody(async (_args, _exec) => {
            const p = await applySafeModePatch(resolveConfig(cfg).safeModeBundles);
            await log.info(`safe-mode manually enabled at ${p}`);
            return { ok: true, safeMode: true, path: p };
        }),
    }));
    // ---- dsh_doctor_safe_mode_exit ----
    harness.registerTool(ctx, defineTool({
        name: 'dsh_doctor_safe_mode_exit',
        description: 'Manually disable the safe-mode patch layer.',
        parameters: {},
        output: JSON_OUTPUT,
        execute: execBody(async (_args, _exec) => {
            await clearSafeModePatch();
            await log.info('safe-mode manually disabled');
            return { ok: true, safeMode: false, path: StatePaths.safeModePatch() };
        }),
    }));
    // ---- dsh_doctor_drain_deferred (NEW in 0.1.0) ----
    harness.registerTool(ctx, defineTool({
        name: 'dsh_doctor_drain_deferred',
        description: 'Surface the queued "deferred" agent-class tool errors for the current session. ' +
            'Intended for a quiet moment in a turn — the doctor never mutates the live waterfall.',
        parameters: {
            sessionId: { type: 'string', description: 'Session id to drain. Defaults to "current" (the whole queue, capped).' },
            max: { type: 'number', description: 'Max entries to return. Defaults to 50.', default: 50 },
        },
        output: JSON_OUTPUT,
        execute: execBody(async (args, _exec) => {
            if (!capture) {
                return { ok: false, reason: 'tool-error capture is disabled', entries: [] };
            }
            const total = capture.queue.summary(Number.POSITIVE_INFINITY).total;
            const max = Math.max(1, Math.min(total || 1, args.max ?? 50));
            const sessionId = args.sessionId && args.sessionId !== 'current' ? args.sessionId : null;
            const entries = capture.queue.drain(sessionId, max);
            await log.info(`drained ${entries.length} deferred tool errors (sessionId=${sessionId ?? 'all'})`);
            return { ok: true, reason: 'drained', sessionId: sessionId ?? 'all', entries };
        }),
    }));
    // ---- dsh_doctor_watch_list (NEW in 0.2.0) ----
    harness.registerTool(ctx, defineTool({
        name: 'dsh_doctor_watch_list',
        description: 'List all sessions the doctor is currently watching. Each entry shows last event age, ' +
            'whether a turn is running, how many nudges have been sent, and the last failure (if any).',
        parameters: {},
        output: JSON_OUTPUT,
        execute: execBody(async (_args, _exec) => {
            if (!watch)
                return { ok: false, reason: 'session watch is disabled', sessions: [] };
            return {
                ok: true,
                reason: 'list',
                watchActive: watch.isActive,
                count: watch.list().length,
                sessions: watch.list(),
            };
        }),
    }));
    // ---- dsh_doctor_watch_nudge (NEW in 0.2.0) ----
    harness.registerTool(ctx, defineTool({
        name: 'dsh_doctor_watch_nudge',
        description: 'Manually inject a "continue" message into a live session. Use this when the user wants ' +
            'to unstick a session on demand (the automatic watch already handles idle detection).',
        parameters: {
            sessionId: { type: 'string', description: 'Session id to nudge.', required: true },
            text: { type: 'string', description: 'Text to inject. Defaults to the configured continue text.' },
        },
        output: JSON_OUTPUT,
        execute: execBody(async (args, _exec) => {
            if (!watch)
                return { ok: false, reason: 'session watch is disabled' };
            const text = args.text && args.text.length > 0 ? args.text : cfg.watchContinueText;
            const r = watch.nudge(args.sessionId, text);
            await log.info(`manual nudge ${args.sessionId}: ${r.ok ? 'sent' : r.reason}`);
            return { ok: r.ok, reason: r.reason ?? 'sent', sessionId: args.sessionId, text };
        }),
    }));
    // ---- dsh_doctor_watch_cancel (NEW in 0.2.0) ----
    harness.registerTool(ctx, defineTool({
        name: 'dsh_doctor_watch_cancel',
        description: 'Cancel the current turn on a live session. Use this when a session is truly hung and ' +
            'a nudge will not help (e.g. the agent is in a loop). The cancellation is marked as ' +
            '"user" so it is not confused with a system stop.',
        parameters: {
            sessionId: { type: 'string', description: 'Session id whose turn should be cancelled.', required: true },
        },
        output: JSON_OUTPUT,
        execute: execBody(async (args, _exec) => {
            if (!watch)
                return { ok: false, reason: 'session watch is disabled' };
            const r = watch.cancel(args.sessionId);
            await log.info(`manual cancel ${args.sessionId}: ${r.ok ? 'cancelled' : r.reason}`);
            return { ok: r.ok, reason: r.reason ?? 'cancelled', sessionId: args.sessionId };
        }),
    }));
}
async function readRecentRecoveries(n) {
    const lines = await tailFile(StatePaths.watchdogLog(), 200);
    const out = [];
    let cur = null;
    for (const line of lines) {
        if (line.includes('health probe failed')) {
            if (cur)
                out.push(cur);
            cur = { ts: extractTs(line), plan: 'probe-failed', detail: line.split(']').slice(2).join(']').trim() };
        }
        else if (line.includes('triage: matched=') && cur) {
            const m = line.match(/triage: matched=(\S+)/);
            if (m)
                cur.plan = m[1] ?? cur.plan;
            cur.detail = line.split(']').slice(2).join(']').trim();
        }
        else if (line.includes('recovered after') && cur) {
            cur.detail += ' | ' + line.split(']').slice(2).join(']').trim();
        }
    }
    if (cur)
        out.push(cur);
    return out.slice(-n).reverse();
}
function extractTs(line) {
    const m = line.match(/^\[([^\]]+)\]/);
    return m ? m[1] : '';
}
// Re-export for unit tests and for the dsh CLI doctor subcommand.
export { Config, resolveConfig, satisfiesCaret, TESTED_PEER_RANGE, triage, diagnose, applySafeModePatch, clearSafeModePatch, isSafeModeActive, buildServiceSpec, writeServiceSpec, removeServiceSpec, currentPlatform, installWatchdogScript, isWatchdogInstalled, pluginVersion, WATCHDOG_STANDALONE_BODY, };
//# sourceMappingURL=index.js.map