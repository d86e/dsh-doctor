import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  WATCHDOG_STANDALONE_BODY,
} from '../src/watchdog.standalone.js'
import { pluginVersion } from '../src/watchdog.js'

describe('watchdog standalone body', () => {
  it('starts with a use-strict directive', () => {
    expect(WATCHDOG_STANDALONE_BODY.trimStart().startsWith("'use strict'")).toBe(true)
  })

  it('does not require any external modules', () => {
    // No `require('npm-package')` or `import 'npm-package'`.
    expect(WATCHDOG_STANDALONE_BODY).not.toMatch(/require\(['"]@/)
    expect(WATCHDOG_STANDALONE_BODY).not.toMatch(/from\s+['"]@/)
    // Only Node built-ins should appear as `require('node:...')` or `require('fs')` etc.
    const requires = [...WATCHDOG_STANDALONE_BODY.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
    for (const r of requires) {
      const builtin = ['fs', 'path', 'os', 'http', 'net', 'child_process', 'crypto', 'node:fs', 'node:path', 'node:os', 'node:http', 'node:net', 'node:child_process', 'node:crypto']
      expect(builtin).toContain(r)
    }
  })

  it('contains the required state-machine primitives', () => {
    for (const sym of [
      'function probe',
      'function triage',
      'function killWeb',
      'function startWeb',
      'function activateSafeMode',
      'function clearSafeMode',
      'function stageDisableRow',
      'function loadConfig',
      'singleInstance',
      'recoveryBudgetMs',
      'healthFailuresToRecover',
    ]) {
      expect(WATCHDOG_STANDALONE_BODY).toContain(sym)
    }
  })

  it('does not call pkill or killall', () => {
    expect(WATCHDOG_STANDALONE_BODY).not.toMatch(/pkill|killall/)
  })

  it('does not unref the main-loop tick timer (regression: v0.2.4 self-exit)', () => {
    // Regression for the v0.2.4 self-exit bug. `.unref()` on the tick
    // setTimeout left the event loop with no ref'd handle during the
    // 30 s gap between probes, so Node exited cleanly and launchd's
    // KeepAlive re-spawned the watchdog in a tight loop.
    expect(WATCHDOG_STANDALONE_BODY).not.toMatch(
      /setTimeout\(loop,\s*CFG\.healthIntervalMs\)\.unref\(\)/,
    )
    expect(WATCHDOG_STANDALONE_BODY).not.toMatch(
      /setTimeout\(loop,\s*5000\)\.unref\(\)/,
    )
  })

  it('schedules the next tick via finally (regression: v0.2.6 loop death)', () => {
    // Regression for the v0.2.6 loop-death bug observed live on macOS:
    // tick().catch(...).then(setTimeout) silently stopped scheduling new
    // ticks when tick() returned a never-resolving promise (5 minutes of
    // 0% CPU on PID 71994). The fix wraps setTimeout in `.finally` so
    // the next tick is scheduled even when tick() throws synchronously
    // or returns a hanging promise. We use [\s\S] to match across the
    // multi-line arrow body.
    expect(WATCHDOG_STANDALONE_BODY).toMatch(/\.finally\(\s*\(\)\s*=>\s*setTimeout\(run/)
  })

  it('every inline triage pattern really matches its log line (cooked-body regression)', () => {
    // Regression v0.2.22: the body was a `String\`...\`` tagged template,
    // which ESCAPE-COOKS its contents — \s became s, \d became d, \.
    // became . — so the generated watchdog's triage regexes were broken
    // even though the whole body still parsed. Five of the twelve
    // patterns silently fell through to safe-mode. We run the COOKED
    // body's own triage() against one realistic log line per pattern:
    // if cooking ever breaks again, one of these will fail.
    // eslint-disable-next-line no-new-func
    const start = WATCHDOG_STANDALONE_BODY.indexOf('const PATTERNS')
    const end = WATCHDOG_STANDALONE_BODY.indexOf('function probe()')
    if (start < 0 || end < 0) throw new Error('PATTERNS section not found in body')
    const mod = { exports: {} as Record<string, unknown> }
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', WATCHDOG_STANDALONE_BODY.slice(start, end) + '\nmodule.exports = { PATTERNS, triage };')(mod, mod.exports)
    const triage = mod.exports.triage as (lines: string[]) => { kind: string; id?: string; matched: string | null }

    const fixtures: Array<[string, string, string, string | null]> = [
      ['EADDRINUSE', 'Error: listen EADDRINUSE: address already in use 127.0.0.1:3080', 'kill-pid-and-restart', null],
      ['duplicate-loader', 'duplicate loader entry id: dsh-foo-bar', 'disable-row', 'dsh-foo-bar'],
      ['schema-parse', 'Schema parse error in @scope/bad-pkg: invalid value for field x', 'disable-row', '@scope/bad-pkg'],
      ['cannot-find-module', "Error: Cannot find module 'some-pkg'", 'disable-row', 'some-pkg'],
      ['plugin-load-error', 'Error loading plugin @scope/dsh-broken', 'disable-row', '@scope/dsh-broken'],
      ['node-version', 'Requires Node ^20.0.0 but dsh ships v18.19.0', 'notify-user', null],
      ['disk-full', 'ENOSPC: no space left on device', 'notify-user', null],
      ['corrupt-patch-yaml', 'YAML parse error in cordis.patch.yml: unexpected token', 'cleanup-and-restart', null],
      ['cordis-schema-validate', "Cannot read properties of undefined (reading 'validate')", 'safe-mode', null],
      ['pnpm-peer', 'ERESOLVE could not resolve: @scope/dsh-conflict@1.0.0 peer dep conflict', 'disable-row', '@scope/dsh-conflict'],
      ['plugin-export-missing', 'Plugin dsh-x did not export name and apply', 'disable-row', 'dsh-x'],
      ['plugin-file-missing', "ENOENT: no such file, open '/Users/x/node_modules/@scope/dsh-missing/lib/index.js'", 'disable-row', '@scope/dsh-missing'],
      ['no-match', 'some completely unknown failure text', 'safe-mode', null],
    ]
    for (const [label, input, expectedKind, expectedId] of fixtures) {
      let plan: { kind: string; id?: string; matched: string | null } | null = null
      let err: Error | null = null
      try { plan = triage([input]) } catch (e) { err = e as Error }
      expect(err, label + ' threw').toBeNull()
      expect(plan!.kind, label + ': kind').toBe(expectedKind)
      if (expectedId !== null) expect(plan!.id, label + ': id').toBe(expectedId)
    }
  })

  it('stamps the last-tick marker on every tick (for dsh_doctor_status liveness)', () => {
    // The status tool reads `.doctor-last-tick` to answer "is the
    // watchdog alive AND actually ticking?" — a live pid alone is not
    // enough (a wedged watchdog still has a pid).
    expect(WATCHDOG_STANDALONE_BODY).toMatch(/\.doctor-last-tick/)
    expect(WATCHDOG_STANDALONE_BODY).toMatch(/fs\.writeFileSync\(LAST_TICK, String\(Date\.now\(\)\)\)/)
    // And cleanup() removes it on exit so a stopped watchdog does not
    // leave a stale liveness stamp behind.
    expect(WATCHDOG_STANDALONE_BODY).toMatch(/fs\.unlinkSync\(LAST_TICK\)/)
  })

  it('emits a heartbeat line every N ticks when healthy', () => {
    // Without the heartbeat, a healthy watchdog is invisible in the log
    // (it only writes on failure / recovery). The heartbeat makes the
    // operator's "is the watchdog still alive?" question trivial.
    expect(WATCHDOG_STANDALONE_BODY).toMatch(/heartbeat/)
    expect(WATCHDOG_STANDALONE_BODY).toMatch(/HEARTBEAT_EVERY_N_TICKS/)
  })

  it('still unrefs the spawned dsh web child process', () => {
    // The spawned dsh web subprocess should be detached from the
    // watchdog's event loop via `child.unref()`. This is the one
    // `.unref()` call that must stay.
    expect(WATCHDOG_STANDALONE_BODY).toMatch(/child\.unref\(\)/)
  })

  it('exposes a plugin version stamp at runtime', () => {
    // The version helper is sourced from the *plugin* package.json; the body
    // itself is a string and the stamp is injected by `buildWatchdogScript()`.
    expect(pluginVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('uses a streaming tail instead of reading the whole log file', () => {
    // Regression: prior versions did `fs.readFileSync(webLog, 'utf8')`
    // and split — a 500 MB dsh-web.log would block the watchdog tick
    // for many seconds and risk OOM. The fix adds a `tailFileByLines`
    // helper that reads 64 KiB chunks from the end. We only check that
    // the helper is present; its behaviour is covered by the triage tail
    // unit tests.
    expect(WATCHDOG_STANDALONE_BODY).toMatch(/function tailFileByLines\(/)
    expect(WATCHDOG_STANDALONE_BODY).toMatch(/fs\.readSync\(fd, buf/)
    expect(WATCHDOG_STANDALONE_BODY).toMatch(/triageLogLines/)
  })
})

describe('generated script', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-doctor-test-'))
    process.env.DSH_HOME = tmpHome
  })
  afterEach(async () => {
    delete process.env.DSH_HOME
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  it('installWatchdogScript writes a parseable, self-contained JS file', async () => {
    const { installWatchdogScript } = await import('../src/watchdog.js')
    const p = await installWatchdogScript()
    expect(p).toBeTruthy()
    const text = await fs.readFile(p, 'utf8')
    // The header is in the actual file, the body follows.
    expect(text).toMatch(/auto-generated by @d86e\/dsh-doctor v\d+\.\d+\.\d+/)
    expect(text).toContain("'use strict'")
    // Smoke: parse it with `new Function` to ensure no syntax error. This
    // does not execute the body, so it's safe to run in tests.
    // eslint-disable-next-line no-new-func
    expect(() => new Function(text)).not.toThrow()
  })

  it('stageDisableRow prunes the matching row from cordis.patch.yml (functional)', async () => {
    // Regression v0.2.22: pre-fix, the "simple path" only wrote a sibling
    // marker file (cordis.patch.yml.doctor-disabled-<id>) that NOTHING
    // consumed — dsh web booted the un-pruned patch, the broken row still
    // mounted, and the incident re-tripped until safe-mode took over. Now
    // the broken row must actually be removed from the patch itself.
    const profileDir = path.join(tmpHome, 'profiles', 'web')
    await fs.mkdir(profileDir, { recursive: true })
    const patchFile = path.join(profileDir, 'cordis.patch.yml')
    const original = [
      '- insert:',
      '    - id: dsh-core',
      '      name: dsh-core',
      '      config: {keep: true}',
      '    - id: dsh-broken',
      '      name: dsh-broken',
      '      config: {safeMode: false}',
      '',
    ].join('\n')
    await fs.writeFile(patchFile, original)

    // Run the standalone body in a sandbox (env DSH_HOME points at
    // tmpHome, so the body's PATCH_F resolves to the file above).
    // eslint-disable-next-line no-new-func
    const sandbox = new Function('module', 'exports', 'require', WATCHDOG_STANDALONE_BODY + '\nreturn stageDisableRow')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stageDisableRow = sandbox({}, {}, require) as (id: string) => boolean

    expect(stageDisableRow('dsh-broken')).toBe(true)

    const patched = await fs.readFile(patchFile, 'utf8')
    expect(patched).toContain('dsh-core')
    expect(patched).not.toContain('dsh-broken')

    // The marker + backup must exist for manual restoration.
    const entries = await fs.readdir(profileDir)
    expect(entries.some((e) => e === 'cordis.patch.yml.doctor-disabled-dsh-broken')).toBe(true)
    expect(entries.some((e) => e.startsWith('cordis.patch.yml.doctor-bak-'))).toBe(true)

    // Row not found → marker only, patch untouched.
    expect(stageDisableRow('dsh-unknown-row')).toBe(true)
    const patched2 = await fs.readFile(patchFile, 'utf8')
    expect(patched2).toBe(patched)
  })

  it('removeRowFromPatch keeps sibling rows and trailing patch blocks intact', async () => {
    // Structural check on the pruning helper itself: multi-row patches and
    // a second patch section must survive (only the target row goes).
    // eslint-disable-next-line no-new-func
    const sandbox = new Function('module', 'exports', 'require', WATCHDOG_STANDALONE_BODY + '\nreturn removeRowFromPatch')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const removeRowFromPatch = sandbox({}, {}, require) as (lines: string[], id: string) => string[]

    const lines = [
      '- insert:',
      '    - id: keep-a',
      '      name: keep-a',
      '      config: {x: 1}',
      '    - id: drop-me',
      '      name: drop-me',
      '      config: {y: 2}',
      '    - id: keep-b',
      '      name: keep-b',
      '      config: {z: 3}',
    ]
    const out = removeRowFromPatch(lines, 'drop-me')
    expect(out).toEqual([
      '- insert:',
      '    - id: keep-a',
      '      name: keep-a',
      '      config: {x: 1}',
      '    - id: keep-b',
      '      name: keep-b',
      '      config: {z: 3}',
    ])

    // Dropping the LAST row must not swallow the rows before it.
    const out2 = removeRowFromPatch(lines, 'keep-b')
    expect(out2).toEqual([
      '- insert:',
      '    - id: keep-a',
      '      name: keep-a',
      '      config: {x: 1}',
      '    - id: drop-me',
      '      name: drop-me',
      '      config: {y: 2}',
    ])

    // Unknown id → line count is unchanged (nothing pruned).
    const out3 = removeRowFromPatch(lines, 'not-there')
    expect(out3.length).toBe(lines.length)
  })

  it('tailFileByLines returns the last N lines (functional test)', async () => {
    // Extract the standalone body, define `tailFileByLines` in a sandbox,
    // and exercise it on a real temp file. This protects against future
    // refactors that move or rename the helper.
    // eslint-disable-next-line no-new-func
    const sandbox = new Function('module', 'exports', 'require', WATCHDOG_STANDALONE_BODY + '\nreturn tailFileByLines')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tailFileByLines = sandbox({}, {}, require) as (file: string, n: number) => string[]

    const f = path.join(tmpHome, 'tail-target.log')
    // Write 5000 short lines so the file exceeds one 64 KiB chunk and the
    // helper has to read multiple chunks from the end.
    const stream = (await import('node:fs')).createWriteStream(f)
    for (let i = 0; i < 5000; i++) {
      stream.write(`line-${i}\n`)
    }
    await new Promise<void>((res) => stream.end(res))

    const last10 = tailFileByLines(f, 10)
    expect(last10.length).toBe(10)
    expect(last10[0]).toBe('line-4990')
    expect(last10[9]).toBe('line-4999')

    const last3 = tailFileByLines(f, 3)
    expect(last3.length).toBe(3)
    expect(last3[0]).toBe('line-4997')
    expect(last3[2]).toBe('line-4999')

    // Missing file is an empty array, never a throw.
    expect(tailFileByLines(path.join(tmpHome, 'does-not-exist'), 10)).toEqual([])
  })

  it('singleInstance stamps the start marker that status uses for uptime', async () => {
    // The status tool's real uptime comes from .doctor-started, written
    // once by singleInstance() at watchdog boot. Run the cooked body in a
    // sandbox (it takes process.exit on a live duplicate, so use a fresh
    // tmp home with no existing pid file) and check the marker.
    const before = Date.now()
    // eslint-disable-next-line no-new-func
    const sandbox = new Function('module', 'exports', 'require', WATCHDOG_STANDALONE_BODY + '\nreturn singleInstance')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const singleInstance = sandbox({}, {}, require) as () => void
    singleInstance()

    const pidFile = path.join(tmpHome, 'doctor', '.doctor-watchdog.pid')
    const startedFile = path.join(tmpHome, 'doctor', '.doctor-started')
    const pidRaw = await fs.readFile(pidFile, 'utf8')
    expect(Number(pidRaw.trim())).toBe(process.pid)

    const startedRaw = await fs.readFile(startedFile, 'utf8')
    const ts = Date.now()
    const started = Number(startedRaw.trim())
    expect(Number.isFinite(started)).toBe(true)
    expect(started).toBeGreaterThanOrEqual(before - 5000)
    expect(started).toBeLessThanOrEqual(ts + 5000)
  })
})
