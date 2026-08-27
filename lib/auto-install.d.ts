/**
 * Auto-install — when the plugin loads, make sure the standalone watchdog
 * and platform service are present. Idempotent. Fire-and-forget on a
 * detached child process so a slow/broken `launchctl` call never blocks
 * the dsh boot.
 *
 * Why this exists: until 0.2.3 the only way to install the watchdog was
 * to call the `dsh_doctor_install` tool from inside an agent session.
 * That was confusing for new users: the tool does not exist until the
 * plugin loads, but the plugin cannot fully protect you until the
 * watchdog is running. A chicken-and-egg.
 *
 * The fix: the plugin's own `apply()` ensures the watchdog is running
 * the first time it loads. If the user explicitly does not want this
 * behaviour (rare), they can set `autoInstall: false` in config or set
 * the env var `DSH_DOCTOR_AUTO_INSTALL=0`.
 *
 * @module dsh-doctor/auto-install
 */
import { DoctorLog } from './doctor-log.js';
import { type Config } from './config.js';
/**
 * Decide whether to (re)install the watchdog. We only re-run if:
 *  - the user did not opt out, AND
 *  - the safe-mode patch is active (the doctor itself is the safest
 *    way to recover; do not block it), OR
 *  - the watchdog script is missing, OR
 *  - the platform service is not registered, OR
 *  - the watchdog is not running.
 *
 * Returns `true` if we kicked off the install helper.
 */
export declare function maybeAutoInstall(log: DoctorLog, cfg?: Config): Promise<boolean>;
//# sourceMappingURL=auto-install.d.ts.map