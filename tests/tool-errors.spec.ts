import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'

import {
  defaultClassify,
  defaultPolicy,
  ToolErrorQueue,
  installToolErrorCapture,
  readSummary,
  ensureToolErrorLogFile,
  type ToolErrorEntry,
  type ToolErrorClassifier,
  type ToolErrorPolicy,
} from '../src/tool-errors.js'
import { DoctorLog } from '../src/doctor-log.js'
import { Config } from '../src/config.js'
import { StatePaths } from '../src/state.js'

describe('defaultClassify', () => {
  it('classifies network errors as transient', () => {
    const ctx = { toolName: 'fetch', info: null, message: 'ECONNRESET during read', sessionId: null, agentId: null }
    expect(defaultClassify(ctx)).toBe('transient')
  })

  it('classifies 5xx and 429 as transient', () => {
    expect(defaultClassify({ toolName: 't', info: { name: 'Http', code: '500' }, message: 'server error 500', sessionId: null, agentId: null })).toBe('transient')
    expect(defaultClassify({ toolName: 't', info: null, message: 'received 429', sessionId: null, agentId: null })).toBe('transient')
  })

  it('classifies auth/quota as agent', () => {
    expect(defaultClassify({ toolName: 't', info: null, message: '401 unauthorized', sessionId: null, agentId: null })).toBe('agent')
    expect(defaultClassify({ toolName: 't', info: null, message: 'quota exhausted', sessionId: null, agentId: null })).toBe('agent')
    expect(defaultClassify({ toolName: 't', info: null, message: 'context-length overflow', sessionId: null, agentId: null })).toBe('agent')
  })

  it('classifies business errors as business', () => {
    expect(defaultClassify({ toolName: 't', info: null, message: '404 not found', sessionId: null, agentId: null })).toBe('business')
    expect(defaultClassify({ toolName: 't', info: null, message: 'invalid input', sessionId: null, agentId: null })).toBe('business')
  })

  it('classifies PI_AI_ERROR / Provider returned error as transient (retryable)', () => {
    expect(defaultClassify({ toolName: 't', info: { name: 'PI_AI_ERROR', code: 'PROVIDER' }, message: 'Provider returned error', sessionId: null, agentId: null })).toBe('transient')
    expect(defaultClassify({ toolName: 't', info: null, message: 'PI_AI_ERROR: upstream overloaded', sessionId: null, agentId: null })).toBe('transient')
  })

  it('classifies tool-orchestration errors as agent (our own recoverable mistake)', () => {
    // "Edit requires reading file first" — the agent forgot to read.
    expect(defaultClassify({ toolName: 'edit', info: null, message: 'edit requires reading "/Users/admin/foo.js" first — read the file, then retry', sessionId: null, agentId: null })).toBe('agent')
    // Generic ToolCallError from the tool runtime.
    expect(defaultClassify({ toolName: 't', info: null, message: 'ToolCallError: something went wrong', sessionId: null, agentId: null })).toBe('agent')
    // Cordis inject error — doctor own historical bug.
    expect(defaultClassify({ toolName: 't', info: null, message: 'cannot get property "agents" without inject', sessionId: null, agentId: null })).toBe('agent')
  })
})

describe('defaultPolicy', () => {
  it('transient → record + log, not deferred', () => {
    const p = defaultPolicy({ toolName: 't', info: null, message: '', sessionId: null, agentId: null }, 'transient')
    expect(p).toEqual({ record: true, log: true, defer: false })
  })
  it('agent → record + log + deferred', () => {
    const p = defaultPolicy({ toolName: 't', info: null, message: '', sessionId: null, agentId: null }, 'agent')
    expect(p).toEqual({ record: true, log: true, defer: true })
  })
  it('business → recorded AND logged to logs/tool-errors.log (but never deferred)', () => {
    const p = defaultPolicy({ toolName: 't', info: null, message: '', sessionId: null, agentId: null }, 'business')
    expect(p).toEqual({ record: true, log: true, defer: false })
  })
})

