/**
 * Tool error classifier + sink.
 *
 * Subscribes to dsh's `tools/execute` and `tools/post-execute` waterfalls
 * via the `cordis` event bus. Classifies every failed tool call into one
 * of three buckets and records it (rotating log + in-memory per-session
 * queue). Does **not** mutate the waterfall — `next()` is always called
 * with the original result. The agent's current task is sacred.
 *
 * @module dsh-doctor/tool-errors
 */

import { promises as fs, mkdirSync, accessSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

import { StatePaths, ensureDir } from './state.js'
import { DoctorLog } from './doctor-log.js'
import type { Config as ConfigT } from './config.js'

/** Three-way classification used by the doctor. */
export type ToolErrorClass = 'transient' | 'agent' | 'business'

/** Public context object handed to user-supplied classifiers. */
export interface ToolErrorContext {
  /** Name of the tool that failed. */
  toolName: string
  /** ToolErrorInfo (name + code) if present, else null. */
  info: { name: string; code: string } | null
  /** Human-readable error message. */
  message: string
  /** Session id the tool call belongs to, if known. */
  sessionId: string | null
  /** Agent id, if known. */
  agentId: string | null
}

/** A user-supplied override. Returning a string overrides the default. */
export type ToolErrorClassifier = (ctx: ToolErrorContext) => ToolErrorClass | null | undefined

/** A user-supplied policy: called after classification, returns whether to record. */
export type ToolErrorPolicy = (
  ctx: ToolErrorContext,
  klass: ToolErrorClass,
) => { record: boolean; log: boolean; defer: boolean }

/** One recorded error. */
export interface ToolErrorEntry {
  ts: string
  toolName: string
  klass: ToolErrorClass
  message: string
  info: { name: string; code: string } | null
  sessionId: string | null
  agentId: string | null
  policy: 'recorded' | 'silenced' | 'deferred'
}

/** Default per-session queue (FIFO with cap). */
export class ToolErrorQueue {
  private readonly cap: number
  private readonly items: ToolErrorEntry[] = []
  private readonly bySession = new Map<string, ToolErrorEntry[]>()

  constructor(cap: number) {
    this.cap = Math.max(1, cap)
  }

  push(entry: ToolErrorEntry): void {
    this.items.push(entry)
    if (entry.sessionId) {
      const list = this.bySession.get(entry.sessionId) ?? []
      list.push(entry)
      while (list.length > this.cap) list.shift()
      this.bySession.set(entry.sessionId, list)
    }
    while (this.items.length > this.cap) {
      const removed = this.items.shift()
      if (removed?.sessionId) {
        const list = this.bySession.get(removed.sessionId)
        if (list) {
          const idx = list.indexOf(removed)
          if (idx >= 0) list.splice(idx, 1)
          if (list.length === 0) this.bySession.delete(removed.sessionId)
        }
      }
    }
  }

  /** Drain the per-session queue; entries are removed. */
  drain(sessionId: string | null, max: number): ToolErrorEntry[] {
    const limit = Math.max(1, Math.min(this.cap, max))
    if (!sessionId) {
      const out = this.items.slice(-limit)
      return out
    }
    const list = this.bySession.get(sessionId) ?? []
    const out = list.slice(-limit)
    this.bySession.set(sessionId, [])
    return out
  }

  /** Read-only summary for `dsh_doctor_status`. */
  summary(sinceMs: number): { transient: number; agent: number; business: number; total: number } {
    const cutoff = Date.now() - sinceMs
    let transient = 0
    let agent = 0
    let business = 0
    for (const e of this.items) {
      if (Date.parse(e.ts) < cutoff) continue
      if (e.klass === 'transient') transient++
      else if (e.klass === 'agent') agent++
      else business++
    }
    return { transient, agent, business, total: transient + agent + business }
  }
}

/**
 * Default classifier. Order matters:
 *   1. Network / timeout / 5xx / 429 → transient
 *   2. Auth / quota / unknown-model / context-overflow → agent
 *   3. Everything else (4xx other than 429, application throws) → business
 */
const TRANSIENT_PATTERNS: RegExp[] = [
  /\bnetwork\b/i,
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bEAI_AGAIN\b/,
  /\benotfound\b/i,
  /\beconnreset\b/i,
  /\btime[ -]?out\b/i,
  /\baborted\b/i,
  /\b429\b/,
  /\b5\d\d\b/,
  /\bserver error\b/i,
  /\bupstream\b/i,
  /\brate[-_ ]?limit\b/i,
  /\boverload(ed)?\b/i,
  // Provider-level transient errors (4xx-class but recoverable by retry)
  /\bPI_AI_ERROR\b/,
  /\bProvider returned error\b/i,
]

const AGENT_PATTERNS: RegExp[] = [
  /\b401\b/,
  /\b403\b/,
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /\bcredential\b/i,
  /\bapi[-_ ]?key\b/i,
  /\bquota\b/i,
  /\bbalance\b/i,
  /\bbilling\b/i,
  /\bunknown[-_ ]model\b/i,
  /\bcontext[-_ ]?length\b/i,
  /\bcontext[-_ ]?overflow\b/i,
  /\bmax[-_ ]?tokens\b/i,
  /\btoo large\b/i,
  /\bnot found\b.*\bmodel\b/i,
  // Tool-orchestration errors that are *ours* (we made a bad call)
  // and recoverable by retrying. The agent will re-do the tool call
  // with the correct path / after reading the file.
  /\brequires reading\b.*\bfirst\b/i,
  /\bToolCallError\b/,
  /\bcannot get property\b.*\bwithout inject\b/i,
  /\bENOENT\b.*\bnode_modules\b/i,
]

export function defaultClassify(ctx: ToolErrorContext): ToolErrorClass {
  const haystack = `${ctx.message} ${ctx.info?.code ?? ''} ${ctx.info?.name ?? ''}`
  for (const re of TRANSIENT_PATTERNS) {
    if (re.test(haystack)) return 'transient'
  }
  for (const re of AGENT_PATTERNS) {
    if (re.test(haystack)) return 'agent'
  }
  return 'business'
}

export function defaultPolicy(_ctx: ToolErrorContext, klass: ToolErrorClass): {
  record: boolean
  log: boolean
  defer: boolean
} {
  if (klass === 'transient') return { record: true, log: true, defer: false }
  if (klass === 'agent') return { record: true, log: true, defer: true }
  // Business errors are also written to logs/tool-errors.log so the
  // operator has a permanent record (the in-memory queue is volatile).
  // They are NOT deferred because the agent may already be handling the
  // error in-band (a 4xx is part of normal API use, not a hang).
  return { record: true, log: true, defer: false }
}

/** Returned handle so the doctor can stop subscribing in tests. */
export interface ToolErrorCapture {
  queue: ToolErrorQueue
  /** Total entries since the capture started (regardless of cap). */
  total: () => number
  /** Stop listening and clear the file sink. */
  dispose: () => void
}

/** Wire the capture into a cordis `Context`. */
export function installToolErrorCapture(
  ctx: Context,
  cfg: ConfigT,
  log: DoctorLog,
  classifier?: ToolErrorClassifier,
  policy?: ToolErrorPolicy,
): ToolErrorCapture {
  // Make sure the destination directory + file exist before the listener
  // fires (e.g. when run from a test that did not go through install).
  void ensureToolErrorLogFileSync(cfg)
  const queue = new ToolErrorQueue(cfg.toolErrorMaxQueue)
  let total = 0
  const file = path.join(StatePaths.logsDir(), 'tool-errors.log')
  const toolErrLog = new DoctorLog({ file, maxBytes: cfg.logMaxBytes, backups: cfg.logBackups })
  let installed = false

  // Helper: classify + record a single failure for a given exec object.
  // Two shapes of failure are supported:
  //   (a) next() returned   { isError: true, error: { … } }   — the
  //       "structured result" path used by dsh-tools's tool wrappers.
  //   (b) next() threw / rejected — the "raw throw" path used by
  //       plugins that `throw Error('…')` directly out of their
  //       execute() body. Both are valid dsh tool-failure idioms and
  //       both must be recorded; (b) was silently dropped before v0.2.21.
  const recordFailure = async (
    exec: unknown,
    errorMessage: string,
    info: { name: string; code: string } | null,
  ): Promise<void> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = exec as { name?: string; sessionId?: string; agent?: { id?: string } | string }
    const toolName = e.name ?? 'unknown'
    const sessionId = e.sessionId ?? null
    const agentId = e.agent
      ? typeof e.agent === 'string'
        ? e.agent
        : (e.agent.id ?? null)
      : null
    const c: ToolErrorContext = { toolName, info, message: errorMessage, sessionId, agentId }
    const userKlass = classifier ? classifier(c) : null
    const klass = (userKlass ?? defaultClassify(c)) as ToolErrorClass
    const p = (policy ?? defaultPolicy)(c, klass)
    const entry: ToolErrorEntry = {
      ts: new Date().toISOString(),
      toolName,
      klass,
      message: errorMessage,
      info,
      sessionId,
      agentId,
      policy: p.defer ? 'deferred' : p.record ? 'recorded' : 'silenced',
    }
    if (p.record) {
      queue.push(entry)
      total++
      if (p.log) {
        await toolErrLog.write(
          'WARN',
          `[${klass}] ${toolName} session=${sessionId ?? '-'} agent=${agentId ?? '-'} ${errorMessage}`,
        )
      }
      await log.debug(`tool error captured: ${toolName} → ${klass} (${entry.policy})`)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const offExecute = (ctx as any).on?.('tools/execute', async (exec: unknown, next: () => Promise<unknown>) => {
    let result: unknown
    let threw = false
    try {
      result = await next()
    } catch (e) {
      // Path (b): next() rejected / threw. Record it, then re-throw so
      // the waterfall upstream still sees the failure.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const err = e as { name?: string; message?: string; code?: string }
      const errorMessage = err?.message ?? String(e)
      const info: { name: string; code: string } | null =
        err && typeof err === 'object' && (err.name !== undefined || err.code !== undefined)
          ? { name: String(err.name ?? ''), code: String(err.code ?? '') }
          : null
      try {
        await recordFailure(exec, errorMessage, info)
      } catch (recErr) {
        // Recording must never mask the original error.
        void log.warn(`tool error capture (throw path) failed: ${(recErr as Error).message}`)
      }
      threw = true
      throw e
    }
    if (threw) return result // unreachable; satisfies the type checker

    // Path (a): next() returned a structured result.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = result
    if (r && typeof r === 'object' && r.isError === true && r.error) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const re: any = r.error
      const info = re.info && typeof re.info === 'object'
        ? { name: String(re.info.name ?? ''), code: String(re.info.code ?? '') }
        : null
      const message = typeof re.message === 'string' ? re.message : String(re)
      await recordFailure(exec, message, info)
    }
    return result
  })

  // Also listen to `tools/post-execute` for a final marker — this fires after
  // the dispatch waterfall settled. We use it only to update the doctor log
  // (no extra work; the result is already in `tools/execute`).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const offPost = (ctx as any).on?.('tools/post-execute', async (_exec: unknown, _result: unknown, next: () => Promise<unknown>) => {
    return next()
  })

  installed = offExecute !== undefined
  if (!installed) {
    // dsh-tools is on a version that does not expose the tools/* events;
    // degrade gracefully — no error, just no capture.
    void log
  }

  return {
    queue,
    total: () => total,
    dispose: () => {
      try { offExecute?.() } catch { /* noop */ }
      try { offPost?.() } catch { /* noop */ }
    },
  }
}

