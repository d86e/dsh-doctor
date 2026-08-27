/**
 * Triage engine. Given the tail of the dsh web boot log, returns an
 * `ActionPlan` describing the cheapest recovery that is likely to work.
 *
 * The engine is intentionally narrow. New failure modes are added by adding
 * a new `Pattern` entry — see CONTRIBUTING.md.
 *
 * @module dsh-doctor/triage
 */

/** A single pattern that the triage engine can match. */
export interface Pattern {
  /** Unique stable id (e.g. `duplicate-loader-entry`). */
  id: string
  /** Human-readable description for logs and `dsh_doctor_diagnose`. */
  description: string
  /** Regular expression to test against the joined log buffer. */
  regex: RegExp
  /** Higher = matched first. */
  priority: number
  /**
   * Extract the plugin id from a regex match group, or `null` to mean
   * "the whole pattern names a different fix".
   */
  extractId: (match: RegExpMatchArray) => string | null
  /**
   * Build an action plan from the matched pattern. The `id` argument is the
   * plugin id returned by `extractId`, or `null` if not applicable.
   */
  build: (id: string | null) => ActionPlan
}

export type ActionPlan =
  | {
      kind: 'disable-row'
      pluginId: string
      reason: string
      via: 'simple'
    }
  | {
      kind: 'kill-pid-and-restart'
      reason: string
      via: 'simple'
    }
  | {
      kind: 'safe-mode'
      reason: string
      via: 'complex'
    }
  | {
      kind: 'safe-mode'
      reason: 'no-pattern-matched'
      via: 'complex'
    }
  | {
      kind: 'no-op'
      reason: string
      via: 'simple'
    }

/** The full pattern table, ordered by `priority` descending at match time. */
export const PATTERNS: readonly Pattern[] = [
  {
    id: 'eaddrinuse',
    description: 'Port already in use (probably an orphan dsh web pid).',
    regex: /EADDRINUSE.*?(?:127\.0\.0\.1|0\.0\.0\.0|::):(\d+)/,
    priority: 100,
    extractId: () => null,
    build: () => ({
      kind: 'kill-pid-and-restart',
      reason: 'EADDRINUSE — kill recorded pid and restart',
      via: 'simple',
    }),
  },
  {
    id: 'duplicate-loader-entry',
    description: 'duplicate loader entry id (a plugin row is registered twice).',
    regex: /duplicate loader entry id:\s*([A-Za-z0-9_.\-@/]+)/,
    priority: 90,
    extractId: (m) => m[1] ?? null,
    build: (id) => ({
      kind: 'disable-row',
      pluginId: id ?? 'unknown',
      reason: 'duplicate loader entry id',
      via: 'simple',
    }),
  },
  {
    id: 'schema-parse-error',
    description: 'Schema parse error pointing at a plugin package.',
    // Match a scoped package (@scope/...) or a single bareword after the
    // keyword. The character class excludes "in"/"at"/"for" filler words
    // by requiring the package to start with a non-letter or be a bareword
    // preceded by whitespace at a token boundary.
    regex: /Schema (?:parse|validation) error[^\n]*?(?:@([A-Za-z0-9_.\-]+)\/([A-Za-z0-9_.\-]+)|^([A-Za-z][A-Za-z0-9_.\-]{1,})$)/m,
    priority: 80,
    extractId: (m) => {
      if (m[1] && m[2]) return `@${m[1]}/${m[2]}`
      if (m[3]) return m[3]
      return null
    },
    build: (id) => ({
      kind: 'disable-row',
      pluginId: id ?? 'unknown',
      reason: 'schema parse error',
      via: 'simple',
    }),
  },
  {
    id: 'cannot-find-module',
    description: 'Cannot find module (a plugin dependency is missing).',
    regex: /Cannot find module ['"]([^'"]+)['"]/,
    priority: 70,
    extractId: (m) => {
      const spec = m[1] ?? ''
      // Extract a plausible plugin id from a spec like '@scope/name/sub/path'.
      const parts = spec.replace(/^node:/, '').split('/')
      if (spec.startsWith('@') && parts.length >= 2) return `${parts[0]}/${parts[1]}`
      return parts[0] || null
    },
    build: (id) => ({
      kind: 'disable-row',
      pluginId: id ?? 'unknown',
      reason: 'cannot find module',
      via: 'simple',
    }),
  },
  {
    id: 'plugin-load-error',
    description: 'Generic load error that names a plugin id.',
    regex: /(?:Failed to (?:load|apply)|Error (?:loading|applying)) plugin ['"]?([@A-Za-z0-9_.\-/]+)['"]?/,
    priority: 60,
    extractId: (m) => m[1] ?? null,
    build: (id) => ({
      kind: 'disable-row',
      pluginId: id ?? 'unknown',
      reason: 'plugin load error',
      via: 'simple',
    }),
  },
]

/**
 * Run triage against a log buffer. Returns the first matching plan, or
 * a complex-path safe-mode plan if nothing matches.
 */
export function triage(logBuffer: readonly string[]): ActionPlan {
  const joined = logBuffer.join('\n')
  const sorted = [...PATTERNS].sort((a, b) => b.priority - a.priority)
  for (const p of sorted) {
    const m = joined.match(p.regex)
    if (m) {
      const id = p.extractId(m)
      return p.build(id)
    }
  }
  return { kind: 'safe-mode', reason: 'no-pattern-matched', via: 'complex' }
}

/** Diagnostic-only triage. Same engine, with the matched pattern surfaced. */
export interface Diagnosis {
  plan: ActionPlan
  matched: Pattern | null
  reason: string
}

export function diagnose(logBuffer: readonly string[]): Diagnosis {
  const joined = logBuffer.join('\n')
  const sorted = [...PATTERNS].sort((a, b) => b.priority - a.priority)
  for (const p of sorted) {
    const m = joined.match(p.regex)
    if (m) {
      const id = p.extractId(m)
      return { plan: p.build(id), matched: p, reason: p.description }
    }
  }
  return {
    plan: { kind: 'safe-mode', reason: 'no-pattern-matched', via: 'complex' },
    matched: null,
    reason: 'no known pattern matched the log buffer',
  }
}
