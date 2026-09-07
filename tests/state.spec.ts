import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  doctorBase,
  ensureDir,
  readFileOrNull,
  writeFileAtomic,
  tailFile,
  pidAlive,
  readWebPid,
  readLastTickAt,
  lastTickPath,
  logPath,
  StatePaths,
} from '../src/state.js'

describe('state helpers', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-doctor-test-'))
    process.env.DSH_HOME = tmpHome
  })
  afterEach(async () => {
    delete process.env.DSH_HOME
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  it('doctorBase respects DSH_HOME', () => {
    expect(doctorBase()).toBe(tmpHome)
  })

  it('ensureDir is idempotent', async () => {
    await ensureDir(path.join(tmpHome, 'a', 'b', 'c'))
    await ensureDir(path.join(tmpHome, 'a', 'b', 'c'))
    const st = await fs.stat(path.join(tmpHome, 'a', 'b', 'c'))
    expect(st.isDirectory()).toBe(true)
  })

  it('readFileOrNull returns null for missing files', async () => {
    expect(await readFileOrNull(path.join(tmpHome, 'missing'))).toBeNull()
  })

  it('writeFileAtomic + readFileOrNull round-trips', async () => {
    const p = path.join(tmpHome, 'x.txt')
    await writeFileAtomic(p, 'hello\n')
    expect(await readFileOrNull(p)).toBe('hello\n')
  })

  it('writeFileAtomic does not leave .tmp files behind on success', async () => {
    const p = path.join(tmpHome, 'y.txt')
    await writeFileAtomic(p, 'world\n')
    const entries = await fs.readdir(tmpHome)
    expect(entries.some((e) => e.includes('.tmp'))).toBe(false)
  })

  it('tailFile returns the last N lines', async () => {
    const p = path.join(tmpHome, 'log.txt')
    await fs.writeFile(p, 'a\nb\nc\nd\ne\n')
    expect(await tailFile(p, 2)).toEqual(['d', 'e'])
  })

  it('tailFile returns [] for a missing file', async () => {
    expect(await tailFile(path.join(tmpHome, 'nope'), 10)).toEqual([])
  })

  it('pidAlive detects the current process', () => {
    expect(pidAlive(process.pid)).toBe(true)
  })

  it('pidAlive returns false for invalid pids', () => {
    expect(pidAlive(0)).toBe(false)
    expect(pidAlive(-1)).toBe(false)
    expect(pidAlive(999_999_999)).toBe(false)
  })

  it('readWebPid returns null when the file is missing', async () => {
    expect(await readWebPid()).toBeNull()
  })

  it('readWebPid returns a number when the file is present', async () => {
    const p = path.join(StatePaths.profileDir(), '.dsh-web.pid')
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, '1234\n')
    expect(await readWebPid()).toBe(1234)
  })

  it('logPath maps each kind to the right doctor-managed file', () => {
    expect(logPath('web')).toBe(path.join(tmpHome, 'doctor', 'logs', 'dsh-web.log'))
    expect(logPath('watchdog')).toBe(StatePaths.watchdogLog())
    expect(logPath('doctor')).toBe(StatePaths.doctorLog())
    expect(logPath('tool-errors')).toBe(path.join(tmpHome, 'doctor', 'logs', 'tool-errors.log'))
  })

  it('readLastTickAt returns null when the marker is missing', async () => {
    expect(await readLastTickAt()).toBeNull()
  })

  it('readLastTickAt round-trips an epoch-ms stamp written by the watchdog', async () => {
    await ensureDir(path.dirname(lastTickPath()))
    const stamp = Date.now() - 42_000
    await fs.writeFile(lastTickPath(), String(stamp) + '\n')
    expect(await readLastTickAt()).toBe(stamp)
  })

  it('readLastTickAt ignores garbage contents', async () => {
    await ensureDir(path.dirname(lastTickPath()))
    await fs.writeFile(lastTickPath(), 'not-a-number\n')
    expect(await readLastTickAt()).toBeNull()
  })
})
