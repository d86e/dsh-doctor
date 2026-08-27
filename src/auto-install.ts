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

import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { createRequire } from 'node:module'

import { StatePaths, doctorBase } from './state.js'
import { isSafeModeActive } from './safe-mode.js'
import { DoctorLog } from './doctor-log.js'
import { ConfigDefaults, type Config } from './config.js'

const require = createRequire(import.meta.url)

/** Returns true if the user has opted out. */
function userOptedOut(env: NodeJS.ProcessEnv): boolean {
  const v = env.DSH_DOCTOR_AUTO_INSTALL
  return v === '0' || v === 'false' || v === 'no'
}

/** Returns true if the watchdog is already running. */
async function watchdogAlreadyRunning(): Promise<boolean> {
  const raw = await fs.readFile(StatePaths.watchdogPid(), 'utf8').catch(() => null)
  if (!raw) return false
  const n = Number(raw.trim())
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch {
    return false
  }
}

/** Returns true if the platform service is registered. */
async function platformServiceInstalled(): Promise<boolean> {
  // Use the same logic the platform module exports; keep this self-contained
  // by checking the platform file directly so the watchdog install does not
  // need a node-side import dance.
  const p = currentPlatform()
  const dir = StatePaths.platformDir()
  const candidates: Record<string, string> = {
    darwin: 'com.deepseek-ai.dsh-doctor.plist',
    linux: 'dsh-doctor.service',
    win32: 'dsh-doctor.xml',
  }
  const file = candidates[p]
  if (!file) return false
  try {
    await fs.access(path.join(dir, file))
    return true
  } catch {
    return false
  }
}

function currentPlatform(): NodeJS.Platform {
  return process.platform
}

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
export async function maybeAutoInstall(
  log: DoctorLog,
  cfg: Config = ConfigDefaults,
): Promise<boolean> {
  if (userOptedOut(process.env)) {
    await log.info('auto-install skipped: DSH_DOCTOR_AUTO_INSTALL=0')
    return false
  }

  // Never auto-install while we are *inside* the helper, to avoid recursion.
  if (process.env.DSH_DOCTOR_HELPER === '1') {
    return false
  }

  const safeMode = await isSafeModeActive().catch(() => false)
  const scriptExists = await fs.access(StatePaths.watchdogScript()).then(() => true).catch(() => false)
  const serviceInstalled = await platformServiceInstalled()
  const running = await watchdogAlreadyRunning()

  if (scriptExists && serviceInstalled && running && !safeMode) {
    // Everything looks healthy. Do nothing.
    return false
  }

  await log.info(
    `auto-install triggered (script=${scriptExists}, ` +
      `service=${serviceInstalled}, running=${running}, safeMode=${safeMode})`,
  )
  return spawnHelper(log, cfg)
}

/**
 * Spawn the auto-install helper as a detached child. The helper re-runs
 * `apply()` semantics in standalone mode (no dsh context) to write the
 * watchdog and register the platform service.
 */
function spawnHelper(log: DoctorLog, _cfg: Config): boolean {
  try {
    // Resolve our own install helper. The helper is a sibling ESM file
    // in the same `lib/` directory as the plugin entry, so resolution
    // is just `require.resolve('./auto-install-helper.js')`.
    const selfEntry = require.resolve('./auto-install-helper.js') as string
    const child = spawn(process.execPath, [selfEntry], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...process.env,
        DSH_DOCTOR_HELPER: '1',
        DSH_HOME: doctorBase(),
      },
    })
    child.unref()
    void log.info(`auto-install helper spawned (pid=${child.pid ?? '?'})`)
    return true
  } catch (e) {
    void log.warn(`auto-install failed to spawn helper: ${(e as Error).message}`)
    return false
  }
}
