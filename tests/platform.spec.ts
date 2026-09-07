import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildServiceSpec, writeServiceSpec, currentPlatform } from '../src/platform.js'

describe('buildServiceSpec', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-doctor-test-'))
    process.env.DSH_HOME = tmpHome
  })
  afterEach(async () => {
    delete process.env.DSH_HOME
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  it('reports the current platform', () => {
    const p = currentPlatform()
    expect(['darwin', 'linux', 'win32', 'unknown']).toContain(p)
  })

  it('builds a non-empty spec for the current platform', async () => {
    const p = currentPlatform()
    if (p === 'unknown') {
      // On a platform we don't support, expect a clear error.
      await expect(
        buildServiceSpec({ nodeBin: '/usr/bin/env node', dshHome: tmpHome, webPort: 3080 }),
      ).rejects.toThrow(/unsupported platform/)
      return
    }
    const spec = await buildServiceSpec({ nodeBin: '/usr/bin/env node', dshHome: tmpHome, webPort: 3080 })
    expect(spec.file).toBeTruthy()
    expect(spec.content.length).toBeGreaterThan(0)
    expect(spec.registerCmd.length).toBeGreaterThan(0)
    expect(spec.startCmd.length).toBeGreaterThan(0)
    expect(spec.stopCmd.length).toBeGreaterThan(0)
    expect(spec.unregisterCmd.length).toBeGreaterThan(0)
    // The content must reference the watchdog script path.
    expect(spec.content).toContain('doctor')
    // The content must reference the DSH_HOME and port we passed in.
    expect(spec.content).toContain(tmpHome)
    expect(spec.content).toContain('3080')
  })

  it('writeServiceSpec writes the spec to its declared file', async () => {
    const p = currentPlatform()
    if (p === 'unknown') return
    const spec = await buildServiceSpec({ nodeBin: '/usr/bin/env node', dshHome: tmpHome, webPort: 3080 })
    await writeServiceSpec(spec)
    if (p === 'win32') {
      // Both files should exist.
      const xml = spec.file
      const vbs = spec.file.replace(/DshDoctorTask\.xml$/, 'dsh-doctor.vbs')
      const xmlText = await fs.readFile(xml, 'utf8')
      const vbsText = await fs.readFile(vbs, 'utf8')
      expect(xmlText).toContain('Task')
      expect(vbsText).toContain('WScript.Shell')
    } else {
      const text = await fs.readFile(spec.file, 'utf8')
      expect(text).toBe(spec.content)
    }
  })
})

/**
 * Platform-branched coverage. CI only runs on ubuntu, so the darwin
 * (LaunchAgent plist) and win32 (Task Scheduler xml + VBS) branches of
 * buildServiceSpec are otherwise never exercised by the test suite.
 * Mock process.platform so each branch runs on any host.
 */
describe('buildServiceSpec per platform (mocked)', () => {
  let tmpHome: string
  let origPlatform: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-doctor-plat-'))
    process.env.DSH_HOME = tmpHome
    origPlatform = process.platform
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    Object.defineProperty(process, 'platform', { value: origPlatform, writable: true })
    delete process.env.DSH_HOME
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  const as = (name: string, value: string): void => {
    Object.defineProperty(process, 'platform', { value, writable: true })
  }

  it('darwin: emits a LaunchAgent plist with the right label + lifecycle keys', async () => {
    as('platform', 'darwin')
    const spec = await buildServiceSpec({ nodeBin: '/opt/homebrew/bin/node', dshHome: tmpHome, webPort: 4321 })
    expect(spec.label).toBe('LaunchAgent com.deepseek-ai.dsh-doctor')
    expect(spec.file).toContain('com.deepseek-ai.dsh-doctor.plist')
    expect(spec.content).toContain('<key>Label</key>')
    expect(spec.content).toContain('com.deepseek-ai.dsh-doctor')
    expect(spec.content).toContain('<key>KeepAlive</key>')
    expect(spec.content).toContain('/opt/homebrew/bin/node')
    expect(spec.content).toContain('4321')
    expect(spec.registerCmd[0]).toBe('launchctl')
    expect(spec.registerCmd.join(' ')).toContain('com.deepseek-ai.dsh-doctor')
  })

  it('linux: emits a systemd user unit with ExecStart running the watchdog', async () => {
    as('platform', 'linux')
    const spec = await buildServiceSpec({ nodeBin: '/usr/bin/node', dshHome: tmpHome, webPort: 5432 })
    expect(spec.label).toBe('systemd user unit dsh-doctor.service')
    expect(spec.content).toContain('[Service]')
    expect(spec.content).toContain('ExecStart=')
    expect(spec.content).toContain('/usr/bin/node')
    expect(spec.content).toContain('5432')
    expect(spec.content).toContain('Restart=always')
    expect(spec.content).toContain('RestartSec=')
    expect(spec.content).toContain('WantedBy=default.target')
    expect(spec.startCmd[0]).toBe('systemctl')
    expect(spec.startCmd.join(' ')).toContain('--user')
  })

  it('win32: emits a Task Scheduler XML plus a VBS launcher, split on ---', async () => {
    as('platform', 'win32')
    const spec = await buildServiceSpec({ nodeBin: 'C:\\Program Files\\nodejs\\node.exe', dshHome: 'C:\\Users\\x\\.dsh', webPort: 6543 })
    expect(spec.label).toBe('Task Scheduler DshDoctor (via VBS)')
    // The joined content carries both files, separated by the --- marker
    // that writeServiceSpec uses to re-split them.
    expect(spec.content.split('\n---\n').length).toBe(2)
    const [xml, vbs] = spec.content.split('\n---\n')
    expect(xml).toContain('<Task version="1.4"')
    expect(xml).toContain('dsh-doctor')
    expect(xml).toContain('<Command>wscript.exe</Command>')
    expect(xml).toContain('dsh-doctor.vbs')
    expect(vbs).toContain('WScript.Shell')
    expect(vbs).toContain('node.exe')
    // The VBS must point at the generated watchdog script path.
    // The path separator is host-dependent (StatePaths uses the host's
    // separator), so accept either form here.
    expect(vbs).toMatch(/doctor[/\\]watchdog\.js/)
    for (const cmd of [spec.registerCmd, spec.startCmd, spec.stopCmd, spec.unregisterCmd]) {
      expect(cmd[0]).toBe('cmd')
      expect(cmd.join(' ')).toContain('schtasks')
    }
  })
})
