/**
 * Auto-install helper — runs as a detached child process to do the
 * actual work of writing the watchdog script and registering the
 * platform service. Exits when done. Never blocks the dsh web boot.
 *
 * @module dsh-doctor/auto-install-helper
 */
import { promises as fs } from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { StatePaths, doctorBase, ensureDir, writeFileAtomic } from './state.js';
import { DoctorLog } from './doctor-log.js';
import { ConfigDefaults } from './config.js';
import { installWatchdogScript } from './watchdog.js';
import { buildServiceSpec, writeServiceSpec, currentPlatform } from './platform.js';
const execFile = promisify(execFileCb);
/**
 * Detect the dsh web platform-service label.
 *
 * Returns the label string (e.g. `io.deepseek.dsh`) if found, or null
 * if no platform service is registered. The watchdog uses this to
 * ask launchd / systemd to relaunch dsh web when needed, instead of
 * spawning a competing process.
 *
 * macOS:  `launchctl list | grep` for `dsh web` / `dsh headless`
 * Linux:  `systemctl --user list-units` for dsh web
 * Win:    `schtasks /Query` for dsh
 */
async function detectDshWebLabel(log) {
    if (process.platform === 'darwin') {
        try {
            const { stdout } = await execFile('launchctl', ['list']);
            for (const line of stdout.split('\n')) {
                // Lines look like:  "80803\t0\tio.deepseek.dsh"
                const parts = line.trim().split(/\s+/);
                const label = parts[parts.length - 1];
                if (label &&
                    (label.startsWith('io.deepseek.') || label.startsWith('com.deepseek.')) &&
                    !label.includes('dsh-doctor')) {
                    return label;
                }
            }
        }
        catch (e) {
            await log.warn(`launchctl list failed: ${e.message}`);
        }
        return null;
    }
    if (process.platform === 'linux') {
        try {
            const { stdout } = await execFile('systemctl', ['--user', 'list-units', '--type=service', '--no-legend']);
            for (const line of stdout.split('\n')) {
                const m = line.match(/(\S+dsh\S*)\.service/);
                if (m && !m[1].includes('doctor'))
                    return m[1];
            }
        }
        catch (e) {
            await log.warn(`systemctl list failed: ${e.message}`);
        }
        return null;
    }
    if (process.platform === 'win32') {
        try {
            const { stdout } = await execFile('schtasks', ['/Query', '/FO', 'LIST']);
            for (const line of stdout.split('\n')) {
                if (/^TaskName:/i.test(line) && /\\dsh\b/i.test(line) && !/doctor/i.test(line)) {
                    const m = line.match(/\\([^\\]+)$/);
                    if (m)
                        return m[1];
                }
            }
        }
        catch (e) {
            await log.warn(`schtasks query failed: ${e.message}`);
        }
        return null;
    }
    return null;
}
async function main() {
    const dshHome = doctorBase();
    const port = Number(process.env.DSH_WEB_PORT) || 3080;
    const nodeBin = process.execPath;
    const log = new DoctorLog({
        file: StatePaths.doctorLog(),
        maxBytes: ConfigDefaults.logMaxBytes,
        backups: ConfigDefaults.logBackups,
    });
    await log.info('auto-install helper started');
    await ensureDir(StatePaths.doctorHome());
    await ensureDir(StatePaths.logsDir());
    // Best-effort: detect the dsh web platform-service label so the
    // watchdog can ask launchd / systemd to relaunch dsh web when it
    // disappears (rather than spawning a competing instance).
    const webLabel = await detectDshWebLabel(log);
    if (webLabel) {
        try {
            const labelPath = path.join(StatePaths.doctorHome(), '.doctor-web-label');
            await fs.writeFile(labelPath, webLabel, { mode: 0o600 });
            await log.info(`dsh web platform label recorded: ${webLabel}`);
        }
        catch (e) {
            await log.warn(`could not record dsh web label: ${e.message}`);
        }
    }
    else {
        await log.info('no dsh web platform label detected; watchdog will fall back to direct spawn');
    }
    try {
        const wdPath = await installWatchdogScript();
        await log.info(`watchdog script written at ${wdPath}`);
    }
    catch (e) {
        await log.warn(`watchdog script write failed: ${e.message}`);
        process.exit(1);
    }
    let spec;
    try {
        spec = await buildServiceSpec({ nodeBin, dshHome, webPort: port });
        await writeServiceSpec(spec);
        await log.info(`service spec written: ${spec.label}`);
    }
    catch (e) {
        await log.warn(`service spec write failed: ${e.message}`);
        process.exit(1);
    }
    for (const cmd of [spec.registerCmd, spec.startCmd]) {
        try {
            await execFile(cmd[0], cmd.slice(1), {
                env: { ...process.env, DSH_HOME: dshHome, DSH_WEB_PORT: String(port) },
            });
            await log.info(`executed: ${cmd.join(' ')}`);
        }
        catch (e) {
            await log.warn(`command failed (continuing): ${cmd.join(' ')}: ${e.message}`);
        }
    }
    await writeFileAtomic(StatePaths.installedMarker(), JSON.stringify({ installedAt: new Date().toISOString(), version: 'auto', platform: currentPlatform() }, null, 2));
    await log.info('auto-install helper done');
    // Give the log a moment to flush before exit.
    await new Promise((r) => setTimeout(r, 200));
    void fs;
}
main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error('auto-install helper crashed:', e);
    process.exit(1);
});
//# sourceMappingURL=auto-install-helper.js.map