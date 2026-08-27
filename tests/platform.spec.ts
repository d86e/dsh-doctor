import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
