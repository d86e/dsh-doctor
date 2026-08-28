/**
 * Session watcher — in-process monitor for live dsh sessions.
 *
 * Subscribes to the `session/event` cordis event that the dsh host fires
 * for every session in the process. Tracks the per-session state and
 * decides when to nudge a stuck session forward.
 *
 * The "stuck" definition (per user requirement): a session has not emitted
 * any new event for `idleThresholdMs` while still in `turn/start`-but-not-
 * `turn/end` state. Default 10 minutes — tuneable in `Config`.
 *
 * The "nudge" action: send a `继续` (continue) user message to the session's
 * live agent through `ctx.agents.get(sessionId).followup()`. This is the
 * same primitive that the community `dsh-auto-continue` plugin uses.
 *
 * **Dependency story**: this module never `require`s a host package
 * (`@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session`). It only reads
 * `ctx.agents` and `ctx.on('session/event', ...)` — both injected by the
 * dsh host runtime into the cordis context. If those aren't available the
 * `installSessionWatch` call degrades to a no-op and logs.
 *
 * @module dsh-doctor/session-watch
 */
import { StatePaths } from './state.js';
export const DEFAULT_WATCH_CONFIG = {
    watchEnabled: true,
    idleThresholdMs: 3 * 60 * 1000, // 3 minutes
    nudgeCooldownMs: 2 * 60 * 1000, // 2 minutes between nudges
    maxNudgesPerSession: 3,
    continueText: '继续',
    tickIntervalMs: 30_000, // check every 30 s
};
const emptyState = (sessionId) => ({
    sessionId,
    title: null,
    lastEventAt: Date.now(),
    turnRunning: false,
    lastTurn: null,
    lastFailure: null,
    nudgesSent: 0,
    lastNudgeAt: 0,
    lastAutoMessageAt: 0,
    lastManualUserAt: 0,
});
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
/**
 * Install the session watcher. Returns a handle; `isActive` is false if
 * the dsh host did not provide the `agents` service or the
 * `session/event` event — in which case the handle is a no-op and the
 * plugin still works (the other 9 tools + the watchdog are unaffected).
 */