describe('ToolErrorQueue', () => {
  it('keeps entries up to cap, evicts FIFO', () => {
    const q = new ToolErrorQueue(3)
    for (let i = 0; i < 5; i++) {
      q.push({ ts: new Date().toISOString(), toolName: 't' + i, klass: 'transient', message: 'm' + i, info: null, sessionId: 's', agentId: null, policy: 'recorded' })
    }
    const all = q.drain(null, 100)
    expect(all.length).toBe(3)
    expect(all.map((e) => e.toolName)).toEqual(['t2', 't3', 't4'])
  })

  it('drain by session id returns only that session', () => {
    const q = new ToolErrorQueue(100)
    q.push({ ts: new Date().toISOString(), toolName: 'a', klass: 'agent', message: '', info: null, sessionId: 's1', agentId: null, policy: 'deferred' })
    q.push({ ts: new Date().toISOString(), toolName: 'b', klass: 'agent', message: '', info: null, sessionId: 's2', agentId: null, policy: 'deferred' })
    q.push({ ts: new Date().toISOString(), toolName: 'c', klass: 'agent', message: '', info: null, sessionId: 's1', agentId: null, policy: 'deferred' })
    const s1 = q.drain('s1', 100)
    expect(s1.map((e) => e.toolName).sort()).toEqual(['a', 'c'])
    const s2 = q.drain('s2', 100)
    expect(s2.map((e) => e.toolName)).toEqual(['b'])
    // After draining s1, future drains return empty.
    expect(q.drain('s1', 100)).toEqual([])
  })

  it('summary counts within window', () => {
    const q = new ToolErrorQueue(100)
    const now = Date.now()
    q.push({ ts: new Date(now - 1000).toISOString(), toolName: 'a', klass: 'transient', message: '', info: null, sessionId: null, agentId: null, policy: 'recorded' })
    q.push({ ts: new Date(now - 1000).toISOString(), toolName: 'b', klass: 'agent', message: '', info: null, sessionId: null, agentId: null, policy: 'deferred' })
    q.push({ ts: new Date(now - 1000).toISOString(), toolName: 'c', klass: 'business', message: '', info: null, sessionId: null, agentId: null, policy: 'recorded' })
    const s = q.summary(60_000)
    expect(s.transient).toBe(1)
    expect(s.agent).toBe(1)
    expect(s.business).toBe(1)
    expect(s.total).toBe(3)
  })
})