/** Public read-only summary writer for `dsh_doctor_status`. */
export interface ToolErrorSummary {
  transient: number
  agent: number
  business: number
  total: number
  queueSize: number
}

/** Read the latest summary for the `status` tool. */
export function readSummary(capture: ToolErrorCapture, windowMs = 60 * 60 * 1000): ToolErrorSummary {
  const s = capture.queue.summary(windowMs)
  return { ...s, queueSize: capture.queue.summary(Number.POSITIVE_INFINITY).total }
}

/** Make sure the tool-errors log file exists (touch). */
export async function ensureToolErrorLogFile(cfg: ConfigT): Promise<string> {
  await ensureDir(StatePaths.logsDir())
  const file = path.join(StatePaths.logsDir(), 'tool-errors.log')
  try {
    await fs.access(file)
  } catch {
    await fs.writeFile(file, '', { mode: 0o600 })
    void cfg
  }
  return file
}

/** Synchronous variant for paths that must exist before the listener fires. */
function ensureToolErrorLogFileSync(cfg: ConfigT): string {
  try {
    mkdirSync(StatePaths.logsDir(), { recursive: true })
  } catch {
    // ignore
  }
  const file = path.join(StatePaths.logsDir(), 'tool-errors.log')
  try {
    accessSync(file)
  } catch {
    try {
      writeFileSync(file, '', { mode: 0o600 })
    } catch {
      // ignore
    }
  }
  void cfg
  return file
}
