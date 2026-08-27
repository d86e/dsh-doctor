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
import type { Context } from '@deepseek-ai/cordis';
import { DoctorLog } from './doctor-log.js';
/** Subset of `Agent` we use. */
export interface DshAgent {
    followup(message: unknown): void;
    cancel(source: {
        kind: 'user' | 'system';
    }, opts?: {
        keepInbox?: boolean;
    }): void;
    status?(): string;
}
/** Subset of the `agents` service exposed by the dsh host. */
export interface DshAgentsService {
    get(sessionId: string): DshAgent | undefined;
    list(): DshAgent[];
}
/** A `UserMessage` is what `agent.followup` accepts. The dsh host only
 *  requires that the shape be JSON-serialisable; we type the minimum. */
export interface DshUserMessage {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    source: {
        kind: 'user' | 'system';
    };
}
/** Subset of `Session`. The host passes a richer object; we only read `id`. */
export interface DshSession {
    id: string;
    title?: string;
}
/** Subset of `SessionEvent` discriminated union. The host passes the full
 *  union; we only inspect the cases we care about. */
export type DshSessionEvent = {
    type: 'turn/start';
    data?: Record<string, unknown>;
} | {
    type: 'turn/end';
    data: {
        reason: {
            kind: 'completed';
        } | {
            kind: 'aborted';
        } | {
            kind: 'blocked';
        } | {
            kind: 'interrupted';
        } | {
            kind: 'error';
            error: {
                code?: string;
                message?: string;
                status?: number;
            };
        } | {
            kind: 'max-tokens';
        };
        turn?: number;
    };
} | {
    type: 'tool/call';
    data: {
        name: string;
        arguments?: unknown;
    };
} | {
    type: 'tool/result';
    data: Record<string, unknown>;
} | {
    type: 'assistant/message';
    data: {
        message: {
            content?: Array<{
                type: string;
                text?: string;
            }>;
        };
    };
} | {
    type: 'user/message';
    data: {
        source: {
            kind: string;
        };
        content?: Array<{
            type: string;
            text?: string;
        }>;
    };
} | {
    type: string;
    data?: Record<string, unknown>;
};
export interface WatchConfig {
    /** Master switch. */
    watchEnabled: boolean;
    /** No new event for this long → candidate for a nudge. */
    idleThresholdMs: number;
    /** Don't nudge the same session more often than this. */
    nudgeCooldownMs: number;
    /** Nudge at most this many times per session before giving up. */
    maxNudgesPerSession: number;
    /** Text to send (supports `{elapsed}`, `{turn}` placeholders). */
    continueText: string;
    /** Tick interval for the idle check. */
    tickIntervalMs: number;
}
export declare const DEFAULT_WATCH_CONFIG: WatchConfig;
export interface SessionState {
    sessionId: string;
    title: string | null;
    /** Last time *any* session event arrived. */
    lastEventAt: number;
    /** Set between turn/start and turn/end. */
    turnRunning: boolean;
    /** Last turn number seen. */
    lastTurn: number | null;
    /** Last failure facts (if the previous turn ended in error). */
    lastFailure: {
        code: string;
        message: string;
        status?: number;
    } | null;
    /** How many times we've nudged this session. */
    nudgesSent: number;
    /** When the last nudge was sent. */
    lastNudgeAt: number;
    /** When the last `user/message` was sent by *us* (echo guard). */
    lastAutoMessageAt: number;
    /** When the last *manual* user message arrived (resets nudge counter). */
    lastManualUserAt: number;
}
export interface SessionWatch {
    /** Snapshot of every tracked session. */
    list(): SessionState[];
    /** One session, or undefined. */
    get(sessionId: string): SessionState | undefined;
    /** Manually send a `继续` (or custom) message to one session. */
    nudge(sessionId: string, text?: string): {
        ok: boolean;
        reason?: string;
    };
    /** Cancel the current turn on one session. */
    cancel(sessionId: string): {
        ok: boolean;
        reason?: string;
    };
    /** Stop the watcher and clear the tick timer. */
    dispose(): void;
    /** Whether the host exposed the dependencies we need. */
    isActive: boolean;
}
/**
 * Install the session watcher. Returns a handle; `isActive` is false if
 * the dsh host did not provide the `agents` service or the
 * `session/event` event — in which case the handle is a no-op and the
 * plugin still works (the other 9 tools + the watchdog are unaffected).
 */
export declare function installSessionWatch(ctx: Context, cfg: WatchConfig, log: DoctorLog): SessionWatch;
/** Tiny placeholder template engine — supports `{elapsed}`, `{turn}`,
 *  `{sessionId}`. Exported for testability. */
export declare function fillTemplate(template: string, vars: {
    elapsed?: number;
    turn?: number | string;
    sessionId?: string;
}): string;
//# sourceMappingURL=session-watch.d.ts.map