export function installSessionWatch(ctx, cfg, log) {
    const agents = ctx.agents;
    const hasAgents = agents !== undefined && typeof agents.get === 'function';
    if (!hasAgents) {
        void log.warn('session watch disabled: ctx.agents is not available in this host. ' +
            'dsh-doctor will observe tool errors but cannot nudge live sessions.').catch(() => { });
        return { list: () => [], get: () => undefined, nudge: () => ({ ok: false, reason: 'agents-unavailable' }), cancel: () => ({ ok: false, reason: 'agents-unavailable' }), dispose: () => { }, isActive: false };
    }
    if (!cfg.watchEnabled) {
        return { list: () => [], get: () => undefined, nudge: () => ({ ok: false, reason: 'watch-disabled' }), cancel: () => ({ ok: false, reason: 'watch-disabled' }), dispose: () => { }, isActive: false };
    }
    const states = new Map();
    // ---- event subscription ----
    const offEvent = ctx.on?.('session/event', (session, event) => {
        if (!session?.id)
            return;
        const s = states.get(session.id) ?? emptyState(session.id);
        s.lastEventAt = Date.now();
        if (session.title && s.title === null)
            s.title = session.title;
        // The host may pass a richer event than the union below (newer dsh
        // versions add cases). We treat it as `any` inside the switch so the
        // access pattern matches the dsh-auto-continue reference.
        const ev = event;
        switch (ev.type) {
            case 'turn/start':
                s.turnRunning = true;
                if (typeof ev.data?.turn === 'number')
                    s.lastTurn = ev.data.turn;
                break;
            case 'turn/end': {
                s.turnRunning = false;
                const reason = ev.data?.reason;
                if (reason?.kind === 'error') {
                    s.lastFailure = {
                        code: reason.error?.code ?? 'UNKNOWN',
                        message: reason.error?.message ?? '',
                        ...(typeof reason.error?.status === 'number' ? { status: reason.error.status } : {}),
                    };
                }
                else if (reason?.kind === 'completed') {
                    s.lastFailure = null;
                    s.nudgesSent = 0; // success resets the nudge counter
                }
                if (typeof ev.data?.turn === 'number')
                    s.lastTurn = ev.data.turn;
                break;
            }
            case 'user/message': {
                const src = ev.data?.source?.kind;
                if (src === 'user') {
                    // Manual user message → reset the nudge counter (user took over).
                    s.lastManualUserAt = Date.now();
                    s.nudgesSent = 0;
                }
                else if (src === 'system' || src === 'auto') {
                    s.lastAutoMessageAt = Date.now();
                }
                break;
            }
            default:
                break;
        }
        states.set(session.id, s);
        // If a turn ended with an error, run the idle check immediately so
        // the failure-nudge path fires within the next tick (default 30s
        // is too slow when the user is staring at a stalled conversation).
        if (ev.type === 'turn/end' && ev.data?.reason?.kind === 'error') {
            void runIdleCheck();
        }
    });
    // ---- idle tick ----
    const tickHandle = setInterval(() => {
        void runIdleCheck();
    }, cfg.tickIntervalMs);
    // Allow the Node process to exit if the watcher is the only thing left.
    if (typeof tickHandle.unref === 'function') {
        tickHandle.unref();
    }
    const runIdleCheck = async () => {
        const now = Date.now();
        for (const s of states.values()) {
            if (s.nudgesSent >= cfg.maxNudgesPerSession)
                continue;
            if (s.lastNudgeAt > 0 && now - s.lastNudgeAt < cfg.nudgeCooldownMs)
                continue;
            // Skip if a manual user message arrived after the last event (user
            // is currently driving — don't clobber their input).
            if (s.lastManualUserAt > s.lastEventAt - 5_000)
                continue;
            // Two independent nudge paths:
            //   (A) FAILURE nudge: a turn ended with reason.kind === 'error'.
            //       Nudge immediately so an unattended LLM-quota / auth failure
            //       does not stall the conversation until a human types 继续.
            //   (B) IDLE nudge: a turn is running but no event has arrived
            //       for idleThresholdMs (default 3 min). This catches the
            //       silent-stall case where the agent process is alive but
            //       emits nothing (network blip, etc.).
            const failureFresh = s.lastFailure !== null;
            const idleFresh = s.turnRunning && (now - s.lastEventAt) >= cfg.idleThresholdMs;
            if (!failureFresh && !idleFresh)
                continue;
            const text = fillTemplate(cfg.continueText, {
                elapsed: now - s.lastEventAt,
                turn: s.lastTurn ?? '?',
                sessionId: s.sessionId,
            });
            const result = doNudge(s.sessionId, text);
            if (result.ok) {
                s.nudgesSent += 1;
                s.lastNudgeAt = now;
                s.lastAutoMessageAt = now;
                const reason = failureFresh
                    ? `failure=${s.lastFailure?.code ?? 'UNKNOWN'}`
                    : `idle ${Math.round((now - s.lastEventAt) / 1000)}s`;
                await log.info(`session watch: nudged ${s.sessionId} (${reason}, ` +
                    `nudge ${s.nudgesSent}/${cfg.maxNudgesPerSession}, text="${text}")`).catch(() => { });
            }
            else {
                await log.warn(`session watch: nudge failed for ${s.sessionId}: ${result.reason}`).catch(() => { });
            }
        }
    };
    const doNudge = (sessionId, text) => {
        if (!agents)
            return { ok: false, reason: 'agents-unavailable' };
        const a = agents.get(sessionId);
        if (!a)
            return { ok: false, reason: 'no-live-agent' };
        const message = {
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
        };
        try {
            a.followup(message);
            return { ok: true };
        }
        catch (e) {
            return { ok: false, reason: e.message };
        }
    };
    const doCancel = (sessionId) => {
        if (!agents)
            return { ok: false, reason: 'agents-unavailable' };
        const a = agents.get(sessionId);
        if (!a)
            return { ok: false, reason: 'no-live-agent' };
        try {
            a.cancel({ kind: 'user' }, { keepInbox: true });
            return { ok: true };
        }
        catch (e) {
            return { ok: false, reason: e.message };
        }
    };
    void log.info(`session watch active (idle ${Math.round(cfg.idleThresholdMs / 1000)}s, ` +
        `cooldown ${Math.round(cfg.nudgeCooldownMs / 1000)}s, cap ${cfg.maxNudgesPerSession})`).catch(() => { });
    // Suppress unused-variable warnings for fields reserved for future use.
    void StatePaths;
    return {
        list: () => Array.from(states.values()),
        get: (id) => states.get(id),
        nudge: doNudge,
        cancel: doCancel,
        dispose: () => {
            clearInterval(tickHandle);
            try {
                offEvent?.();
            }
            catch { /* noop */ }
        },
        isActive: true,
    };
}
/** Tiny placeholder template engine — supports `{elapsed}`, `{turn}`,
 *  `{sessionId}`. Exported for testability. */
export function fillTemplate(template, vars) {
    return template
        .replaceAll('{elapsed}', vars.elapsed !== undefined ? `${Math.round(vars.elapsed / 1000)}s` : '?')
        .replaceAll('{turn}', vars.turn !== undefined ? String(vars.turn) : '?')
        .replaceAll('{sessionId}', vars.sessionId ?? '?');
}
//# sourceMappingURL=session-watch.js.map