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
    id: string;
    /** Human-readable description for logs and `dsh_doctor_diagnose`. */
    description: string;
    /** Regular expression to test against the joined log buffer. */
    regex: RegExp;
    /** Higher = matched first. */
    priority: number;
    /**
     * Extract the plugin id from a regex match group, or `null` to mean
     * "the whole pattern names a different fix".
     */
    extractId: (match: RegExpMatchArray) => string | null;
    /**
     * Build an action plan from the matched pattern. The `id` argument is the
     * plugin id returned by `extractId`, or `null` if not applicable. The
     * `match` argument is the full RegExpMatchArray so build can also pull
     * non-id tokens (e.g. a Node version string).
     */
    build: (id: string | null, match?: RegExpMatchArray) => ActionPlan;
}
export type ActionPlan = {
    kind: 'disable-row';
    pluginId: string;
    reason: string;
    via: 'simple';
} | {
    kind: 'kill-pid-and-restart';
    reason: string;
    via: 'simple';
} | {
    kind: 'safe-mode';
    reason: string;
    via: 'complex';
} | {
    kind: 'safe-mode';
    reason: 'no-pattern-matched';
    via: 'complex';
} | {
    kind: 'no-op';
    reason: string;
    via: 'simple';
} | {
    /**
     * User error — the doctor cannot fix this. Surface to the human.
     * Examples: Node version too old, disk full, missing binary.
     * The doctor writes a clear log line and stages no patch; the
     * human is the only path to recovery.
     */
    kind: 'notify-user';
    reason: string;
    via: 'complex';
} | {
    /**
     * Cleanup some local state (old logs, stale marker files) and
     * let the platform service restart dsh web. Used when the log
     * shows the failure is environmental, not plugin-induced.
     */
    kind: 'cleanup-and-restart';
    reason: string;
    via: 'complex';
};
/** The full pattern table, ordered by `priority` descending at match time. */
export declare const PATTERNS: readonly Pattern[];
/**
 * Run triage against a log buffer. Returns the first matching plan, or
 * a complex-path safe-mode plan if nothing matches.
 */
export declare function triage(logBuffer: readonly string[]): ActionPlan;
/** Diagnostic-only triage. Same engine, with the matched pattern surfaced. */
export interface Diagnosis {
    plan: ActionPlan;
    matched: Pattern | null;
    reason: string;
}
export declare function diagnose(logBuffer: readonly string[]): Diagnosis;
//# sourceMappingURL=triage.d.ts.map