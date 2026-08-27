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
import { createRequire } from 'node:module';
// Use createRequire to avoid bundler-time resolution differences.
// The dsh host always provides @deepseek-ai/schemastery in the same
// profile node_modules because every plugin in the dsh ecosystem depends
// on it.
const require = createRequire(import.meta.url);
const z = require('@deepseek-ai/schemastery');
const Defaults = {
    healthIntervalMs: 30_000,
    healthFailuresToRecover: 3,
    recoveryBudgetMs: 60_000,
    logMaxBytes: 5 * 1024 * 1024,
    logBackups: 3,
    safeModeBundles: ['dsh-core'],
    toolErrorCapture: true,
    toolErrorMaxQueue: 500,
    watchEnabled: true,
    watchIdleThresholdMs: 3 * 60 * 1000, // 3 minutes (was 10 — too long for live sessions)
    watchNudgeCooldownMs: 2 * 60 * 1000, // 2 minutes between nudges
    watchMaxNudgesPerSession: 3,
    watchContinueText: '继续',
    watchTickIntervalMs: 30_000,
};
export const Config = z.object({
    healthIntervalMs: z.number().default(Defaults.healthIntervalMs),
    healthFailuresToRecover: z.natural().min(1).default(Defaults.healthFailuresToRecover),
    recoveryBudgetMs: z.number().default(Defaults.recoveryBudgetMs),
    logMaxBytes: z.number().default(Defaults.logMaxBytes),
    logBackups: z.natural().min(1).default(Defaults.logBackups),
    safeModeBundles: z.array(z.string()).default(Defaults.safeModeBundles),
    toolErrorCapture: z.boolean().default(Defaults.toolErrorCapture),
    toolErrorMaxQueue: z.natural().min(1).default(Defaults.toolErrorMaxQueue),
    watchEnabled: z.boolean().default(Defaults.watchEnabled),
    watchIdleThresholdMs: z.number().default(Defaults.watchIdleThresholdMs),
    watchNudgeCooldownMs: z.number().default(Defaults.watchNudgeCooldownMs),
    watchMaxNudgesPerSession: z.natural().min(1).default(Defaults.watchMaxNudgesPerSession),
    watchContinueText: z.string().default(Defaults.watchContinueText),
    watchTickIntervalMs: z.number().default(Defaults.watchTickIntervalMs),
});
/** The default-values snapshot, also useful for the CLI doctor at startup. */
export const ConfigDefaults = { ...Defaults };
/**
 * Resolve the watchdog's effective config at any moment, layering:
 *  1. The plugin's `Config` schema defaults (above).
 *  2. The user-provided values from `cordis.patch.yml` (already
 *     schemastery-validated and defaulted when dsh loaded us).
 *  3. `DSH_DOCTOR_*` environment overrides (read at every watchdog
 *     tick so operators can change knobs without an install).
 */
export function resolveConfig(base, env = process.env) {
    const num = (k, fallback) => {
        const v = env[k];
        if (v === undefined || v === '')
            return fallback;
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    const bool = (k, fallback) => {
        const v = env[k];
        if (v === undefined || v === '')
            return fallback;
        return v === '1' || v.toLowerCase() === 'true';
    };
    return {
        healthIntervalMs: num('DSH_DOCTOR_HEALTH_INTERVAL', base.healthIntervalMs),
        healthFailuresToRecover: num('DSH_DOCTOR_HEALTH_FAILURES', base.healthFailuresToRecover),
        recoveryBudgetMs: num('DSH_DOCTOR_BUDGET_MS', base.recoveryBudgetMs),
        logMaxBytes: base.logMaxBytes,
        logBackups: base.logBackups,
        safeModeBundles: base.safeModeBundles,
        toolErrorCapture: bool('DSH_DOCTOR_TOOL_ERROR_CAPTURE', base.toolErrorCapture),
        toolErrorMaxQueue: num('DSH_DOCTOR_TOOL_ERROR_QUEUE', base.toolErrorMaxQueue),
        watchEnabled: bool('DSH_DOCTOR_WATCH_ENABLED', base.watchEnabled),
        watchIdleThresholdMs: num('DSH_DOCTOR_WATCH_IDLE_MS', base.watchIdleThresholdMs),
        watchNudgeCooldownMs: num('DSH_DOCTOR_WATCH_COOLDOWN_MS', base.watchNudgeCooldownMs),
        watchMaxNudgesPerSession: num('DSH_DOCTOR_WATCH_MAX_NUDGES', base.watchMaxNudgesPerSession),
        watchContinueText: (env.DSH_DOCTOR_WATCH_TEXT && env.DSH_DOCTOR_WATCH_TEXT.length > 0)
            ? env.DSH_DOCTOR_WATCH_TEXT
            : base.watchContinueText,
        watchTickIntervalMs: num('DSH_DOCTOR_WATCH_TICK_MS', base.watchTickIntervalMs),
    };
}
//# sourceMappingURL=config.js.map