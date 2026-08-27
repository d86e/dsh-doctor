import { describe, it, expect } from 'vitest'
import { triage, diagnose, PATTERNS } from '../src/triage.js'

describe('triage patterns', () => {
  it('matches EADDRINUSE first (priority 100)', () => {
    const plan = triage(['Error: listen EADDRINUSE: address already in use 127.0.0.1:3080'])
    expect(plan.kind).toBe('kill-pid-and-restart')
  })

  it('matches duplicate loader entry id and names the plugin', () => {
    const plan = triage(['FATAL duplicate loader entry id: dsh-foo-bar'])
    expect(plan.kind).toBe('disable-row')
    if (plan.kind === 'disable-row') {
      expect(plan.pluginId).toBe('dsh-foo-bar')
    }
  })

  it('matches Schema parse error and names the package', () => {
    const plan = triage(['Schema parse error in @scope/bad-pkg: invalid value for field x'])
    expect(plan.kind).toBe('disable-row')
    if (plan.kind === 'disable-row') {
      expect(plan.pluginId).toBe('@scope/bad-pkg')
    }
  })

  it('matches Cannot find module and guesses a scoped package', () => {
    const plan = triage(["Error: Cannot find module '@scope/dsh-broken/sub/path'"])
    expect(plan.kind).toBe('disable-row')
    if (plan.kind === 'disable-row') {
      expect(plan.pluginId).toBe('@scope/dsh-broken')
    }
  })

  it('matches Cannot find module and guesses an unscoped package', () => {
    const plan = triage(["Error: Cannot find module 'some-pkg'"])
    expect(plan.kind).toBe('disable-row')
    if (plan.kind === 'disable-row') {
      expect(plan.pluginId).toBe('some-pkg')
    }
  })

  it('matches generic plugin load error', () => {
    const plan = triage(['Error loading plugin @scope/dsh-broken'])
    expect(plan.kind).toBe('disable-row')
    if (plan.kind === 'disable-row') {
      expect(plan.pluginId).toBe('@scope/dsh-broken')
    }
  })

  it('falls through to safe-mode when nothing matches', () => {
    const plan = triage(['Some completely unknown failure', 'with no recognizable token'])
    expect(plan.kind).toBe('safe-mode')
  })

  it('PATTERNS is non-empty and unique by id', () => {
    expect(PATTERNS.length).toBeGreaterThan(0)
    const ids = PATTERNS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('diagnose', () => {
  it('returns the matched pattern and a plan', () => {
    const d = diagnose(['duplicate loader entry id: dsh-x'])
    expect(d.matched?.id).toBe('duplicate-loader-entry')
    expect(d.plan.kind).toBe('disable-row')
  })

  it('returns matched=null and a safe-mode plan when nothing matches', () => {
    const d = diagnose(['nothing recognizable'])
    expect(d.matched).toBeNull()
    expect(d.plan.kind).toBe('safe-mode')
  })
})
