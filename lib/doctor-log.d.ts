/**
 * Rotating log writer. Tiny, sync, dependency-free. Used by the plugin's
 * tools (and could be inlined into the generated watchdog if needed).
 *
 * Format: ISO-8601 timestamp + level + line.
 *
 * @module dsh-doctor/doctor-log
 */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export interface LogOptions {
    file: string;
    maxBytes: number;
    backups: number;
}
/** Synchronous, line-buffered log writer. Each call is a single write. */
export declare class DoctorLog {
    private readonly file;
    private readonly maxBytes;
    private readonly backups;
    constructor(opts: LogOptions);
    write(level: LogLevel, msg: string): Promise<void>;
    debug(msg: string): Promise<void>;
    info(msg: string): Promise<void>;
    warn(msg: string): Promise<void>;
    error(msg: string): Promise<void>;
    private maybeRotate;
}
/** Read the last N lines of a log file, oldest first. */
export declare function tailLog(file: string, n: number): Promise<string[]>;
/** Format a path relative to the home directory for compact logging. */
export declare function relpath(home: string, p: string): string;
//# sourceMappingURL=doctor-log.d.ts.map