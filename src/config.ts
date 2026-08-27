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
  healthIntervalMs: number
  /** Consecutive failures before triage starts. */
  healthFailuresToRecover: number
  /** Hard ceiling on total downtime per incident (ms). */
  recoveryBudgetMs: number
  /** Per-log rotation size in bytes. */
  logMaxBytes: number
  /** Number of rotated log files kept. */
  logBackups: number
  /** Bundles kept enabled in complex-path safe mode. */
  safeModeBundles: string[]
  /** Subscribe to tools/* event waterfalls. */
  toolErrorCapture: boolean
  /** Max entries kept per session in the in-memory queue. */
  toolErrorMaxQueue: number
}

export const Config: Config = {
  healthIntervalMs: 30_000,
  healthFailuresToRecover: 3,
  recoveryBudgetMs: 60_000,
  logMaxBytes: 5 * 1024 * 1024,
  logBackups: 3,
  safeModeBundles: ['dsh-core'],
  toolErrorCapture: true,
  toolErrorMaxQueue: 500,
}

/**
 * Resolve the watchdog's effective config at any moment, layering:
 *  1. The plugin's `Config` snapshot (read at install time).
 *  2. `DSH_DOCTOR_*` environment overrides (read at every watchdog tick).
 */
export function resolveConfig(base: Config, env: NodeJS.ProcessEnv = process.env): Config {
  const num = (k: string, fallback: number): number => {
    const v = env[k]
    if (v === undefined || v === '') return fallback
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  const bool = (k: string, fallback: boolean): boolean => {
    const v = env[k]
    if (v === undefined || v === '') return fallback
    return v === '1' || v.toLowerCase() === 'true'
  }
  return {
    healthIntervalMs: num('DSH_DOCTOR_HEALTH_INTERVAL', base.healthIntervalMs),
    healthFailuresToRecover: num('DSH_DOCTOR_HEALTH_FAILURES', base.healthFailuresToRecover),
    recoveryBudgetMs: num('DSH_DOCTOR_BUDGET_MS', base.recoveryBudgetMs),
    logMaxBytes: base.logMaxBytes,
    logBackups: base.logBackups,
    safeModeBundles: base.safeModeBundles,
    toolErrorCapture: bool('DSH_DOCTOR_TOOL_ERROR_CAPTURE', base.toolErrorCapture),
    toolErrorMaxQueue: num('DSH_DOCTOR_TOOL_ERROR_QUEUE', base.toolErrorMaxQueue),
  }
}
