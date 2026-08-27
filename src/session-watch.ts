/**
 * Session watcher — in-process monitor for live dsh sessions.
 *
 * Subscribes to the `session/event` cordis event that the dsh host fires
 * for every session in the process. Tracks the per-session state and
 * decides when to nudge a stuck session forward.
 *
 * The "stuck" definition (per user requirement): a session has not emitted
 * any new event for `idleThresholdMs` while still in `turn/start`-but-not-
 * `turn/end` state. Default 10 minutes — tuneable in `Config`.
 *
 * The "nudge" action: send a `继续` (continue) user message to the session's
 * live agent through `ctx.agents.get(sessionId).followup()`. This is the
 * same primitive that the community `dsh-auto-continue` plugin uses.
 *
 * **Dependency story**: this module never `require`s a host package
 * (`@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session`). It only reads
 * `ctx.agents` and `ctx.on('session/event', ...)` — both injected by the
 * dsh host runtime into the cordis context. If those aren't available the
 * `installSessionWatch` call degrades to a no-op and logs.
 *
 * @module dsh-doctor/session-watch
 */

import type { Context } from '@deepseek-ai/cordis'
import { StatePaths } from './state.js'
import { DoctorLog } from './doctor-log.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Type contracts — minimal, duck-typed, deliberately independent of dsh-* host
// packages. We never `require()` them. The plugin's devDeps are not declared
// for these types; the dsh host runtime is expected to provide them at
// load time via the cordis context.
// ---------------------------------------------------------------------------

/** Subset of `Agent` we use. */
export interface DshAgent {
  followup(message: unknown): void
  cancel(source: { kind: 'user' | 'system' }, opts?: { keepInbox?: boolean }): void
  // Many dsh-agent builds expose a turn-state accessor; we treat it as
  // optional and ignore it if missing.
  status?(): string
}

/** Subset of the `agents` service exposed by the dsh host. */
export interface DshAgentsService {
  get(sessionId: string): DshAgent | undefined
  list(): DshAgent[]
}

/** A `UserMessage` is what `agent.followup` accepts. The dsh host only
 *  requires that the shape be JSON-serialisable; we type the minimum. */
export interface DshUserMessage {
  content: Array<{ type: 'text'; text: string }>
  source: { kind: 'user' | 'system' }
}

/** Subset of `Session`. The host passes a richer object; we only read `id`. */
export interface DshSession {
  id: string
  title?: string
  // anything else is ignored
}

/** Subset of `SessionEvent` discriminated union. The host passes the full
 *  union; we only inspect the cases we care about. */
export type DshSessionEvent =
  | { type: 'turn/start'; data?: Record<string, unknown> }
  | {
      type: 'turn/end'
      data: {
        reason:
          | { kind: 'completed' }
          | { kind: 'aborted' }
          | { kind: 'blocked' }
          | { kind: 'interrupted' }
          | { kind: 'error'; error: { code?: string; message?: string; status?: number } }
          | { kind: 'max-tokens' }
        turn?: number
      }
    }
  | { type: 'tool/call'; data: { name: string; arguments?: unknown } }
  | { type: 'tool/result'; data: Record<string, unknown> }
  | { type: 'assistant/message'; data: { message: { content?: Array<{ type: string; text?: string }> } } }
  | { type: 'user/message'; data: { source: { kind: string }; content?: Array<{ type: string; text?: string }> } }
  | { type: string; data?: Record<string, unknown> }

export interface WatchConfig {
  /** Master switch. */
  watchEnabled: boolean
  /** No new event for this long → candidate for a nudge. */
  idleThresholdMs: number
  /** Don't nudge the same session more often than this. */
  nudgeCooldownMs: number
  /** Nudge at most this many times per session before giving up. */
  maxNudgesPerSession: number
  /** Text to send (supports `{elapsed}`, `{turn}` placeholders). */
  continueText: string
  /** Tick interval for the idle check. */
  tickIntervalMs: number
}

