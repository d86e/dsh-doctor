/**
 * Watchdog generator. Reads the standalone body, prepends a header with
 * the plugin's version stamp, and writes it to `$DSH_HOME/doctor/watchdog.js`.
 *
 * The generated script is also packaged into `lib/watchdog.standalone.body`
 * for tests that want to validate the *current* body without going through
 * the install path.
 *
 * @module dsh-doctor/watchdog
 */
/** Build the full script body (header + body). */
export declare function buildWatchdogScript(): string;
/** Write the watchdog script to its target path. Returns the path. */
export declare function installWatchdogScript(): Promise<string>;
/** Read the current watchdog script (or `null` if not installed). */
export declare function readWatchdogScript(): Promise<string | null>;
/** Is the watchdog currently installed (script + marker present)? */
export declare function isWatchdogInstalled(): Promise<boolean>;
/** Get the plugin version stamped into the header. */
export declare function pluginVersion(): string;
/** Read the body of the standalone script (for tests). */
export declare function readStandaloneBodyFromDisk(): Promise<string | null>;
/** Helper used by tests to delete the watchdog files without going through uninstall. */
export declare function _testRemoveWatchdogFiles(): Promise<void>;
//# sourceMappingURL=watchdog.d.ts.map