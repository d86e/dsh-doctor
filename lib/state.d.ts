/**
 * Filesystem helpers for the `$DSH_HOME/doctor/` state directory.
 *
 * All paths are computed from `$DSH_HOME` (default `~/.dsh`) and the resolved
 * DSH web port. The watchdog uses these helpers at every tick; the plugin's
 * tools use them at install/uninstall time.
 *
 * @module dsh-doctor/state
 */
/** Path helpers — exported so the watchdog script and the plugin can agree. */
export declare const StatePaths: {
    doctorHome(): string;
    configJson(): string;
    watchdogScript(): string;
    /** Pid of the running watchdog. */
    watchdogPid(): string;
    /** Presence marker. */
    installedMarker(): string;
    /** User-paused marker. */
    stoppedMarker(): string;
    /** Restart mutex (TTL 120 s). */
    restartLock(): string;
    /** Last successfully booted profile snapshot. */
    lastKnownGood(): string;
    /** Generated safe-mode patch. */
    safeModePatch(): string;
    logsDir(): string;
    watchdogLog(): string;
    doctorLog(): string;
    platformDir(): string;
    profilePatchFile(): string;
    profileDir(): string;
};
/** Return `$DSH_HOME` (default `~/.dsh`). */
export declare function doctorBase(): string;
/** Ensure a directory exists (recursive, idempotent). */
export declare function ensureDir(dir: string): Promise<void>;
/** Read a file, returning `null` if it does not exist. */
export declare function readFileOrNull(p: string): Promise<string | null>;
/** Write a file atomically: write to `<p>.tmp` then rename. */
export declare function writeFileAtomic(p: string, content: string): Promise<void>;
/** Tail the last N lines of a file. Returns `[]` if the file is missing. */
export declare function tailFile(p: string, maxLines: number): Promise<string[]>;
/** Is a pid alive? Sends signal 0, never throws. */
export declare function pidAlive(pid: number): boolean;
/** Read the DSH web pid from the profile directory, if present. */
export declare function readWebPid(): Promise<number | null>;
//# sourceMappingURL=state.d.ts.map