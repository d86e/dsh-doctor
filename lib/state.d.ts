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
/**
 * Write the pid of the running dsh web process. The in-process doctor
 * runs inside dsh web, so `process.pid` IS the web pid: persisting it
 * is what makes the daemon's EADDRINUSE kill-pid-and-restart branch
 * have anything to kill. Stale after dsh web exits — readWebPid's
 * caller treats a dead pid as already-terminated, which is exactly the
 * "dsh web crashed, its pid file is left behind" case the branch
 * exists for.
 */
export declare function writeWebPid(pid: number): Promise<void>;
/** Read the DSH web pid from the profile directory, if present. */
export declare function readWebPid(): Promise<number | null>;
/**
 * Known log files managed by the doctor. Used by `dsh_doctor_recent_log`.
 *
 * `web`     — dsh web's own stdout/stderr (the thing triage reads from)
 * `watchdog` — the standalone watchdog's diagnostic log
 * `doctor`  — the in-process doctor's diagnostic log (captures tool errors, watch events)
 * `tool-errors` — the JSONL-ish log of every classified tool error
 */
export type DoctorLogKind = 'web' | 'watchdog' | 'doctor' | 'tool-errors';
/** Map a log kind to its absolute path. */
export declare function logPath(kind: DoctorLogKind): string;
/** Read the watchdog's last-tick timestamp (epoch ms), or `null`. */
export declare function readLastTickAt(): Promise<number | null>;
/** Absolute path to the watchdog's last-tick marker. */
export declare function lastTickPath(): string;
/**
 * Read the watchdog's start timestamp (epoch ms), or `null`. Written once
 * by the generated script at boot (before the first tick) and removed on
 * clean shutdown / uninstall. Lets `dsh_doctor_status` report a real
 * uptime instead of the historical hard-coded 'unknown (pid alive)'.
 */
export declare function readStartedAt(): Promise<number | null>;
/** Absolute path to the watchdog's start timestamp marker. */
export declare function startedAtPath(): string;
//# sourceMappingURL=state.d.ts.map