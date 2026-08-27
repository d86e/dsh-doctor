import { describe, it, expect } from 'vitest'
import { resolveConfig, Config } from '../src/config.js'

describe('resolveConfig', () => {
  it('returns the base when no env overrides are set', () => {
    expect(resolveConfig(Config, {})).toEqual(Config)
  })

  it('overrides healthIntervalMs from DSH_DOCTOR_HEALTH_INTERVAL', () => {
    const out = resolveConfig(Config, { DSH_DOCTOR_HEALTH_INTERVAL: '5000' })
    expect(out.healthIntervalMs).toBe(5000)
  })

  it('overrides healthFailuresToRecover from DSH_DOCTOR_HEALTH_FAILURES', () => {
    const out = resolveConfig(Config, { DSH_DOCTOR_HEALTH_FAILURES: '5' })
    expect(out.healthFailuresToRecover).toBe(5)
  })

  it('overrides recoveryBudgetMs from DSH_DOCTOR_BUDGET_MS', () => {
    const out = resolveConfig(Config, { DSH_DOCTOR_BUDGET_MS: '90000' })
    expect(out.recoveryBudgetMs).toBe(90000)
  })

  it('overrides toolErrorMaxQueue from DSH_DOCTOR_TOOL_ERROR_QUEUE', () => {
    const out = resolveConfig(Config, { DSH_DOCTOR_TOOL_ERROR_QUEUE: '120' })
    expect(out.toolErrorMaxQueue).toBe(120)
  })

  it('ignores garbage env values (falls back to base)', () => {
    const out = resolveConfig(Config, { DSH_DOCTOR_HEALTH_INTERVAL: 'not-a-number' })
    expect(out.healthIntervalMs).toBe(Config.healthIntervalMs)
  })

  it('keeps safeModeBundles, logMaxBytes, logBackups from base', () => {
    const out = resolveConfig(Config, { DSH_DOCTOR_HEALTH_INTERVAL: '1000' })
    expect(out.safeModeBundles).toEqual(Config.safeModeBundles)
    expect(out.logMaxBytes).toBe(Config.logMaxBytes)
    expect(out.logBackups).toBe(Config.logBackups)
  })

  it('default Config has sensible tool-error defaults', () => {
    expect(Config.toolErrorCapture).toBe(true)
    expect(Config.toolErrorMaxQueue).toBe(500)
  })
})
