/**
 * Source-of-truth body for the standalone watchdog script.
 *
 * This module exports a string of valid JavaScript that:
 *   - depends only on Node built-ins (no `node_modules` access),
 *   - runs as the main module of a fresh `node` invocation,
 *   - implements the full state machine in docs/ARCHITECTURE.md.
 *
 * The plugin reads this string, prepends a header (version stamp + safety
 * disclaimer), and writes it to `$DSH_HOME/doctor/watchdog.js` at install
 * time. Upgrading the plugin regenerates the script — the *next* watchdog
 * tick picks up the new body. No re-spawn dance.
 *
 * @module dsh-doctor/watchdog.standalone
 */
export declare const WATCHDOG_STANDALONE_BODY: string;
//# sourceMappingURL=watchdog.standalone.d.ts.map