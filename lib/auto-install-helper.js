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
import { StatePaths, doctorBase, ensureDir, writeFileAtomic } from './state.js';
import { DoctorLog } from './doctor-log.js';
import { ConfigDefaults } from './config.js';
import { installWatchdogScript } from './watchdog.js';
import { buildServiceSpec, writeServiceSpec, currentPlatform } from './platform.js';
const execFile = promisify(execFileCb);
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