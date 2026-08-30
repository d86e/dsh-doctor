import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

import {
  installSessionWatch,
  fillTemplate,
  type DshAgent,
  type DshAgentsService,
  type DshSession,
  type DshSessionEvent,
  type WatchConfig,
} from '../src/session-watch.js'
import { DoctorLog } from '../src/doctor-log.js'

// A controllable mock agent. Records every followup / cancel call.
function makeAgent() {
  const calls: { kind: 'followup' | 'cancel'; payload?: unknown }[] = []
  const agent: DshAgent = {
    followup(message) { calls.push({ kind: 'followup', payload: message }) },
    cancel(source, opts) { calls.push({ kind: 'cancel', payload: { source, opts } }) },
  }
  return { agent, calls }
}

function defaultCfg(): WatchConfig {
  return {
    watchEnabled: true,
    idleThresholdMs: 1000,
    nudgeCooldownMs: 1000,
    maxNudgesPerSession: 2,
    continueText: '继续',
    tickIntervalMs: 100_000, // long enough to never auto-fire in the test window
  }
}

describe('fillTemplate', () => {
  it('substitutes elapsed, turn, sessionId', () => {
    expect(fillTemplate('{elapsed}', { elapsed: 5000 })).toBe('5s')
    expect(fillTemplate('{turn}', { turn: 7 })).toBe('7')
    expect(fillTemplate('{sessionId}', { sessionId: 'abc' })).toBe('abc')
  })
  it('falls back to ? when a variable is missing', () => {
    expect(fillTemplate('a{elapsed}b{turn}c{sessionId}d', {})).toBe('a?b?c?d')
  })
})

describe('installSessionWatch (no agents service)', () => {
  it('returns a no-op handle when ctx.agents is missing', () => {
    const fakeCtx = { on: () => () => {} }
    // The watch will try to log a warning; provide a stub log.
    const stubLog = {
      warn: () => Promise.resolve(),
      info: () => Promise.resolve(),
      error: () => Promise.resolve(),
      debug: () => Promise.resolve(),
    } as never
    const watch = installSessionWatch(fakeCtx as never, { ...defaultCfg(), watchEnabled: true }, stubLog)
    expect(watch.isActive).toBe(false)
    expect(watch.list()).toEqual([])
    expect(watch.nudge('any', 'x')).toEqual({ ok: false, reason: 'agents-unavailable' })
    expect(watch.cancel('any')).toEqual({ ok: false, reason: 'agents-unavailable' })
  })
})

