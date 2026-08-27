import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildSafeModePatch,
  applySafeModePatch,
  clearSafeModePatch,
  isSafeModeActive,
} from '../src/safe-mode.js'
import { StatePaths } from '../src/state.js'

describe('safe-mode', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-doctor-test-'))
    process.env.DSH_HOME = tmpHome
  })
  afterEach(async () => {
    delete process.env.DSH_HOME
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  it('buildSafeModePatch emits a non-empty, well-formed YAML-ish block', () => {
    const body = buildSafeModePatch(['dsh-core'])
    expect(body).toContain('dsh-doctor safe-mode patch')
    expect(body).toContain('- insert:')
    expect(body).toContain('dsh-core')
  })

  it('buildSafeModePatch handles an empty allow-list with a sentinel row', () => {
    const body = buildSafeModePatch([])
    expect(body).toContain('dsh-doctor-safe-mode-sentinel')
  })

  it('applySafeModePatch writes the file under the doctor home', async () => {
    const p = await applySafeModePatch(['dsh-core', '@scope/dsh-x'])
    expect(p).toBe(StatePaths.safeModePatch())
    const text = await fs.readFile(p, 'utf8')
    expect(text).toContain('@scope/dsh-x')
    expect(await isSafeModeActive()).toBe(true)
  })

  it('clearSafeModePatch removes the file', async () => {
    await applySafeModePatch(['dsh-core'])
    expect(await isSafeModeActive()).toBe(true)
    await clearSafeModePatch()
    expect(await isSafeModeActive()).toBe(false)
  })

  it('clearSafeModePatch is idempotent on a missing file', async () => {
    await expect(clearSafeModePatch()).resolves.toBeUndefined()
  })
})
