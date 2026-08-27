/**
 * Plugin configuration surfaced to the watchdog.
 *
 * `Config` is the default config object (not a Schemastery schema — cordis
 * expects a plain object, see the dsh plugin template). The runtime
 * applies defaults and partial-overrides per-field; `resolveConfig`
 * layers the `DSH_DOCTOR_*` env overrides on top of the snapshot.
 *
 * @module dsh-doctor/config
 */
export interface Config {
    /** Milliseconds between /health probes. */
    healthIntervalMs: number;
    /** Consecutive failures before triage starts. */
    healthFailuresToRecover: number;
    /** Hard ceiling on total downtime per incident (ms). */
    recoveryBudgetMs: number;
    /** Per-log rotation size in bytes. */
    logMaxBytes: number;
    /** Number of rotated log files kept. */
    logBackups: number;
    /** Bundles kept enabled in complex-path safe mode. */
    safeModeBundles: string[];
    /** Subscribe to tools/* event waterfalls. */
    toolErrorCapture: boolean;
    /** Max entries kept per session in the in-memory queue. */
    toolErrorMaxQueue: number;
    /** Master switch for the session watcher. */
    watchEnabled: boolean;
    /** A session with no event for this long is a candidate for a nudge. */
    watchIdleThresholdMs: number;
    /** Minimum interval between two nudges of the same session. */
    watchNudgeCooldownMs: number;
    /** Stop nudging a session after this many nudges. */
    watchMaxNudgesPerSession: number;
    /** Text to send (supports {elapsed}, {turn}, {sessionId}). */
    watchContinueText: string;
    /** Idle-check tick interval. */
    watchTickIntervalMs: number;
}
export declare const Config: Config;
/**
 * Resolve the watchdog's effective config at any moment, layering:
 *  1. The plugin's `Config` snapshot (read at install time).
 *  2. `DSH_DOCTOR_*` environment overrides (read at every watchdog tick).
 */
export declare function resolveConfig(base: Config, env?: NodeJS.ProcessEnv): Config;
//# sourceMappingURL=config.d.ts.map