export const DEFAULT_WATCH_CONFIG: WatchConfig = {
  watchEnabled: true,
  idleThresholdMs: 10 * 60 * 1000, // 10 minutes
  nudgeCooldownMs: 5 * 60 * 1000, // 5 minutes between nudges
  maxNudgesPerSession: 3,
  continueText: '继续',
  tickIntervalMs: 30_000, // check every 30 s
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// We deliberately do NOT augment `@deepseek-ai/cordis`'s `Context` or
// `Events` interfaces here. dsh-tools's vendored cordis may already
// declare these properties (e.g. `agents: AgentRegistry`) and merging
// produces incompatible-modifier errors. At runtime we duck-type the
// access (`(ctx as any).agents`, `(ctx as any).on('session/event', ...)`)
// so no static augmentation is needed.
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Per-session state machine
// ---------------------------------------------------------------------------

export interface SessionState {
  sessionId: string
  title: string | null
  /** Last time *any* session event arrived. */
  lastEventAt: number
  /** Set between turn/start and turn/end. */
  turnRunning: boolean
  /** Last turn number seen. */
  lastTurn: number | null
  /** Last failure facts (if the previous turn ended in error). */
  lastFailure: { code: string; message: string; status?: number } | null
  /** How many times we've nudged this session. */
  nudgesSent: number
  /** When the last nudge was sent. */
  lastNudgeAt: number
  /** When the last `user/message` was sent by *us* (echo guard). */
  lastAutoMessageAt: number
  /** When the last *manual* user message arrived (resets nudge counter). */
  lastManualUserAt: number
}

const emptyState = (sessionId: string): SessionState => ({
  sessionId,
  title: null,
  lastEventAt: Date.now(),
  turnRunning: false,
  lastTurn: null,
  lastFailure: null,
  nudgesSent: 0,
  lastNudgeAt: 0,
  lastAutoMessageAt: 0,
  lastManualUserAt: 0,
})

// ---------------------------------------------------------------------------
// Returned handle
// ---------------------------------------------------------------------------

export interface SessionWatch {
  /** Snapshot of every tracked session. */
  list(): SessionState[]
  /** One session, or undefined. */
  get(sessionId: string): SessionState | undefined
  /** Manually send a `继续` (or custom) message to one session. */
  nudge(sessionId: string, text?: string): { ok: boolean; reason?: string }
  /** Cancel the current turn on one session. */
  cancel(sessionId: string): { ok: boolean; reason?: string }
  /** Stop the watcher and clear the tick timer. */
  dispose(): void
  /** Whether the host exposed the dependencies we need. */
  isActive: boolean
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Install the session watcher. Returns a handle; `isActive` is false if
 * the dsh host did not provide the `agents` service or the
 * `session/event` event — in which case the handle is a no-op and the
 * plugin still works (the other 9 tools + the watchdog are unaffected).
 */
export function installSessionWatch(
  ctx: Context,
  cfg: WatchConfig,
  log: DoctorLog,
): SessionWatch {
  const agents = (ctx as any).agents as DshAgentsService | undefined
  const hasAgents = agents !== undefined && typeof agents.get === 'function'
  if (!hasAgents) {
    void log.warn(
      'session watch disabled: ctx.agents is not available in this host. ' +
        'dsh-doctor will observe tool errors but cannot nudge live sessions.',
    ).catch(() => { /* swallow */ })
    return { list: () => [], get: () => undefined, nudge: () => ({ ok: false, reason: 'agents-unavailable' }), cancel: () => ({ ok: false, reason: 'agents-unavailable' }), dispose: () => {}, isActive: false }
  }
  if (!cfg.watchEnabled) {
    return { list: () => [], get: () => undefined, nudge: () => ({ ok: false, reason: 'watch-disabled' }), cancel: () => ({ ok: false, reason: 'watch-disabled' }), dispose: () => {}, isActive: false }
  }

  const states = new Map<string, SessionState>()

  // ---- event subscription ----
  const offEvent = (ctx as any).on?.('session/event', (session: DshSession, event: DshSessionEvent) => {
    if (!session?.id) return
    const s = states.get(session.id) ?? emptyState(session.id)
    s.lastEventAt = Date.now()
    if (session.title && s.title === null) s.title = session.title

    // The host may pass a richer event than the union below (newer dsh
    // versions add cases). We treat it as `any` inside the switch so the
    // access pattern matches the dsh-auto-continue reference.
    const ev = event as any
    switch (ev.type) {
      case 'turn/start':
        s.turnRunning = true
        if (typeof ev.data?.turn === 'number') s.lastTurn = ev.data.turn
        break
      case 'turn/end': {
        s.turnRunning = false
        const reason = ev.data?.reason
        if (reason?.kind === 'error') {
          s.lastFailure = {
            code: reason.error?.code ?? 'UNKNOWN',
            message: reason.error?.message ?? '',
            ...(typeof reason.error?.status === 'number' ? { status: reason.error.status } : {}),
          }
        } else if (reason?.kind === 'completed') {
          s.lastFailure = null
          s.nudgesSent = 0 // success resets the nudge counter
        }
        if (typeof ev.data?.turn === 'number') s.lastTurn = ev.data.turn
        break
      }
      case 'user/message': {
        const src = ev.data?.source?.kind
        if (src === 'user') {
          // Manual user message → reset the nudge counter (user took over).
          s.lastManualUserAt = Date.now()
          s.nudgesSent = 0
        } else if (src === 'system' || src === 'auto') {
          s.lastAutoMessageAt = Date.now()
        }
        break
      }
      default:
        break
    }
    states.set(session.id, s)
  })

  // ---- idle tick ----
  const tickHandle = setInterval(() => {
    void runIdleCheck()
  }, cfg.tickIntervalMs)
  // Allow the Node process to exit if the watcher is the only thing left.
  if (typeof (tickHandle as { unref?: () => void }).unref === 'function') {
    (tickHandle as { unref: () => void }).unref()
  }

  const runIdleCheck = async (): Promise<void> => {
    const now = Date.now()
    for (const s of states.values()) {
      // Skip if not running, or recently active, or already nudged recently,
      // or already at the per-session cap.
      if (!s.turnRunning) continue
      if (now - s.lastEventAt < cfg.idleThresholdMs) continue
      if (s.nudgesSent >= cfg.maxNudgesPerSession) continue
      if (s.lastNudgeAt > 0 && now - s.lastNudgeAt < cfg.nudgeCooldownMs) continue
      // Skip if a manual user message arrived after the last event (user
      // is currently driving — don't clobber their input).
      if (s.lastManualUserAt > s.lastEventAt - 5_000) continue

      const text = fillTemplate(cfg.continueText, {
        elapsed: now - s.lastEventAt,
        turn: s.lastTurn ?? '?',
        sessionId: s.sessionId,
      })
      const result = doNudge(s.sessionId, text)
      if (result.ok) {
        s.nudgesSent += 1
        s.lastNudgeAt = now
        s.lastAutoMessageAt = now
        await log.info(
          `session watch: nudged ${s.sessionId} (idle ${Math.round((now - s.lastEventAt) / 1000)}s, ` +
            `nudge ${s.nudgesSent}/${cfg.maxNudgesPerSession}, text="${text}")`,
        ).catch(() => { /* swallow */ })
      } else {
        await log.warn(`session watch: nudge failed for ${s.sessionId}: ${result.reason}`).catch(() => { /* swallow */ })
      }
    }
  }

  const doNudge = (sessionId: string, text: string): { ok: boolean; reason?: string } => {
    if (!agents) return { ok: false, reason: 'agents-unavailable' }
    const a = agents.get(sessionId)
    if (!a) return { ok: false, reason: 'no-live-agent' }
    const message: DshUserMessage = {
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }
    try {
      a.followup(message)
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  }

  const doCancel = (sessionId: string): { ok: boolean; reason?: string } => {
    if (!agents) return { ok: false, reason: 'agents-unavailable' }
    const a = agents.get(sessionId)
    if (!a) return { ok: false, reason: 'no-live-agent' }
    try {
      a.cancel({ kind: 'user' }, { keepInbox: true })
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  }

  void log.info(
    `session watch active (idle ${Math.round(cfg.idleThresholdMs / 1000)}s, ` +
      `cooldown ${Math.round(cfg.nudgeCooldownMs / 1000)}s, cap ${cfg.maxNudgesPerSession})`,
  ).catch(() => { /* swallow on dispose */ })

  // Suppress unused-variable warnings for fields reserved for future use.
  void StatePaths

  return {
    list: () => Array.from(states.values()),
    get: (id) => states.get(id),
    nudge: doNudge,
    cancel: doCancel,
    dispose: () => {
      clearInterval(tickHandle)
      try { offEvent?.() } catch { /* noop */ }
    },
    isActive: true,
  }
}

/** Tiny placeholder template engine — supports `{elapsed}`, `{turn}`,
 *  `{sessionId}`. Exported for testability. */
export function fillTemplate(
  template: string,
  vars: { elapsed?: number; turn?: number | string; sessionId?: string },
): string {
  return template
    .replaceAll('{elapsed}', vars.elapsed !== undefined ? `${Math.round(vars.elapsed / 1000)}s` : '?')
    .replaceAll('{turn}', vars.turn !== undefined ? String(vars.turn) : '?')
    .replaceAll('{sessionId}', vars.sessionId ?? '?')
}
