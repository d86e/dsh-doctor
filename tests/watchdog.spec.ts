import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  WATCHDOG_STANDALONE_BODY,
} from '../src/watchdog.standalone.js'
import { PATTERNS } from '../src/triage.js'
import { ConfigDefaults } from '../src/config.js'
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
  let savedMaxListeners: number

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-doctor-test-'))
    process.env.DSH_HOME = tmpHome
    // Each run of the full body registers process-level SIGINT/SIGTERM/
    // SIGHUP handlers; without a listener budget the 10th sandbox in this
    // file emits MaxListenersExceededWarning. Raise the budget for the
    // lifetime of a test.
    savedMaxListeners = process.getMaxListeners()
    process.setMaxListeners(100)
  })
  afterEach(async () => {
    delete process.env.DSH_HOME
    process.setMaxListeners(savedMaxListeners)
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

  it('inline PATTERNS table agrees with src/triage.ts on id, priority, and kind (drift-guard)', () => {
    // The standalone watchdog carries a hand-kept COPY of src/triage.ts's
    // PATTERNS. The copies have drifted at least three times historically
    // (pnpm-peer regex, schema-parse extraction, plugin-export-missing
    // form) and every drift shipped a subtly different recovery than the
    // in-process diagnose tool. This guard extracts both tables and
    // asserts per shared id: same priority and same action kind for a
    // synthetic match ([id, capture]) — a kind-only comparison because
    // the in-process build() also attaches reason/via metadata the
    // standalone act() does not.
    // eslint-disable-next-line no-new-func
    const wStart = WATCHDOG_STANDALONE_BODY.indexOf('const PATTERNS')
    // The slice must include the package-id helpers (guessPkg,
    // guessPkgFromPath) because the act() callbacks reference them.
    // End the slice at the start-marker comment that follows the
    // helpers (present in the current body).
    const helperEnd = WATCHDOG_STANDALONE_BODY.indexOf('return guessPkg(s)', WATCHDOG_STANDALONE_BODY.indexOf('function guessPkgFromPath'))
    const wEnd = helperEnd >= 0 ? WATCHDOG_STANDALONE_BODY.indexOf('\n', WATCHDOG_STANDALONE_BODY.indexOf('}', helperEnd)) + 1 : WATCHDOG_STANDALONE_BODY.indexOf('function probe')
    if (wStart < 0 || wEnd < 0 || wEnd < wStart) throw new Error('standalone PATTERNS section not found')
    const modW = { exports: {} as Record<string, unknown> }
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', WATCHDOG_STANDALONE_BODY.slice(wStart, wEnd) + '\nmodule.exports = { PATTERNS };')(modW, modW.exports)
    const wp = modW.exports.PATTERNS as Array<{ id: string; pri: number; act: (m: string[]) => { kind: string } }>

    const ip = PATTERNS as ReadonlyArray<{ id: string; priority: number; build: (id: string | null) => { kind: string } }>
    const iById = new Map(ip.map((p) => [p.id, p]))
    const wById = new Map(wp.map((p) => [p.id, p]))
    expect(wById.size, 'standalone table empty').toBeGreaterThan(0)

    for (const [id, wpat] of wById) {
      const ipat = iById.get(id)
      expect(ipat, `standalone-only pattern '${id}' (add it to src/triage.ts or delete it)`).toBeDefined()
      const fake = [id, 'somepkg'] // group1 = a package, so both paths resolve an id
      const wkind = wpat.act(fake).kind
      const ikind = ipat!.build('somepkg').kind
      expect(wkind, `${id}: action kind drifted`).toBe(ikind)
      expect(wpat.pri, `${id}: priority drifted`).toBe(ipat!.priority)
    }
    // Every in-process pattern must exist in the standalone copy too —
    // a pattern that only the in-process tool can see is a watchdog that
    // can never recover from that failure.
    for (const id of iById.keys()) {
      expect(wById.get(id), `in-process-only pattern '${id}' (watchdog cannot recover it)`).toBeDefined()
    }
  })

  it('standalone CFG defaults match src/config.ts Defaults (shared knobs, drift-guard)', () => {
    // Second drift surface found the same way as the PATTERNS one: the
    // generated daemon keeps its own copy of the shared config defaults.
    // The plugin's install step writes the FULLY-RESOLVED config (it
    // always includes Defaults.* — see the resolveConfig +
    // writeFileAtomic(StatePaths.configJson()) step), so the literal in
    // this file is only the no-config.json fallback. Still, a stale
    // literal is misleading: the source says one thing, the runtime
    // does another. Pin the shared knobs.
    // eslint-disable-next-line no-new-func
    const sandbox = new Function('module', 'exports', 'require', WATCHDOG_STANDALONE_BODY + '\nreturn JSON.parse(JSON.stringify(CFG))')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bodyCfg = sandbox({}, {}, require) as Record<string, unknown>

    const shared: Array<[keyof typeof ConfigDefaults]> = [
      'healthIntervalMs',
      'healthFailuresToRecover',
      'recoveryBudgetMs',
      'triageLogLines',
    ]
    for (const key of shared) {
      expect(bodyCfg[key], `standalone CFG.${key} drifted`).toBe(ConfigDefaults[key])
    }
    expect(
      JSON.stringify(bodyCfg.safeModeBundles),
      'standalone CFG.safeModeBundles drifted',
    ).toBe(JSON.stringify(ConfigDefaults.safeModeBundles))
  })

  it('probe(): healthy when / answers 200 even though /health 404s (live-bug regression)', async () => {
    // The pre-v0.2.27 probe hit only /health. dsh web serves no /health
    // route (verified live: HTTP 404 on a healthy, fully working GUI),
    // so a healthy server was reported broken and the daemon downgrade-
    // stormed into safe-mode. probe must treat "the GUI shell is being
    // served" as healthy. Functional test against a real HTTP server:
    //   / -> 200 (shell), /health -> 404  =>  probe() === true
    const httpMod = await import('node:http')
    const server = httpMod.createServer((req, res) => {
      if (req.url === '/') { res.statusCode = 200; res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html></html>') }
      else { res.statusCode = 404; res.end('not found') }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    if (typeof addr !== 'object' || addr === null) throw new Error('expected a bound address')
    process.env.DSH_WEB_PORT = String(addr.port)
    // eslint-disable-next-line no-new-func
    const sandbox = new Function('module', 'exports', 'require', WATCHDOG_STANDALONE_BODY + '\nreturn probe')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const probe = sandbox({}, {}, require) as () => Promise<boolean>
    try {
      expect(await probe()).toBe(true)
    } finally {
      delete process.env.DSH_WEB_PORT
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('probe(): broken when neither / nor /health answers 200', async () => {
    const httpMod = await import('node:http')
    // Server that accepts TCP (so portHasListener is true — the exact
    // "alive but broken" state) but 404s everything, including /.
    const server = httpMod.createServer((_req, res) => { res.statusCode = 404; res.end('nope') })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    if (typeof addr !== 'object' || addr === null) throw new Error('expected a bound address')
    process.env.DSH_WEB_PORT = String(addr.port)
    // eslint-disable-next-line no-new-func
    const sandbox = new Function('module', 'exports', 'require', WATCHDOG_STANDALONE_BODY + '\nreturn probe')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const probe = sandbox({}, {}, require) as () => Promise<boolean>
    try {
      expect(await probe()).toBe(false)
    } finally {
      delete process.env.DSH_WEB_PORT
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('probe(): healthy when /health is 200 even if / is a 500 (semantic endpoint wins)', async () => {
    const httpMod = await import('node:http')
    const server = httpMod.createServer((req, res) => {
      if (req.url === '/health') { res.statusCode = 200; res.end('ok') }
      else { res.statusCode = 500; res.end('boom') }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    if (typeof addr !== 'object' || addr === null) throw new Error('expected a bound address')
    process.env.DSH_WEB_PORT = String(addr.port)
    // eslint-disable-next-line no-new-func
    const sandbox = new Function('module', 'exports', 'require', WATCHDOG_STANDALONE_BODY + '\nreturn probe')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const probe = sandbox({}, {}, require) as () => Promise<boolean>
    try {
      expect(await probe()).toBe(true)
    } finally {
      delete process.env.DSH_WEB_PORT
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('probe(): dead when nothing listens on the port', async () => {
    // Bind then close to grab a (probably) free port, and point the
    // probe at it.
    const netMod = await import('node:net')
    const listener = netMod.createServer()
    await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r))
    const addr = listener.address()
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0
    await new Promise<void>((r) => listener.close(() => r()))
    if (port === 0) throw new Error('no free port')
    process.env.DSH_WEB_PORT = String(port)
    // eslint-disable-next-line no-new-func
    const sandbox = new Function('module', 'exports', 'require', WATCHDOG_STANDALONE_BODY + '\nreturn probe')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const probe = sandbox({}, {}, require) as () => Promise<boolean>
    try {
      expect(await probe()).toBe(false)
    } finally {
      delete process.env.DSH_WEB_PORT
    }
  })

  it('triageAndDisable: EADDRINUSE kills the recorded pid (not a safe-mode downgrade)', async () => {
    // Before v0.2.28 the highest-priority pattern (kill-pid-and-restart,
    // pri 100) had no branch in triageAndDisable and fell into the
    // else -> activateSafeMode fallback: every port-conflict incident
    // demoted a healthy profile to dsh-core-only. Now the daemon
    // kills the recorded web pid and let's the platform service
    // re-pull — and escalates to safe-mode only when the kill itself
    // fails. Functional test: spawn a real child as the "orphan web",
    // point .dsh-web.pid at it, feed the body a log with EADDRINUSE.
    const cp = await import('node:child_process')
    const orphan = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
      stdio: 'ignore',
    })
    orphan.unref()
    await new Promise((r) => setImmediate(r))
    const orphanPid = orphan.pid
    expect(orphanPid, 'orphan pid').toBeGreaterThan(0)

    void await fs.mkdir(path.join(tmpHome, 'doctor', 'logs'), { recursive: true })
    void await fs.mkdir(path.join(tmpHome, 'profiles', 'web'), { recursive: true })
    await fs.writeFile(
      path.join(tmpHome, 'doctor', 'logs', 'dsh-web.log'),
      'Error: listen EADDRINUSE: address already in use 127.0.0.1:3080\n',
    )
    await fs.writeFile(path.join(tmpHome, 'profiles', 'web', '.dsh-web.pid'), String(orphanPid))

    // eslint-disable-next-line no-new-func
    const sandbox = new Function('module', 'exports', 'require', WATCHDOG_STANDALONE_BODY + '\nreturn triageAndDisable')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const triageAndDisable = sandbox({}, {}, require) as (elapsed: number) => void

    triageAndDisable(1000) // elapsed 1s << 60s budget -> kind branch, not budget

    // Give the SIGTERM a beat to land, then verify the orphan is gone
    // and that NO safe-mode patch was staged (the old fallback).
    await new Promise((r) => setTimeout(r, 250))
    let orphanAlive = true
    try { process.kill(orphanPid, 0) } catch { orphanAlive = false }
    expect(orphanAlive, 'orphan web pid should have been SIGTERMed').toBe(false)
    const safePatch = path.join(tmpHome, 'doctor', 'safe-mode.patch.yml')
    const stat = await fs.stat(safePatch).catch(() => null)
    expect(stat, 'no safe-mode patch may be staged for a killed port conflict').toBeNull()
    orphan.kill('SIGKILL')
  })

  it('triageAndDisable: EADDRINUSE with no recorded pid escalates to safe-mode', async () => {
    // No .dsh-web.pid at all: killWeb has nothing to kill and the
    // daemon must escalate to safe-mode so SOMETHING changes.
    void await fs.mkdir(path.join(tmpHome, 'doctor', 'logs'), { recursive: true })
    await fs.writeFile(
      path.join(tmpHome, 'doctor', 'logs', 'dsh-web.log'),
      'Error: listen EADDRINUSE: address already in use 0.0.0.0:3080\n',
    )
    // eslint-disable-next-line no-new-func
    const sandbox = new Function('module', 'exports', 'require', WATCHDOG_STANDALONE_BODY + '\nreturn triageAndDisable')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const triageAndDisable = sandbox({}, {}, require) as (elapsed: number) => void
    triageAndDisable(1000)
    const safePatch = path.join(tmpHome, 'doctor', 'safe-mode.patch.yml')
    const stat = await fs.stat(safePatch).catch(() => null)
    expect(stat, 'safe-mode patch must be staged when the kill has no target').not.toBeNull()
  })

  it('activateSafeMode rows match src/safe-mode.ts buildSafeModePatch byte-for-byte (drift-guard)', async () => {
    // Third drift surface, found the same way as the PATTERNS and config
    // ones: safe-mode patch generation is duplicated between the
    // in-process module and the generated daemon. The copy in the body
    // re-introduced the v0.2.20 sentinel bug (name: dsh-doctor clobbers
    // the doctor's own plugin row) after the in-process side was fixed —
    // and the v0.2.20 regression test asserts only the in-process side,
    // so the daemon-side copy drifted unseen. The headers legitimately
    // differ (the daemon stamps activation time); the ROWS must be
    // byte-identical since cordis resolves them. Pin them for every
    // allow-list shape we produce.
    const { buildSafeModePatch } = await import('../src/safe-mode.js')

    void await fs.mkdir(path.join(tmpHome, 'doctor'), { recursive: true })
    const safeFile = path.join(tmpHome, 'doctor', 'safe-mode.patch.yml')
    // eslint-disable-next-line no-new-func
    const sandbox = new Function('module', 'exports', 'require', WATCHDOG_STANDALONE_BODY + '\nreturn activateSafeMode')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activateSafeMode = sandbox({}, {}, require) as (list: string[]) => void

    const rowsOf = (text: string): string => text.slice(text.indexOf('- insert:\n') + '- insert:\n'.length)

    for (const list of [['dsh-core'], ['dsh-core', '@scope/dsh-x'], [], ['a', 'b', 'c']]) {
      activateSafeMode(list)
      const daemonText = await fs.readFile(safeFile, 'utf8')
      const refText = buildSafeModePatch(list)
      expect(rowsOf(daemonText), `daemon rows drifted for allow-list [${list.join(',')}]`).toBe(rowsOf(refText))
    }
    // The v0.2.20 sentinel regression, asserted on the DAEMON's output
    // this time: neither id nor name may be `dsh-doctor`.
    activateSafeMode([])
    const sentinelText = await fs.readFile(safeFile, 'utf8')
    expect(sentinelText).not.toMatch(/name:\s*dsh-doctor\s*\n/m)
    expect(sentinelText).toMatch(/name:\s*dsh-doctor-safe-mode-sentinel/)
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
