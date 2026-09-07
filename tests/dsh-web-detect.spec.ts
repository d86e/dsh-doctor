import { describe, it, expect } from 'vitest'
import { looksLikeDshWeb } from '../src/index.js'

// The writer guard for .dsh-web.pid (v0.2.32). apply() runs in whatever
// process mounts the web profile — and that is NOT always the web server.
// `dsh plugin --profile web add` and any one-shot node process evaluating
// the profile all run apply() with a short-lived pid: letting any of them
// publish process.pid clobbers the running web's pid marker (observed
// live: the file held a dead CLI pid while the real web still served
// 3080). Only a process whose first non-flag subcommand is `web` gets to
// write the marker.
describe('looksLikeDshWeb (the .dsh-web.pid writer guard)', () => {
  it('accepts a real dsh web launch', () => {
    expect(looksLikeDshWeb(['/x/node', '/x/.local/bin/dsh', 'web', '--no-open'])).toBe(true)
    expect(looksLikeDshWeb(['/x/node', 'dsh', 'web'])).toBe(true)
    expect(looksLikeDshWeb(['/x/node', 'dsh', 'web', '--port', '3080', '--host', '127.0.0.1'])).toBe(true)
  })

  it('rejects dsh CLI runners that also mount the profile (the live clobber)', () => {
    // dsh plugin --profile web add — observed live overwriting the file.
    expect(looksLikeDshWeb(['/x/node', 'dsh', 'plugin', '--profile', 'web', 'add', 'pkg'])).toBe(false)
    expect(looksLikeDshWeb(['/x/node', 'dsh', 'plugin', 'list'])).toBe(false)
    expect(looksLikeDshWeb(['/x/node', 'dsh', 'web', ...[]] as string[])).toBe(true)
    // a bare dsh with no subcommand does not eval the web profile
    expect(looksLikeDshWeb(['/x/node', 'dsh'])).toBe(false)
    // node running a script is not dsh web
    expect(looksLikeDshWeb(['/x/node', '/x/some-script.js', 'web'])).toBe(false)
  })

  it('is conservative when the argv is unclear', () => {
    expect(looksLikeDshWeb([])).toBe(false)
    expect(looksLikeDshWeb(['/x/node'])).toBe(false)
    expect(looksLikeDshWeb(['/x/node', '-e', '1+1'])).toBe(false)
    // flags before the subcommand are tolerated (dsh web --port 3080
    // form), but an unrelated non-flag token before "web" is not a web launch
    expect(looksLikeDshWeb(['/x/node', 'dsh', 'serve', 'web'])).toBe(false)
  })

  it('defaults to process.argv (no throw on a non-dsh test process)', () => {
    // Just call with no arg: must return a boolean without throwing,
    // whatever the test runner's argv is.
    const v = looksLikeDshWeb()
    expect(typeof v).toBe('boolean')
  })
})