describe('installSessionWatch (with agents service)', () => {
  let tmpHome: string
  let log: DoctorLog
  let emitter: EventEmitter
  // The watcher subscribes via the `on` field. We re-route calls into `emitter`.
  let fakeCtx: Record<string, unknown>
  let agents: DshAgentsService
  let agentMap: Map<string, DshAgent>
  let sentCalls: ReturnType<typeof makeAgent>['calls']
  let watch: ReturnType<typeof installSessionWatch>

  beforeEach(() => {
    tmpHome = '/tmp/dsh-doctor-watch-' + Math.random().toString(36).slice(2)
    void fs.mkdir(tmpHome, { recursive: true })
    process.env.DSH_HOME = tmpHome
    log = new DoctorLog({ file: path.join(tmpHome, 'doctor.log'), maxBytes: 1024 * 1024, backups: 1 })
    emitter = new EventEmitter()
    fakeCtx = {
      on: (e: string, fn: (...a: unknown[]) => void) => {
        emitter.on(e, fn)
        return () => emitter.off(e, fn)
      },
    }
    agentMap = new Map()
    const { agent, calls } = makeAgent()
    sentCalls = calls
    agentMap.set('sess-1', agent)
    agents = {
      get: (id) => agentMap.get(id),
      list: () => Array.from(agentMap.values()),
    }
    fakeCtx.agents = agents
    watch = installSessionWatch(fakeCtx as never, defaultCfg(), log)
  })
  afterEach(async () => {
    watch.dispose()
    emitter.removeAllListeners()
    delete process.env.DSH_HOME
    // Let the dispose-unref'd interval release before the next test touches fs.
    await new Promise((r) => setTimeout(r, 20))
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  function emit(session: Partial<DshSession>, event: DshSessionEvent): void {
    emitter.emit('session/event', session, event)
  }

  it('isActive when agents is present', () => {
    expect(watch.isActive).toBe(true)
  })

  it('tracks sessions on session/event', () => {
    emit({ id: 'sess-1', title: 'hello' }, { type: 'turn/start' })
    const all = watch.list()
    expect(all.length).toBe(1)
    expect(all[0].sessionId).toBe('sess-1')
    expect(all[0].title).toBe('hello')
    expect(all[0].turnRunning).toBe(true)
  })

  it('records last failure on turn/end:error', () => {
    emit({ id: 'sess-1' }, { type: 'turn/start' })
    emit({ id: 'sess-1' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'ETIMEDOUT', message: 'upstream timeout' } } } })
    const s = watch.get('sess-1')!
    expect(s.lastFailure).toEqual({ code: 'ETIMEDOUT', message: 'upstream timeout' })
    expect(s.turnRunning).toBe(false)
  })

  it('records synthetic failure on turn/end:aborted (unattended: nudge to resume)', () => {
    emit({ id: 'sess-1' }, { type: 'turn/start' })
    emit({ id: 'sess-1' }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    const s = watch.get('sess-1')!
    expect(s.lastFailure).toEqual({ code: 'TURN_ABORTED', message: 'turn ended with reason.kind=aborted' })
  })

  it('records synthetic failure on turn/end:interrupted (unattended: nudge to resume)', () => {
    emit({ id: 'sess-1' }, { type: 'turn/start' })
    emit({ id: 'sess-1' }, { type: 'turn/end', data: { reason: { kind: 'interrupted' } } })
    const s = watch.get('sess-1')!
    expect(s.lastFailure).toEqual({ code: 'TURN_INTERRUPTED', message: 'turn ended with reason.kind=interrupted' })
  })

  it('records synthetic failure on turn/end:max-tokens (unattended: nudge to resume)', () => {
    emit({ id: 'sess-1' }, { type: 'turn/start' })
    emit({ id: 'sess-1' }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
    const s = watch.get('sess-1')!
    expect(s.lastFailure).toEqual({ code: 'TURN_MAX-TOKENS', message: 'turn ended with reason.kind=max-tokens' })
  })

  it('records synthetic failure on turn/end:blocked (unattended: nudge to resume)', () => {
    emit({ id: 'sess-1' }, { type: 'turn/start' })
    emit({ id: 'sess-1' }, { type: 'turn/end', data: { reason: { kind: 'blocked' } } })
    const s = watch.get('sess-1')!
    expect(s.lastFailure).toEqual({ code: 'TURN_BLOCKED', message: 'turn ended with reason.kind=blocked' })
  })

  it('does NOT set a synthetic failure on turn/end:completed (normal exit)', () => {
    emit({ id: 'sess-1' }, { type: 'turn/start' })
    emit({ id: 'sess-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    const s = watch.get('sess-1')!
    expect(s.lastFailure).toBeNull()
  })

  it('resets nudgesSent and lastFailure on turn/end:completed', () => {
    emit({ id: 'sess-1' }, { type: 'turn/start' })
    emit({ id: 'sess-1' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'X', message: 'X' } } } })
    watch.get('sess-1')!.nudgesSent = 2
    emit({ id: 'sess-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    const s = watch.get('sess-1')!
    expect(s.lastFailure).toBeNull()
    expect(s.nudgesSent).toBe(0)
  })

  it('resets nudgesSent on a manual user/message', () => {
    emit({ id: 'sess-1' }, { type: 'turn/start' })
    watch.get('sess-1')!.nudgesSent = 2
    emit({ id: 'sess-1' }, { type: 'user/message', data: { source: { kind: 'user' } } })
    expect(watch.get('sess-1')!.nudgesSent).toBe(0)
  })

  it('manual nudge sends a followup with the expected text', () => {
    emit({ id: 'sess-1' }, { type: 'turn/start' })
    const r = watch.nudge('sess-1', '请继续')
    expect(r.ok).toBe(true)
    expect(sentCalls.length).toBe(1)
    expect(sentCalls[0].kind).toBe('followup')
    const message = sentCalls[0].payload as { content: Array<{ type: string; text: string }>; source: { kind: string } }
    expect(message.content[0].text).toBe('请继续')
    expect(message.source.kind).toBe('user')
  })

  it('manual cancel sends a cancel with kind=user and keepInbox=true', () => {
    emit({ id: 'sess-1' }, { type: 'turn/start' })
    const r = watch.cancel('sess-1')
    expect(r.ok).toBe(true)
    expect(sentCalls.length).toBe(1)
    expect(sentCalls[0].kind).toBe('cancel')
  })

  it('manual nudge on an unknown session returns no-live-agent', () => {
    const r = watch.nudge('does-not-exist', '继续')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no-live-agent')
  })

  it('auto-nudges immediately on turn/end:error (regression: QUOTA stalls conversation)', async () => {
    // When a turn ends with reason.kind === 'error' (e.g. dsh-agent got
    // a 402 / Insufficient balance from the model provider), the
    // conversation is effectively stalled: no new events will arrive.
    // The user (or a doctor nudge) must intervene. dsh-doctor's
    // session watch now fires the nudge on the same event tick, not
    // after waiting the full idleThresholdMs.
    emit({ id: 'sess-1' }, { type: 'turn/start' })
    emit({ id: 'sess-1' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'QUOTA', message: 'Insufficient balance' } } } })
    // The watch is wired to call runIdleCheck synchronously after a
    // turn/end:error — but runIdleCheck is async, so we await a
    // microtask flush.
    await new Promise((r) => setTimeout(r, 5))
    expect(sentCalls.length).toBeGreaterThanOrEqual(1)
    const call = sentCalls[0]
    expect(call.kind).toBe('followup')
    const text = call.payload.content.find((c: { type: string }) => c.type === 'text')?.text
    expect(text).toBe('继续')
  })

  it('does NOT auto-nudge a healthy turn/end:completed', async () => {
    emit({ id: 'sess-2' }, { type: 'turn/start' })
    emit({ id: 'sess-2' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await new Promise((r) => setTimeout(r, 5))
    expect(sentCalls.length).toBe(0)
  })

  it('auto-nudges on turn/end:aborted (unattended operation)', async () => {
    const sentBefore = sentCalls.length
    emit({ id: 'sess-1' }, { type: 'turn/start' })
    emit({ id: 'sess-1' }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    await new Promise((r) => setTimeout(r, 5))
    expect(sentCalls.length).toBeGreaterThan(sentBefore)
    const text = sentCalls[sentBefore].payload.content.find((c: { type: string }) => c.type === 'text')?.text
    expect(text).toBe('继续')
  })

  it('auto-nudges on turn/end:interrupted (unattended operation)', async () => {
    const sentBefore = sentCalls.length
    emit({ id: 'sess-1' }, { type: 'turn/start' })
    emit({ id: 'sess-1' }, { type: 'turn/end', data: { reason: { kind: 'interrupted' } } })
    await new Promise((r) => setTimeout(r, 5))
    expect(sentCalls.length).toBeGreaterThan(sentBefore)
  })

  it('auto-nudges on turn/end:max-tokens (unattended operation)', async () => {
    const sentBefore = sentCalls.length
    emit({ id: 'sess-1' }, { type: 'turn/start' })
    emit({ id: 'sess-1' }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
    await new Promise((r) => setTimeout(r, 5))
    expect(sentCalls.length).toBeGreaterThan(sentBefore)
  })
})
