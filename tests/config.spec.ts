import { describe, it, expect } from 'vitest'
import { resolveConfig, ConfigDefaults, Config } from '../src/config.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

describe('Config (schemastery schema)', () => {
  it('is a schemastery object schema (has ~standard)', () => {
    expect(Config).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const standard = (Config as any)['~standard']
    expect(standard).toBeDefined()
    expect(typeof standard.validate).toBe('function')
  })

  it('validates a partial config and applies defaults', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const standard = (Config as any)['~standard']
    const result = standard.validate({ healthIntervalMs: 12345 })
    expect(result.issues).toBeUndefined()
    expect(result.value.healthIntervalMs).toBe(12345)
    // Defaults filled in:
    expect(result.value.healthFailuresToRecover).toBe(3)
    expect(result.value.toolErrorCapture).toBe(true)
    expect(result.value.toolErrorMaxQueue).toBe(500)
    expect(result.value.watchEnabled).toBe(true)
    expect(result.value.watchIdleThresholdMs).toBe(3 * 60 * 1000)
    expect(result.value.watchNudgeCooldownMs).toBe(2 * 60 * 1000)
    expect(result.value.watchMaxNudgesPerSession).toBe(3)
    expect(result.value.watchContinueText).toBe('继续')
    expect(result.value.watchTickIntervalMs).toBe(30_000)
  })

  it('validates an empty config and applies all defaults', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const standard = (Config as any)['~standard']
    const result = standard.validate({})
    expect(result.issues).toBeUndefined()
    expect(result.value.healthIntervalMs).toBe(2_000)
    expect(result.value.recoveryBudgetMs).toBe(60_000)
  })

  it('rejects a non-integer for natural-typed fields', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const standard = (Config as any)['~standard']
    const result = standard.validate({ healthFailuresToRecover: -1 })
    expect(result.issues).toBeDefined()
  })
})

describe('ConfigDefaults (plain snapshot)', () => {
  it('matches what the schemastery schema applies by default', () => {
    expect(ConfigDefaults.toolErrorCapture).toBe(true)
    expect(ConfigDefaults.toolErrorMaxQueue).toBe(500)
    expect(ConfigDefaults.watchEnabled).toBe(true)
    expect(ConfigDefaults.watchIdleThresholdMs).toBe(3 * 60 * 1000)
    expect(ConfigDefaults.watchNudgeCooldownMs).toBe(2 * 60 * 1000)
    expect(ConfigDefaults.watchMaxNudgesPerSession).toBe(3)
    expect(ConfigDefaults.watchContinueText).toBe('继续')
  })
})

describe('resolveConfig (env overrides on a plain base)', () => {
  it('returns the base when no env overrides are set', () => {
    expect(resolveConfig(ConfigDefaults, {})).toEqual(ConfigDefaults)
  })

  it('overrides healthIntervalMs from DSH_DOCTOR_HEALTH_INTERVAL', () => {
    const out = resolveConfig(ConfigDefaults, { DSH_DOCTOR_HEALTH_INTERVAL: '5000' })
    expect(out.healthIntervalMs).toBe(5000)
  })

  it('overrides healthFailuresToRecover from DSH_DOCTOR_HEALTH_FAILURES', () => {
    const out = resolveConfig(ConfigDefaults, { DSH_DOCTOR_HEALTH_FAILURES: '5' })
    expect(out.healthFailuresToRecover).toBe(5)
  })

  it('overrides recoveryBudgetMs from DSH_DOCTOR_BUDGET_MS', () => {
    const out = resolveConfig(ConfigDefaults, { DSH_DOCTOR_BUDGET_MS: '90000' })
    expect(out.recoveryBudgetMs).toBe(90000)
  })

  it('overrides toolErrorMaxQueue from DSH_DOCTOR_TOOL_ERROR_QUEUE', () => {
    const out = resolveConfig(ConfigDefaults, { DSH_DOCTOR_TOOL_ERROR_QUEUE: '120' })
    expect(out.toolErrorMaxQueue).toBe(120)
  })

  it('overrides watchIdleThresholdMs from DSH_DOCTOR_WATCH_IDLE_MS', () => {
    const out = resolveConfig(ConfigDefaults, { DSH_DOCTOR_WATCH_IDLE_MS: '300000' })
    expect(out.watchIdleThresholdMs).toBe(300_000)
  })

  it('ignores garbage env values (falls back to base)', () => {
    const out = resolveConfig(ConfigDefaults, { DSH_DOCTOR_HEALTH_INTERVAL: 'not-a-number' })
    expect(out.healthIntervalMs).toBe(ConfigDefaults.healthIntervalMs)
  })

  it('keeps safeModeBundles, logMaxBytes, logBackups from base', () => {
    const out = resolveConfig(ConfigDefaults, { DSH_DOCTOR_HEALTH_INTERVAL: '1000' })
    expect(out.safeModeBundles).toEqual(ConfigDefaults.safeModeBundles)
    expect(out.logMaxBytes).toBe(ConfigDefaults.logMaxBytes)
    expect(out.logBackups).toBe(ConfigDefaults.logBackups)
  })
})