describe('installToolErrorCapture (mock cordis context)', () => {
  let tmpHome: string
  let emitter: EventEmitter
  let fakeCtx: { on: (event: string, fn: (...args: unknown[]) => Promise<unknown>) => () => void }
  let log: DoctorLog

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-doctor-tool-err-'))
    process.env.DSH_HOME = tmpHome
    emitter = new EventEmitter()
    fakeCtx = {
      on: (event, fn) => {
        emitter.on(event, fn)
        return () => emitter.off(event, fn)
      },
    }
    log = new DoctorLog({ file: path.join(tmpHome, 'test-doctor.log'), maxBytes: 1024 * 1024, backups: 1 })
  })
  afterEach(async () => {
    delete process.env.DSH_HOME
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  it('captures a failed tool result with the default classifier', async () => {
    const capture = installToolErrorCapture(fakeCtx as never, Config, log)
    // Simulate a tool failure flowing through the waterfall.
    const errorResult = {
      isError: true,
      error: { message: 'ECONNRESET during read', info: { name: 'NodeError', code: 'ECONNRESET' } },
      content: [],
    }
    const handler = emitter.listeners('tools/execute')[0] as (...args: unknown[]) => Promise<unknown>
    const out = await handler({ name: 'fetch', sessionId: 's1' }, async () => errorResult)
    expect(out).toBe(errorResult)
    const summary = readSummary(capture, 60_000)
    expect(summary.transient).toBe(1)
    expect(summary.total).toBe(1)
    capture.dispose()
  })

  it('respects a user-supplied classifier (override to business)', async () => {
    const userClassifier: ToolErrorClassifier = (ctx) => (ctx.message.includes('panic') ? 'agent' : null)
    const capture = installToolErrorCapture(fakeCtx as never, Config, log, userClassifier)
    const errorResult = {
      isError: true,
      error: { message: 'panic: nil pointer', info: null },
      content: [],
    }
    const handler = emitter.listeners('tools/execute')[0] as (...args: unknown[]) => Promise<unknown>
    await handler({ name: 't', sessionId: 's' }, async () => errorResult)
    const summary = readSummary(capture, 60_000)
    expect(summary.agent).toBe(1)
    capture.dispose()
  })

  it('respects a user-supplied policy that silences a bucket', async () => {
    const userPolicy: ToolErrorPolicy = (_ctx, klass) =>
      klass === 'transient' ? { record: false, log: false, defer: false } : { record: true, log: true, defer: false }
    const capture = installToolErrorCapture(fakeCtx as never, Config, log, undefined, userPolicy)
    const handler = emitter.listeners('tools/execute')[0] as (...args: unknown[]) => Promise<unknown>
    await handler({ name: 't', sessionId: 's' }, async () => ({
      isError: true,
      error: { message: 'ETIMEDOUT', info: null },
      content: [],
    }))
    await handler({ name: 't', sessionId: 's' }, async () => ({
      isError: true,
      error: { message: '404 not found', info: null },
      content: [],
    }))
    const summary = readSummary(capture, 60_000)
    expect(summary.transient).toBe(0) // silenced
    expect(summary.business).toBe(1)
    capture.dispose()
  })

  it('passes through successful results without recording', async () => {
    const capture = installToolErrorCapture(fakeCtx as never, Config, log)
    const handler = emitter.listeners('tools/execute')[0] as (...args: unknown[]) => Promise<unknown>
    const ok = { isError: false, value: { x: 1 }, content: [] }
    const out = await handler({ name: 't', sessionId: 's' }, async () => ok)
    expect(out).toBe(ok)
    expect(capture.total()).toBe(0)
    capture.dispose()
  })

  it('drain() pulls entries by sessionId', async () => {
    const capture = installToolErrorCapture(fakeCtx as never, Config, log)
    const handler = emitter.listeners('tools/execute')[0] as (...args: unknown[]) => Promise<unknown>
    for (const m of ['quota exceeded', 'balance too low', '401 unauthorized']) {
      await handler({ name: 't', sessionId: 's1' }, async () => ({
        isError: true,
        error: { message: m, info: null },
        content: [],
      }))
    }
    await handler({ name: 't', sessionId: 's2' }, async () => ({
      isError: true,
      error: { message: '401 unauthorized', info: null },
      content: [],
    }))
    const s1 = capture.queue.drain('s1', 100)
    expect(s1.length).toBe(3)
    expect(s1.every((e: ToolErrorEntry) => e.klass === 'agent')).toBe(true)
    const s2 = capture.queue.drain('s2', 100)
    expect(s2.length).toBe(1)
    capture.dispose()
  })
})

describe('ensureToolErrorLogFile', () => {
  let tmpHome: string
  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-doctor-tool-err-log-'))
    process.env.DSH_HOME = tmpHome
  })
  afterEach(async () => {
    delete process.env.DSH_HOME
    await fs.rm(tmpHome, { recursive: true, force: true })
  })
  it('creates the file if missing', async () => {
    const f = await ensureToolErrorLogFile(Config)
    expect(f).toBe(path.join(StatePaths.logsDir(), 'tool-errors.log'))
    const stat = await fs.stat(f)
    expect(stat.isFile()).toBe(true)
  })
  it('is idempotent', async () => {
    const f1 = await ensureToolErrorLogFile(Config)
    const f2 = await ensureToolErrorLogFile(Config)
    expect(f1).toBe(f2)
  })
})
