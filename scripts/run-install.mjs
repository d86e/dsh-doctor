// One-shot installer — runs the same code path dsh_doctor_install runs.
import { installWatchdogScript } from '../lib/watchdog.js'
import { buildServiceSpec, writeServiceSpec, currentPlatform } from '../lib/platform.js'
import { StatePaths, doctorBase, ensureDir } from '../lib/state.js'
import { promises as fs } from 'node:fs'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'

const execFile = promisify(execFileCb)

async function main() {
  const dshHome = doctorBase()
  const port = Number(process.env.DSH_WEB_PORT) || 3080
  const nodeBin = process.execPath

  console.log(`[install] dshHome=${dshHome} port=${port} node=${nodeBin}`)

  await ensureDir(StatePaths.doctorHome())
  await ensureDir(StatePaths.logsDir())

  // 1. Write the standalone watchdog script
  const wdPath = await installWatchdogScript()
  console.log(`[install] watchdog script: ${wdPath}`)

  // 2. Build + write the platform service spec
  const spec = await buildServiceSpec({ nodeBin, dshHome, webPort: port })
  await writeServiceSpec(spec)
  console.log(`[install] service spec: ${spec.label} -> ${spec.file}`)
  console.log(`[install] platform: ${currentPlatform()}`)

  // 3. Register + start the service
  try {
    await execFile(spec.registerCmd[0], spec.registerCmd.slice(1), {
      env: { ...process.env, DSH_HOME: dshHome, DSH_WEB_PORT: String(port) },
    })
    console.log(`[install] registered ${spec.label}`)
  } catch (e) {
    console.log(`[install] register failed (continuing): ${e.message}`)
  }
  try {
    await execFile(spec.startCmd[0], spec.startCmd.slice(1), {
      env: { ...process.env, DSH_HOME: dshHome, DSH_WEB_PORT: String(port) },
    })
    console.log(`[install] started ${spec.label}`)
  } catch (e) {
    console.log(`[install] start failed (continuing): ${e.message}`)
  }

  // 4. installed-marker
  await fs.writeFile(StatePaths.installedMarker(), JSON.stringify({
    installedAt: new Date().toISOString(),
    version: '0.2.2',
  }, null, 2), { mode: 0o600 })

  console.log('[install] done')
}

main().catch((e) => { console.error(e); process.exit(1) })
