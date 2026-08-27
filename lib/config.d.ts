/**
 * Plugin configuration surfaced to the watchdog.
 *
 * `Config` is the **schemastery schema** that dsh's cordis loader
 * (v4.x) reads through `plugin.Config["~standard"].validate(config)`.
 * The runtime applies the schema's defaults; `resolveConfig` then
 * layers the `DSH_DOCTOR_*` env overrides on top of the snapshot.
 *
 * Why schemastery: cordis 4.0.1 calls `runtime.Config["~standard"].validate`
 * on the raw user config; a plain object throws
 * `Cannot read properties of undefined (reading 'validate')`. We need
 * a real schema to mount at all.
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
    /** Auto-install the watchdog on first plugin load (default true). */
    autoInstall: boolean;
}
export declare const Config: unknown;
/** The default-values snapshot, also useful for the CLI doctor at startup. */
export declare const ConfigDefaults: Config;
/**
 * Resolve the watchdog's effective config at any moment, layering:
 *  1. The plugin's `Config` schema defaults (above).
 *  2. The user-provided values from `cordis.patch.yml` (already
 *     schemastery-validated and defaulted when dsh loaded us).
 *  3. `DSH_DOCTOR_*` environment overrides (read at every watchdog
 *     tick so operators can change knobs without an install).
 */
export declare function resolveConfig(base: Config, env?: NodeJS.ProcessEnv): Config;
//# sourceMappingURL=config.d.ts.map