/**
 * Filesystem helpers for the `$DSH_HOME/doctor/` state directory.
 *
 * All paths are computed from `$DSH_HOME` (default `~/.dsh`) and the resolved
 * DSH web port. The watchdog uses these helpers at every tick; the plugin's
 * tools use them at install/uninstall time.
 *
 * @module dsh-doctor/state
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
/** Path helpers — exported so the watchdog script and the plugin can agree. */
export const StatePaths = {
    doctorHome() {
        return path.join(doctorBase(), 'doctor');
    },
    configJson() {
        return path.join(doctorBase(), 'doctor', 'config.json');
    },
    watchdogScript() {
        return path.join(doctorBase(), 'doctor', 'watchdog.js');
    },
    /** Pid of the running watchdog. */
    watchdogPid() {
        return path.join(doctorBase(), 'doctor', '.doctor-watchdog.pid');
    },
    /** Presence marker. */
    installedMarker() {
        return path.join(doctorBase(), 'doctor', '.doctor-installed');
    },
    /** User-paused marker. */
    stoppedMarker() {
        return path.join(doctorBase(), 'doctor', '.doctor-stopped');
    },
    /** Restart mutex (TTL 120 s). */
    restartLock() {
        return path.join(doctorBase(), 'doctor', '.doctor-restart.lock');
    },
    /** Last successfully booted profile snapshot. */
    lastKnownGood() {
        return path.join(doctorBase(), 'doctor', 'last-known-good.json');
    },
    /** Generated safe-mode patch. */
    safeModePatch() {
        return path.join(doctorBase(), 'doctor', 'safe-mode.patch.yml');
    },
    logsDir() {
        return path.join(doctorBase(), 'doctor', 'logs');
    },
    watchdogLog() {
        return path.join(doctorBase(), 'doctor', 'logs', 'watchdog.log');
    },
    doctorLog() {
        return path.join(doctorBase(), 'doctor', 'logs', 'doctor.log');
    },
    platformDir() {
        return path.join(doctorBase(), 'doctor', 'platform');
    },
    profilePatchFile() {
        return path.join(doctorBase(), 'profiles', 'web', 'cordis.patch.yml');
    },
    profileDir() {
        return path.join(doctorBase(), 'profiles', 'web');
    },
};
/** Return `$DSH_HOME` (default `~/.dsh`). */
export function doctorBase() {
    return process.env.DSH_HOME && process.env.DSH_HOME.length > 0
        ? process.env.DSH_HOME
        : path.join(os.homedir(), '.dsh');
}
/** Ensure a directory exists (recursive, idempotent). */
export async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
}
/** Read a file, returning `null` if it does not exist. */
export async function readFileOrNull(p) {
    try {
        return await fs.readFile(p, 'utf8');
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return null;
        throw err;
    }
}
/** Write a file atomically: write to `<p>.tmp` then rename. */
export async function writeFileAtomic(p, content) {
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, content, { mode: 0o600 });
    await fs.rename(tmp, p);
}
/** Tail the last N lines of a file. Returns `[]` if the file is missing. */
export async function tailFile(p, maxLines) {
    const content = await readFileOrNull(p);
    if (content === null)
        return [];
    const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
    return lines.slice(Math.max(0, lines.length - maxLines));
}
/** Is a pid alive? Sends signal 0, never throws. */
export function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === 'EPERM';
    }
}
/** Read the DSH web pid from the profile directory, if present. */
export async function readWebPid() {
    const p = path.join(StatePaths.profileDir(), '.dsh-web.pid');
    const content = await readFileOrNull(p);
    if (content === null)
        return null;
    const n = Number(content.trim());
    return Number.isInteger(n) && n > 0 ? n : null;
}
//# sourceMappingURL=state.js.map