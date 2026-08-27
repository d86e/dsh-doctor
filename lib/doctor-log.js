/**
 * Rotating log writer. Tiny, sync, dependency-free. Used by the plugin's
 * tools (and could be inlined into the generated watchdog if needed).
 *
 * Format: ISO-8601 timestamp + level + line.
 *
 * @module dsh-doctor/doctor-log
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
/** Synchronous, line-buffered log writer. Each call is a single write. */
export class DoctorLog {
    file;
    maxBytes;
    backups;
    constructor(opts) {
        this.file = opts.file;
        this.maxBytes = Math.max(1024, opts.maxBytes);
        this.backups = Math.max(0, opts.backups);
    }
    async write(level, msg) {
        const ts = new Date().toISOString();
        const line = `[${ts}] [${level}] ${msg}\n`;
        await fs.appendFile(this.file, line, { mode: 0o600 });
        await this.maybeRotate();
    }
    debug(msg) {
        return this.write('DEBUG', msg);
    }
    info(msg) {
        return this.write('INFO', msg);
    }
    warn(msg) {
        return this.write('WARN', msg);
    }
    error(msg) {
        return this.write('ERROR', msg);
    }
    async maybeRotate() {
        let stat;
        try {
            stat = await fs.stat(this.file);
        }
        catch {
            return;
        }
        if (stat.size < this.maxBytes)
            return;
        // Rotate: file.log.(backups-1) → delete, …, file.log.1 → file.log.2, file.log → file.log.1
        for (let i = this.backups; i >= 1; i--) {
            const src = i === 1 ? this.file : `${this.file}.${i - 1}`;
            const dst = `${this.file}.${i}`;
            try {
                await fs.rename(src, dst);
            }
            catch (err) {
                if (err.code !== 'ENOENT') {
                    // Best effort — never let rotation failure kill logging.
                }
            }
        }
    }
}
/** Read the last N lines of a log file, oldest first. */
export async function tailLog(file, n) {
    try {
        const text = await fs.readFile(file, 'utf8');
        const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
        return lines.slice(Math.max(0, lines.length - n));
    }
    catch {
        return [];
    }
}
/** Format a path relative to the home directory for compact logging. */
export function relpath(home, p) {
    const rel = path.relative(home, p);
    return rel.startsWith('..') ? p : `~/${rel}`;
}
//# sourceMappingURL=doctor-log.js.map