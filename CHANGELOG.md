# Changelog

All notable changes to `@d86e/dsh-doctor` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.36] — 2026-09-08

### Fixed — 1255 lines of WARN in ONE hour: the two throttle promises never landed

The 08-31 episode (web down 02:31→09:28) left a forensic record in the
daemon log: 1255 WARN lines in that single hour, ~half of the rolled
5 MB file. Two lines accounted for the almost all, and both were
supposed to be quiet already:

1. "port still empty after Ns — within boot budget, waiting" (the
   v0.2.30 boot-budget line) printed on ~4 of 5 ticks — the condition
   tickCount % 5 !== 0 was inverted (the comment said "one line at 1/4
   and 1/2 of the budget"; the code fired from 1/4 budget onward on
   every non-multiple-of-5 tick). Live: it ran every 2 s from 10s to
   26s+ of every boot-watch window.
   Now: first line at 1/4 of the budget, then at most one per 5 s —
   a 30 s budget yields at most ~5 lines instead of ~15.

2. "recovery rate-limited — will retry next tick" printed on EVERY
   tick for the whole 5-minute rate-limit window (up to 150 lines per
   episode). It is the single most common line in the daemon log
   (the 08-31 episode alone logged it ~900 times).
   Now: at most one line per 30 s via the shared logRateLimited()
   used at both call sites (empty-port branch and alive-but-broken
   branch).

### Why

Same family as 0.2.33's "the rate limit log fired before the rate
limit check": a condition whose intent was documented in a comment but
whose implementation said something else. Neither line is a bug in
the recovery logic (both windows behaved correctly); the cost is
diagnostic — in a 5 MB rolling log, an operator cannot find the one
line that explains the episode among two thousand copies of a line
that explains nothing new.

- tests — a new regression spins 100 back-to-back logRateLimited()
  calls (must yield a single line) and pumps the 1.5 s test budget
   hundreds of ticks (must yield ≤3 waiting lines, ≥1 to prove the
   operator still sees the watchdog is waiting). Verified sensitive:
   with the throttle disabled the test is red.

## [0.2.35] — 2026-09-08

### Fixed — daemon (LaunchAgent) could not find dsh: bare cp.spawn('dsh') ENOENTed

v0.2.33/0.2.34 made the daemon relaunch dsh web in manual mode
(startWeb), but the daemon runs as a launchd LaunchAgent whose default
environment is the minimal PATH /usr/bin:/bin:/usr/sbin:/sbin — the
user's shell additions (~/.local/bin, ~/.hermes) are never in it. So
cp.spawn('dsh') from the daemon ENOENTed. Observed live on 09-08:
"spawn dsh failed: spawn dsh ENOENT" logged three consecutive times
(16:21 / 16:26 / 16:31 — the rate-limit's 5-minute window), while dsh
sat installed at ~/.local/bin/dsh the whole time and the 0.2.34 ENOENT
handler simply kept the daemon from crashing — the web never came back.
This is the same hole CI found one step earlier (v0.2.34) but with a
worse consequence: on CI it only failed the run; here it left the port
empty for the duration of the outage.

- src/watchdog.standalone.ts — new resolveDsh() resolves where dsh
  actually lives WITHOUT trusting PATH:
    1. DSH_BIN env (explicit override; a .js value is flagged isScript)
    2. absolute JS entry of the @deepseek-ai/dsh package, probed across
       the known global install locations (~/.local/lib, DSH_HOME's
       node_modules, ~/.hermes/node/lib, ~/.npm-global, and every nvm
       node version dir). Each candidate is cross-checked against its
       package root's package.json (name === @deepseek-ai/dsh) so a
       stale copy of lib/bin.js under the wrong package is rejected.
    3. an absolute dsh on the daemon's own PATH, if present
    4. bare 'dsh' (the pre-v0.2.35 behavior; the ENOENT handler in
       startWeb catches the miss and logs it)
  startWeb() then spawns the resolved target. A .js entry is spawned as
  process.execPath <script> — the daemon's own node binary is always an
  absolute path (it is how the daemon itself was started), so a
  minimal-PATH LaunchAgent no longer needs to resolve anything by name.

- src/index.ts — looksLikeDshWeb() now also accepts the
  node <pkg>/lib/bin.js web launch shape, because that is exactly how
  the daemon's v0.2.35 startWeb() spawns dsh web. Previously such a
  spawn's pid was not written to .dsh-web.pid (the guard only accepted
  argv[1] basename dsh/dsh.js/dsh.cmd/dsh.exe), so a daemon-spawned web
  would have had no recorded pid for a future kill-or-restart. The new
  rule requires the path to be a bin.js inside a @deepseek-ai/dsh
  node_modules segment, so the v0.2.31 clobber case (dsh plugin
  --profile web add, argv[2]=plugin not web) does not reopen.

- tests —
    - tests/watchdog.spec.ts: new resolveDsh regression (bare PATH +
      a HOME that does not actually contain dsh -> the bare-dsh
      fallback with a non-empty cmd; on a host that DOES have dsh
      globally, the resolved .js must exist and be flagged isScript;
      DSH_BIN .js vs .exe overrides).
    - the two triage-tail spawn tests now POLL the stub's marker file
      instead of a fixed sleep. Under CI load the fire-and-forget
      manual relaunch probes a dead port (~2 s) before the stub child
      even gets spawned, so a 300 ms wait races its first line.

### Why

"the other side of the contract was never exercised" family, round 5:
v0.2.30 (the boot budget), v0.2.31 (the writer), v0.2.32 (the
clobberer), v0.2.33 (the relaunch), v0.2.34 (the ENOENT handler) —
and now the PATH. cp.spawn('name') from a launchd service has never
been safe unless the name is a bare absolute path or the service is
given the right environment. We chose to make the daemon find its own
dsh instead of relying on the LaunchAgent's environment, because the
dsh the operator actually uses is the one on THEIR shell's PATH (which
is exactly ~/.local/bin/dsh here), not whatever /usr/bin/dsh happens
to be — if there even is one.

## [0.2.34] — 2026-09-08

### Fixed — async spawn ENOENT escaped startWeb as an uncaught exception (v0.2.33 CI red)

v0.2.33's CI run failed even though all 154 tests passed: an
"Unhandled Errors" section with one "Error: spawn dsh ENOENT" and no
handler. The v0.2.33 triage tail relaunches dsh web on manual-mode
hosts via a fire-and-forget "void manualRelaunchIfAvailable(...)"
call. On a GitHub Actions ubuntu runner, "dsh" is not on PATH, so the
CP.spawn call returns immediately, the ENOENT arrives a few ms later
as a child "error" event, and with no handler on it Node escalates
it to an uncaught exception. On a macOS host with dsh installed the
spawn actually succeeds (or dsh web is already running and the probe
short-circuits earlier), so the bug only surfaced on CI.

- src/watchdog.standalone.ts — startWeb() now attaches two handlers
  on the child:
    - "error": logs "spawn <dsh> failed: <message>" to watchdog.log
      (previously this class of failure only ever landed in
      dsh-web.log, which an operator is less likely to be tiling)
      and clears the LOCK file if it records this spawn. An ENOENT
      spawn has no usable pid, so manualRelaunchIfAvailable wrote an
      empty lock — the handler treats BOTH "empty" and "this pid" as
      ours, so a failed attempt cannot dedupe the next one.
    - "exit": logs a "spawned dsh web pid=<p> exited code=<c> sig=<s>"
      line. A well-behaved dsh web never exits on its own; a quick
      exit right after spawn is an early crash the operator should
      see in the daemon log, not buried in dsh-web.log.
- The two new handlers are plain JS closures over dsh, child,
  child.pid and LOCK — no new dependencies, no new feature; they just
  stop the existing child-process spawn from throwing asynchronously
  into the void (and, for the ENOENT case, undo the side-effect of
  the restart lock that a doomed spawn left behind).
- tests — tests/watchdog.spec.ts:
    - new startWeb ENOENT regression: stubs DSH_BIN to a missing
      path, calls manualRelaunchIfAvailable, polls the daemon log
      until /spawn .*failed:.*ENOENT/ appears, then asserts the LOCK
      is gone. This pins the "failure lands in watchdog.log, not an
      uncaught exception" contract that v0.2.33's CI run violated.
    - the EADDRINUSE-with-no-recorded-pid test now sets DSH_BIN to a
      stub shell so its fire-and-forget relaunch does not try to
      spawn a binary that may not exist on every platform (this was
      also the CI surface of the ENOENT, but at the test level: on a
      runner with no dsh, spawn fails async after the test has
      already passed, surfacing as an unhandled error in the file).

### Why

This is the same "fire-and-forget promise with no error handling"
family as a few earlier rounds, but the surface was new because the
previous two spawn sites (kill-pid-and-restart in v0.2.31, and the
triage-tail manual relaunch in v0.2.33) predated the ENOENT handler.
A "spawn a binary that is not on PATH" used to be a visible failure
only on the platform that actually ran it. On v0.2.33's CI
(ubuntu-24.04, no dsh on PATH) it was a silent async kill of the
whole test suite.

## [0.2.33] — 2026-09-08

### Fixed — manual-mode crashes left the port empty for 7 hours (observed 09-08)

Every triage branch ends with "waiting for the platform service to
restart dsh web". In platform mode that is true. In manual mode there
is no platform service — nothing is ever going to pull dsh web back.
Observed live on 09-08: dsh web (pid 98431, up 18:15) died; the
v0.2.30 daemon correctly staged safe-mode after the 30 s boot budget,
logged the "triage action staged; waiting for platform service" line,
and the port stayed empty for 7 hours (02:31 → 09:28 local) because the
"platform service" that was supposed to relaunch dsh web was never
there. Meanwhile the "port empty for Ns / probe X / entering
crash-loop triage" line fired on every tick (observed ~12,460 probes)
even when the recovery rate-limit was about to skip the triage.

- src/watchdog.standalone.ts — new async manualRelaunchIfAvailable():
  if relaunchViaPlatform() reports no registered service, call probe()
  first (dsh web may have come back on its own, e.g. a human ran
  dsh web by hand — don't stack a second spawn on top), then read the
  LOCK file (the recorded pid of our last direct spawn, within a
  5-minute window): if that spawn is still alive we are already
  waiting on it, so skip; if it is dead (crash on startup) or absent,
  call startWeb() and record the new pid back into LOCK (which also
  becomes the first use of that constant — it was declared but
  never written to or read).
- The final tail of triageAndDisable (kill-pid fallback, notify-user,
  cleanup-and-restart, safe-mode, disable-row, no-match) now calls
  manualRelaunchIfAvailable after staging the fix, instead of always
  logging "waiting for platform service"; in platform mode it still
  logs the wait, in manual mode it spawns. The 09-08 7-hour window
  corresponds exactly to this line + manual mode + the daemon's
  triage kind = safe-mode + no-match.
- src/watchdog.standalone.ts — the "entering crash-loop triage" log
  line moved AFTER the recovery rate-limit check, so a tick that is
  going to skip triage does not first log that it is "entering" it.
  (Observed: the line at 09-08T01:27:51 → 01:28:13 fired every 2 s
  for 25 s straight, each tick about to be rate-limited right after.)

- tests — tests/watchdog.spec.ts: new manualRelaunchIfAvailable
  functional test (spawns a real child via a stubbed DSH_BIN as
  sh sleep 4, asserts the first call spawns, the LOCK records the
  alive pid, a second call dedupes while it is alive, SIGKILLs it,
  the third call re-spawns). The boot-budget regression test now also
  asserts the triage tail in manual mode actually spawned dsh web via
  the DSH_BIN stub, not just that safe-mode was staged — which is the
  specific regression that would have hidden the 09-08 bug (safe-mode
  was staged; the relaunch was never exercised).
- beforeEach cleanup: point DSH_WEB_PORT at a free throwaway port for
  every full-body sandbox (so a triage's manual relaunch probe hits a
  dead port, not the host's real 3080, and a test that forgets to
  clean its own port does not race the live web).

### Why

This is the same "the other side of the contract was never
exercised" family as v0.2.30 (the boot budget), v0.2.31 (the writer),
and v0.2.32 (the clobberer), one round later with an even larger
blast radius: the branch was right about everything except the
assumption "something is going to restart dsh web for us after we
hand it back". That is only true when a platform service owns dsh
web's lifecycle, and this host has no such service loaded (the
plist exists in ~/Library/LaunchAgents but is not in launchctl).
The LOCK file becomes the daemon's own memory of "I already tried to
relaunch and this is the pid I spawned", which is also the first real
use of a constant that had sat unused since the script was written.

## [0.2.32] — 2026-09-08

### Fixed — v0.2.31's pid writer let a short-lived CLI process clobber the web's

v0.2.31 made apply() unconditionally write process.pid into
~/.dsh/profiles/web/.dsh-web.pid. But apply() runs in whatever process
mounts the web profile — and that is not always the web server. dsh
plugin --profile web add and any one-shot node process that evaluates
the profile all run apply() too, with a short-lived pid that dies before
dsh web does. Observed live an hour after the 0.2.31 ship while the real
web (pid 98431, up since yesterday 18:15, still serving 3080) had its
marker overwritten at 02:18 by pid 26855 — a dead dsh plugin add runner.
A stale marker like that is worse than none: the kill branch's
"recorded pid already dead" fast-path would have concluded the port-holder
was already gone and spawned a new dsh web straight into EADDRINUSE
against the real one.

- src/index.ts — looksLikeDshWeb(argv), exported and unit-tested:
  only a process whose first non-flag subcommand is web AND whose
  argv[1] is the dsh executable (base name dsh / dsh.js / dsh.cmd /
  dsh.exe) gets to write the marker. apply() now guards writeWebPid
  behind it, so dsh plugin add, npx, and profile-checks stop clobbering.
- src/watchdog.standalone.ts — startWeb() now records the child pid it
  actually spawned into the same .dsh-web.pid. In manual mode the daemon
  is the launcher, and a marker left over from a different boot (or a
  clobber) would mislead the next kill-pid-and-restart; the write is
  best-effort next to the spawn.
- tests — new tests/dsh-web-detect.spec.ts (4 tests): accepts a real
  dsh web launch (with or without flags and with a pathed argv[1]),
  rejects the live clobber shape dsh plugin --profile web add, rejects
  node script.js web (subcommand token is an argument, not a dsh
  command), and is conservative on ambiguous argv. Existing kill-branch
  behavior is unchanged (29 watchdog tests still green: the stubbed-DSH_BIN
  test now also pins that the manual-mode spawn records web --port).

### Why

This is the same "the other end of the contract was never actually
exercised" family as v0.2.31, one round later: the writer existed and
wrote the right value in the right place — for the web. It just also
wrote that value from every other process that happened to load the
profile, and the live host has plenty of those (dsh plugin add runs a
fresh profile eval each time). The guard does not add a new state
channel; it narrows the write side to the process that actually owns
the port, and startWeb closes the manual-mode gap where the daemon is
the one doing the launching.

## [0.2.31] — 2026-09-07

### Fixed — the kill-pid-and-restart branch killed a file nothing ever wrote

v0.2.28 wired the EADDRINUSE triage branch to "kill the recorded web pid
then let the platform service restart dsh web", reading the pid from
~/.dsh/profiles/web/.dsh-web.pid. But no code path in the repo ever wrote
that file: readWebPid was the only non-doc reference, and a disk-wide
find found the marker absent while dsh web was running. The README and
docs/ARCHITECTURE.md each promise "the watchdog only kills the PID it
reads from .dsh-web.pid", and the v0.2.28 test hand-wrote the pid file
itself to feed the branch — so the branch was exercised in tests only,
and was dead code in production: every real EADDRINUSE fell through
killWeb() returning "no recorded web pid; skipping kill" straight into
the safe-mode fallback.

Two changes give the branch a writer and a manual-mode landing:

- src/state.ts + src/index.ts — writeWebPid(pid) is new, and apply()
  writes process.pid to the marker fire-and-forget. The in-process doctor
  runs inside dsh web, so process.pid IS the web's pid: that is the
  missing writer the branch (and both docs) assumed. readWebPid treats a
  dead pid as the already-dead case the kill branch exists for, so a
  file left behind after a crash is exactly right.
- src/watchdog.standalone.ts — the kill branch's success path no longer
  always "waits for the platform service". If relaunchViaPlatform()
  reports no registered service (manual mode — exactly the live host's
  situation, where io.deepseek.dsh is in ~/Library/LaunchAgents but not
  loaded in launchctl), the branch now startWeb() directly so the killed
  port-holder's slot is actually repopulated instead of the port
  staying empty. Safe-mode escalates only when the kill itself fails.

- tests — state.spec: writeWebPid round-trips to readWebPid (proving the
  writer now exists, not just the reader). watchdog.spec: the EADDRINUSE
  functional test now stubs DSH_BIN to a marker-logging shell script so
  that the manual-mode relaunch is asserted (spawned with "web --port"),
  which would previously have hidden any missing relaunch.

### Why

The "probe an imagined API" bug (v0.2.27 /health 404) was a read side
assumed to exist. This is the write side assumed to exist: the kill
branch read a file and the tests seeded it, but production never did.
The fix does not invent a new state channel — process.pid was already
the web's pid and the marker path was already there; it just made the
two ends meet, and gave the branch a landing for the host it is actually
deployed on.

## [0.2.30] — 2026-09-07

### Fixed — crash-loop triage fired mid-boot, demoting a healthy dsh-web boot to safe-mode

The empty-port branch declared a crash after 2 consecutive probes
(~4s) with nothing listening on the web port. On this host a *legitimate*
dsh web cold boot runs well past that — observed 09:12:16 kill,
09:12:30 healthy — so the daemon staged safe-mode three times while the
web was still legitimately starting, reading a clean log that matched
nothing and falling through to the no-match safe-mode fallback. A
healthy profile got demoted to dsh-core-only every slow boot.

- src/watchdog.standalone.ts — the empty-port branch now runs on
  elapsed time against a boot budget (BOOT_BUDGET_MS, default 30s,
  overridable via DSH_DOCTOR_BOOT_BUDGET_MS) instead of a fixed
  2-probe count. Under budget it stays quiet (one log line near a
  quarter-budget mark); past budget it logs the real elapsed seconds
  and probes count and triages as before. firstFailureAt already
  resets on a healthy probe, so the budget is measured per boot
  window, not since install.
- tests — a budget default/override test (asserts the 30s default and
  that DSH_DOCTOR_BOOT_BUDGET_MS wins) plus a live-bug regression
  functional test: a free port is listened-on-then-closed at start, the
  cooked body is driven in a sandbox for a few ticks inside the budget
  (no safe-mode staged) and then past it (safe-mode staged). The
  sandbox uses the 1.5s budget so the regression runs in ~1.5s of wall.

### Why

This is the "probe an imagined API" bug family (v0.2.27 /health 404)
in its twin form: a threshold imagined to be a real bound when it is
only a count. 2 probes is a number that meant "the platform service had
enough chances to restart" — but the platform service's actual restart
latency is in seconds, not probe intervals. The budget is that real
restart time stated in the same units as the clock the daemon already
reads, so "crash" and "boot" can no longer be confused by a slow start.

## [0.2.29] — 2026-09-07

### Fixed — the daemon-side safe-mode sentinel regressed the v0.2.20 fix

Safe-mode patch generation is duplicated: buildSafeModePatch in
src/safe-mode.ts (in-process) and activateSafeMode inside the generated
standalone daemon (src/watchdog.standalone.ts). The v0.2.20 regression —
the empty-allow-list sentinel's name field must NOT be dsh-doctor, or
cordis resolves it to the running plugin and silently turns dsh-doctor
off — was fixed on the in-process side only. The daemon-side copy still
carried name: dsh-doctor, so an empty safeModeBundles list (a valid
config) would re-introduce the exact bug v0.2.20 claimed to have killed,
but the v0.2.20 regression test asserted only the in-process output and
let the daemon-side drift sit undetected.

- src/watchdog.standalone.ts — activateSafeMode's sentinel row now uses
  name: dsh-doctor-safe-mode-sentinel to match the reference
  buildSafeModePatch.
- tests — new drift-guard runs the cooked body's real activateSafeMode in
  a sandbox and asserts the -insert: rows it writes are byte-identical to
  buildSafeModePatch(list) for every allow-list shape (['dsh-core'],
  multi-row, empty, ['a','b','c']) — so a future divergence on either side
  is a red CI run, not the user watching their own plugin's row get
  clobbered.

### Why

v0.2.25 and v0.2.26 each shipped a drift-guard against a duplicated
artifact (the PATTERNS table, the config defaults). This is the third
instance of the same failure mode: a copy of a decision or a format that
two independent code paths produce, where a fix in one silently leaves
the other stale. The guards don't eliminate the duplication (the daemon
has to stay dependency-free) — they turn "drift will happen" into
"drift will fail a test the moment it happens."

## [0.2.28] — 2026-09-07

### Fixed — the highest-priority triage pattern was a dead branch

`triageAndDisable()` handled `notify-user`, `cleanup-and-restart`,
`safe-mode` and `disable-row` — but not `kill-pid-and-restart`, the
action produced by the **highest-priority** pattern (EADDRINUSE, pri
100, the single most likely incident: an orphan web pid holding the
port). An unmatched kind fell into the generic `else` →
`activateSafeMode`, so every port-conflict incident disabled the whole
profile down to dsh-core when the exact fix — SIGTERM the recorded pid
and let the platform service re-pull — was available one function away.

- **`src/watchdog.standalone.ts`** — `triageAndDisable` now has a
  `kill-pid-and-restart` branch: `killWeb()` on the recorded pid, log
  the success path, and escalate to safe-mode ONLY when the kill
  itself fails (no recorded pid, already dead pid, EPERM).
- **tests** — two functional tests run the cooked body's real
  `triageAndDisable` against a real temp home: (1) a live orphan child
  is SIGTERMed on EADDRINUSE and **no** safe-mode patch is staged
  (the old fallback would have staged one); (2) with no `.dsh-web.pid`
  on disk the daemon escalates to safe-mode so something changes.

### Fixed — ten pushed versions with no git tag

v0.2.18 through v0.2.27 were all committed and pushed, but the
`git tag vX.Y.Z` step was skipped after v0.2.17. Because the web
profile pins `@d86e/dsh-doctor` to a **tag** (`github:d86e/dsh-doctor#v0.2.17`),
the live profile was 13 versions behind main with no way to update to
the latest — the first time a real `dsh plugin add ...#v0.2.27` ran
today the gap was discovered (the live healthy-GUI false-positive from
v0.2.27 was being produced by the v0.2.17 daemon all along). All
missing tags are now pushed.

### Why

A triage playbook with a kind in the pattern table that no one dispatches
is a trap: it reads like the pattern is handled, and the fallback it
actually lands in is the HEAVIEST recovery (safe-mode) instead of the
lightest one (kill the orphan). The same way the v0.2.25 drift-guard
pins the table, these two tests pin the dispatch loop.

## [0.2.27] — 2026-09-07

### Fixed — the healthy-GUI false positive (probe hit a route that does not exist)

**The live bug.** On this machine, with the GUI fully working
(`GET /` → 200 for every user request), the daemon's watchdog log was
stuck on:

```
first probe failure with port listening — dsh web alive but broken; reading log for triage
triage: matched=null kind=safe-mode
recovery budget exhausted … staging safe-mode
```

repeating every 2 s. Root cause: `probe()` hit `GET /health` and treated
anything but 200 as a failure — but **dsh web has no `/health` route**
(verified live: 404). A perfectly healthy web server was therefore
probed as "alive but broken", its (clean) log triaged with no pattern
matching, and the no-match fallback — safe-mode — re-staged on every
incident window. Two real costs:

1. **False downgrade** — a healthy profile's next restart would boot in
   safe-mode (dsh-core only) for no reason.
2. **Log spam + CPU** — a `recovery rate-limited` line every two
   seconds for as long as the doctor is installed.

**The fix.** `probe()` now runs two concurrent probes: `GET /` (the GUI
shell — always 200 while the server actually serves users) and
`GET /health` (kept for forward-compat: a future dsh may add a real
semantic health endpoint, and if it does and it reports failure, that
still wins over a 200 root page is not the right semantic — but today
a 200 on EITHER is healthy, which is exactly the distinction that
matters while the route set is static). A new `probePath(p)` helper
owns the shared timeout/error/drain handling so both endpoints behave
identically.

**Proof.** Four functional tests boot REAL HTTP servers on random
ports and run the cooked body's own `probe()` against them:

- `/` → 200, `/health` → 404 ⇒ **healthy** (the live-bug regression case)
- everything 404 on a live TCP port ⇒ **broken** (true "alive but broken")
- `/` → 500, `/health` → 200 ⇒ **healthy** (semantic endpoint wins)
- nothing listening ⇒ **dead**

### Why

The probe was written against an imagined API. The single most
dangerous class of liveness false positive is "healthy on the outside,
unhealthy in the doctor's eyes", because every recovery play it triggers
(downgrade, patch rewrite, budget burn) costs a working system
something while fixing nothing. The four-case suite pins the truth
table so the next route change on either side fails CI instead of the
user's next restart.

## [0.2.26] — 2026-09-07

### Fixed — dead default: the daemon source said 30 s, the runtime probed every 2 s

The generated watchdog's `CFG` literal had `healthIntervalMs: 30000` while
the plugin's `Defaults.healthIntervalMs` is `2_000`. Because `dsh_doctor_install`
always writes the **fully-resolved** config (Defaults included) to
`config.json` and the daemon's `loadConfig` does `Object.assign(CFG, parsed)`,
the `30000` never took effect in a real installation — the source file
contradicted the running system by 15×. Anyone reading the generated
script to predict daemon behavior got the wrong answer.

- **`src/watchdog.standalone.ts`** — `healthIntervalMs` default is now
  `2000` with a comment explaining that all four shared knobs must track
  `src/config.ts` `Defaults`, and why (install always ships the resolved
  config; the literal is only the no-config.json fallback).
- **tests** — new drift-guard runs the cooked body's `CFG` and asserts
  `healthIntervalMs`, `healthFailuresToRecover`, `recoveryBudgetMs`,
  `triageLogLines` and `safeModeBundles` all equal
  `ConfigDefaults` from `src/config.js`. This was the first of the two
  triage/config drifts found this week; the guard makes the second
  one a CI failure instead of a field report.

### Why

Two files declaring defaults for the same runtime is a ticking clock;
the only question is whether the drift shows up in production (this
time it was masked by install-overwriting) or the next day in a support
ticket ("why does watchdog.js say 30000?"). Pinning them in the suite
closes the loop.

## [0.2.25] — 2026-09-07

### Added — drift-guard between the two triage pattern tables

`src/triage.ts` (in-process `dsh_doctor_diagnose`) and the inline
`PATTERNS` table baked into `watchdog.standalone.ts` (the generated
daemon script) are two hand-kept copies of the same decision table.
They drifted at least three times this week — the pnpm-peer regex, the
schema-parse id extraction, and the plugin-export-missing match form —
and every drift silently shipped **two different recovery plays for
the same incident** depending on whether the live plugin or the daemon
was watching.

New test runs the cooked watchdog body's own PATTERNS next to the
in-process table and asserts, for every pattern:

- the id exists in **both** tables (a pattern only one side can see
  means that side cannot recover from that failure),
- the **priority** is identical (the priority decides which pattern
  wins when a log line matches several), and
- the **action kind** is identical for a synthetic match (a `disable-row`
  on one side and a `safe-mode` on the other is the worst possible
  drift: two humans watching the same failure get told opposite things).

### Why

Two copies of a table maintained by humans will drift the moment a fix
lands in one and not the other. A guard that runs on every push
turns that moment from a field report ("why did my watchdog do X when
diagnose said Y?") into a red CI run.

## [0.2.24] — 2026-09-07

### Fixed — `dsh_doctor_status.uptime` reported a real value at last

The status tool returned `uptime: 'unknown (pid alive)'` for EVERY live
watchdog — a hard-coded string, never a number. Now:

- **`src/watchdog.standalone.ts`** — `singleInstance()` stamps
  `.doctor-started` (epoch ms) once at watchdog boot, and `cleanup()`
  removes it on SIGINT/SIGTERM, so the marker is alive for exactly the
  process's lifetime. Uninstall removes it alongside the other state
  files.
- **`src/index.ts`** — the status tool reads the start marker and
  renders a real duration via the new `formatUptime` (e.g. `1d 1h 1m`,
  never more than three units, trailing zero units dropped: `300s` →
  `5m`). Fallback chain when the marker is absent but the pid is alive:
  last-tick age, then the old honest `'unknown (pid alive)'`.
- **`src/state.ts`** — `readStartedAt()` / `startedAtPath()` join the
  other state helpers.
- **tests** — a functional test runs the cooked body's
  `singleInstance` in a sandbox temp home and asserts the marker is
  written with a sane timestamp next to the pid file; a new spec file
  pins the `formatUptime` rules (interior zeros kept, trailing zero
  units dropped, three-unit cap, fractional-second truncation, negative
  clamp).

### Why

A liveness feature that always lies is worse than no feature: an agent
reading `uptime: "unknown (pid alive)"` has no way to tell a 30-second-
old watchdog from a three-week-old one, which is exactly the distinction
that decides whether "it just booted, wait" or "it has been wedged,
restart" is the right move.

## [0.2.23] — 2026-09-07

### Added — platform-branched service-spec coverage (all three OSes, on any host)

CI runs on ubuntu only, so the `darwin` (LaunchAgent plist) and `win32`
(Task Scheduler XML + VBS) branches of `buildServiceSpec` could never be
exercised by the suite — a regression in either branch shipped silently
and was first caught by a real user on that OS. New `buildServiceSpec
per platform (mocked)` describe stubs `process.platform` and asserts
each branch's output and command vectors:

- **darwin** — plist carries the `com.deepseek-ai.dsh-doctor` label,
  `KeepAlive`, the node binary and the configured port; register/start/
  stop go through `launchctl`.
- **linux** — unit has `[Service] ExecStart=`, `Restart=always`,
  `RestartSec=`, `WantedBy=default.target`; commands use
  `systemctl --user`.
- **win32** — the joined content re-splits cleanly on the `---` marker
  back into a `<Task version="1.4">` XML (wscript launcher pointing at
  `dsh-doctor.vbs`) and a VBS that sets `DSH_HOME` / `DSH_WEB_PORT` and
  starts node hidden against the generated `doctor/watchdog.js` path;
  all four command vectors are `schtasks`.

### Fixed — CI: three stacked failures hiding the real test signal

Every CI run since the pnpm 9 bump died before a single one of our
tests ran, so "CI red" carried no signal at all:

1. `pnpm/action-setup@v4` rejected the combination of the workflow's
   `version: 9` and the repo's `packageManager: pnpm@9.12.0`
   ("Multiple versions of pnpm specified") — the action now pins
   9.12.0 to match the package.
2. `pnpm install --frozen-lockfile` failed with
   `ERR_PNPM_OUTDATED_LOCKFILE` — `package.json` gained the
   `@deepseek-ai/schemastery` peer dependency (cordis 4.x compat) but
   the lockfile was never regenerated. Lockfile refreshed with
   pnpm 9.12.0.
3. The pack job used `pnpm pack --dry-run` — an npm-ism; pnpm has no
   `--dry-run` flag, so the job died after the other two were already
   green. Replaced with a plain `pnpm pack` (which both lists the
   contents and writes the .tgz) plus a trivial tarball-existence check.

All three jobs are green as of v0.2.23 — "CI red" finally means
something again.

### Why

Mocking `process.platform` turns a "only works where you test it"
suite into one where every OS branch is asserted on every push, on
every host. The CI fixes are mundane but load-bearing: a pipeline
that cannot get past dependency setup cannot catch a broken regex —
see v0.2.22, which shipped five silently-dead triage patterns straight
through a pipeline whose only failure mode was pnpm version parsing.

## [0.2.22] — 2026-08-30

### Fixed — the standalone watchdog's triage regexes were cooked (5 of 12 patterns dead)

- **`src/watchdog.standalone.ts`** — the body was built with a
  *tagged* `String\`...\`` template. A tagged template **cooks** its
  backslash escapes, so every `\s` in the inline PATTERNS table became
  `s`, every `\d` became `d`, every `\.` became `.` in the generated
  script. Five patterns (EADDRINUSE, duplicate-loader-entry,
  node-version-mismatch, corrupt-patch-yaml, plugin-export-missing)
  silently fell through to safe-mode on every incident — the "simple
  path" was mostly dead. The body is now a `String.raw\`...\`` template:
  backslashes reach the generated script verbatim, and the file header
  documents the convention so nobody "fixes" it back.
- **CI gap that hid this** — the previous watchdog tests only asserted
  that the body *contains* certain function names and that it parses;
  they never *ran* the inline triage. New regression test
  `"every inline triage pattern really matches its log line"` executes
  the cooked body's own `triage()` against one realistic log line per
  pattern (13 fixtures), so any future cooking breakage fails the suite.

### Fixed — `guessPkgFromPath` referenced but never defined

- **`src/watchdog.standalone.ts`** — the `plugin-file-missing` pattern
  table entry called `guessPkgFromPath(...)`, but no such function
  existed in the generated script: every plugin-file-missing triage
  threw `ReferenceError: guessPkgFromPath is not defined` inside the
  *watchdog process* (caught only as a fallback safe-mode). The
  function is now defined (scoped + unscoped forms) and is covered by
  the new cooked-body regression test.

### Fixed — simple-path "disable row" only wrote a marker nobody consumed

- **`src/watchdog.standalone.ts` (`stageDisableRow`)** — pre-v0.2.22
  the simple recovery wrote
  `cordis.patch.yml.doctor-disabled-<id>` and left
  `cordis.patch.yml` alone. Dsh web boots from `cordis.patch.yml`, so
  the broken row was still mounted on restart, the incident re-tripped,
  and eventually escalated to safe-mode. Now the function rewrites the
  patch: it backs up the original to
  `cordis.patch.yml.doctor-bak-<epoch>`, atomically writes a pruned
  copy without the matched row, and keeps the marker as the human
  restore record. A new `removeRowFromPatch` helper does the pruning
  (row = its `id:` line + indented continuations; sibling rows and
  other patch sections are preserved).
- **`tests/watchdog.spec.ts`** — two functional tests run the cooked
  body's `stageDisableRow` / `removeRowFromPatch` against a real temp
  `cordis.patch.yml` (prune middle row, prune last row, marker-only
  fallback when the row is absent).

### Fixed — schema-parse / peer-conflict / export-missing id extraction

- **`src/watchdog.standalone.ts`** — three more extraction bugs in the
  inline table (the standalone copy had drifted from the
  `src/triage.ts` fixed in v0.2.18): schema-parse could capture the
  filler word "in" as the package id; pnpm-peer-conflict used the
  pre-v0.2.18 greedy-alternative regex; plugin-export-missing never
  matched the plain `did/did not export name and apply` form. All
  three are now aligned with `src/triage.ts` behavior and covered by
  the cooked-body fixtures.

### Why

The common thread: the standalone watchdog is a **string**, and for
two weeks it was a string that parsed but did not behave. The tests
asserted presence, not behavior. The new test executes the cooked
body, which is the only kind of test that can see what the generated
script actually does.

## [0.2.21] — 2026-08-30

### Fixed — tool errors raised via `throw` were silently dropped

- **`src/tool-errors.ts`** — the `tools/execute` waterfall handler only
  inspected the *returned* result object (`{ isError: true, error }`).
  The second, equally common failure idiom — `execute()` throwing /
  rejecting a raw `Error` — bypassed the capture entirely because the
  `await next()` had no `try/catch`. Every such error was lost from the
  queue, the log file, and the `dsh_doctor_drain_deferred` tool.
- **Fix** — wrap `next()` in try/catch; on reject, build a synthetic
  info object from the thrown error's `name` / `code` (when present),
  record it through the same classify → policy → queue/log pipeline as
  the structured path, **and re-throw** so upstream waterfall consumers
  still see the failure. The refactor also de-duplicates the record
  code (`recordFailure` helper) shared by both paths.
- **`tests/tool-errors.spec.ts`** — 2 new regression tests: a plain
  `reject(new Error(...))` now lands in the queue with the original
  error still propagating, and a thrown object carrying `name` + `code`
  records that metadata as `info` (e.g. `HttpError` / `E502` →
  transient).

### Fixed — stale `lastFailure` leaked across turns in the session watch

- **`src/session-watch.ts`** — `turn/start` now clears
  `state.lastFailure`. Before, a failure recorded on turn N stayed
  marked after turn N+1 began, so a *wedged* turn N+1 that tripped the
  idle path was logged with **turn N's** failure code — misleading when
  diagnosing which turn actually broke.
- **`tests/session-watch.spec.ts`** — regression test: failure on
  turn 1 → `turn/start` → `lastFailure === null`.

### Why

Two "silent drop" bugs with the same shape: failure information that
should have been visible was lost at a boundary (a thrown rejection that
was never `catch`ed; a state field that was never cleared at the
turn-start boundary). In an unattended setup these boundaries are
exactly where evidence goes missing — now it does not.

## [0.2.20] — 2026-08-30

### Added — watchdog liveness timestamp in `dsh_doctor_status`

- **`src/watchdog.standalone.ts`** — the tick loop now stamps
  `$DSH_HOME/doctor/.doctor-last-tick` (epoch ms) on every successful
  tick, and `cleanup()` removes it on exit. A live pid alone is not
  proof the watchdog is actually ticking — a wedged loop (the v0.2.6
  class of bug) still owns a pid. The timestamp is.
- **`src/state.ts`** — `readLastTickAt()` + `lastTickPath()` helpers.
- **`src/index.ts` (`dsh_doctor_status`)** — output now includes
  `lastTickAt` (epoch ms or null) and `lastTickAgeSec` (seconds since
  the last observed tick). An operator can now distinguish
  "watchdog alive and healthy" from "watchdog alive but wedged" from
  "watchdog dead" at a glance.
- **`dsh_doctor_uninstall`** cleans up the new marker file.

### Fixed — safe-mode sentinel could clobber the doctor plugin itself

- **`src/safe-mode.ts` (`buildSafeModePatch`)** — when
  `safeModeBundles` is an empty array, the sentinel row was emitted as
  `id: dsh-doctor-safe-mode-sentinel, name: dsh-doctor`. Cordis resolves
  a row by its `name`'s package identity, so that sentinel could silently
  replace the *running* dsh-doctor plugin row while safe mode was
  active — leaving the doctor blind to its own state. The sentinel now
  uses its own distinct id and name.
- **`tests/safe-mode.spec.ts`** — regression test asserting neither
  `id:` nor `name:` in an empty-allow-list patch equals `dsh-doctor`.

### Why

Two "silent blindness" bugs found by reading the recovery paths end to
end: one could leave the doctor wedged without a pid telling the truth
(the fix makes status tell you), the other could remove the doctor from
the composition while it was trying to save the composition (the fix
gives the sentinel its own identity). Both had a unit of work: stamp a
file, rename a yaml key — but both took real reading to find.

## [0.2.19] — 2026-08-30

### Added — `dsh_doctor_recent_log` tool

- **`src/state.ts`** — new `logPath(kind)` helper + `DoctorLogKind`
  union (`'web' | 'watchdog' | 'doctor' | 'tool-errors'`). One source of
  truth for "where is this log written?".
- **`src/index.ts`** — new 13th model-facing tool,
  `dsh_doctor_recent_log(kind, lines)`. Returns the last N lines
  (1–2000, default 100) of the named log. Before this tool the only
  way for an agent to inspect what the doctor had been doing was to
  shell out and tail the file; now one tool call gets you the tail.

### Why

The most common follow-up after `dsh_doctor_status` is "but why did it
do that?" — without `recent_log` the agent had to guess, or open a
shell it may not have permission to use. The four logs cover the four
distinct subsystems: dsh web's own stdout, the standalone watchdog's
recovery decisions, the in-process doctor's diagnostic stream, and
the per-tool-error JSONL log.

## [0.2.18] — 2026-08-30

### Added — configurable triage log window

- **`src/config.ts`** — new `triageLogLines` knob (default 1000, range
  50–50000). Overridable via `DSH_DOCTOR_TRIAGE_LOG_LINES` at every
  watchdog tick. The previous hard-coded `slice(-200)` in the
  standalone watchdog made triage ineffective whenever dsh web's log
  had rolled past 200 lines, which is common in long-running profiles.
- **`src/index.ts` (`dsh_doctor_diagnose`)** — when the caller omits
  `logLines` (passes 0), the tool now uses the configured
  `triageLogLines`. The old hard cap of 2000 is widened to 50000 to
  match the watchdog's effective window.

### Fixed — pnpm peer-dep conflict regex extracted the wrong plugin id

- **`src/triage.ts` (`pnpm-peer-conflict`)** — the old regex used two
  greedy alternatives and the extractor then tried to find a scoped
  match in the *whole* match, which produced wrong ids (it could pick
  up the trailing word "conflict" or a substring of the error message).
  The new regex captures the package specifier directly and the
  extractor handles scoped vs unscoped names without scanning the rest
  of the match.

### Fixed — standalone watchdog could OOM on huge dsh-web logs

- **`src/watchdog.standalone.ts`** — `triageAndDisable` previously did
  `fs.readFileSync(webLog, 'utf8')` and split, slurping the whole log
  into memory. A multi-hundred-MB log would block the watchdog tick
  for seconds and risk OOM. Replaced with a streaming `tailFileByLines`
  helper that reads 64 KiB chunks from the end until it has enough
  lines (or hits EOF). Honours the new `triageLogLines` config.

### Why

Three small quality-of-life fixes collected from real-world usage of
v0.2.17: a stale `slice(-200)` window, a regex that mis-identified
the offending plugin in peer-dep conflicts, and an unbounded log
read. Each was independently minor; together they noticeably improve
the doctor's recovery reliability on misconfigured profiles.

## [0.2.5] — 2026-08-28

## [0.2.5] — 2026-08-28

### Fixed — watchdog self-exit between ticks

- **`src/watchdog.standalone.ts`** — remove two stray `.unref()` calls on
  the tick `setTimeout`s. With them in place, the 30 s gap between probes
  left the event loop with no ref'd handle, and Node exited cleanly.
  launchd's `KeepAlive` then re-spawned the watchdog in a tight loop
  (`runs` climbed, `last exit code` stayed 0, the log only ever showed a
  single "watchdog started" line). Removing `.unref()` keeps the timer
  ref'd and the process alive.
- **`tests/watchdog.spec.ts`** — add regression tests that assert the
  generated body no longer contains the unref'd tick `setTimeout`s while
  still unref'ing the spawned `dsh web` child process.

## [0.2.4] — 2026-08-28

### Added — auto-install the watchdog on first plugin load

- **`src/auto-install.ts`** + **`src/auto-install-helper.ts`** — the
  first time the plugin loads, dsh-doctor spawns a detached helper that
  writes the watchdog script + platform service spec, registers and
  starts it. Subsequent loads are no-ops: if the watchdog script +
  platform service + running pid all exist, the helper is not spawned.
- **Config knob** — `autoInstall` (default `true`). Opt out with
  `autoInstall: false` in `cordis.patch.yml` or
  `DSH_DOCTOR_AUTO_INSTALL=0`.
- **`dsh_doctor_install`** is still registered for explicit re-install,
  dry-run, and debug scenarios.
- **README** updated to reflect the zero-touch install flow.

### Why

The previous design was chicken-and-egg: `dsh_doctor_install` is a
plugin tool, but the plugin needs to be loaded for the tool to exist,
and the watchdog needs to run to actually protect dsh. New users hit
this loop and gave up.

## [0.2.3] — 2026-08-28

### Fixed — declare `inject: ['tools', 'agents']` for cordis 4.x

- **`src/index.ts`** — the previous version tried to access
  `ctx.agents` via `(ctx as any).agents`, but cordis 4.x's proxy traps
  every property access on the context — including those that have
  been cast through `any` — and throws
  `cannot get property "agents" without inject` when the service is
  not in the declared dependency list.
- Declaring `inject: ['tools', 'agents']` lets cordis wait for the
  `agents` service (provided by `@deepseek-ai/dsh-agent`, already in
  every profile's `node_modules`) before calling `apply()`. The watch
  silently no-ops on dsh builds that do not provide `agents`.

## [0.2.2] — 2026-08-28

### Fixed — schemastery schema for `Config`

- dsh's cordis 4.x calls `runtime.Config['~standard'].validate(config)`
  on every reload. A plain object as `Config` throws
  `Cannot read properties of undefined (reading 'validate')` and the
  whole profile fails to boot.
- **`src/config.ts`** — switch the exported `Config` to a real
  schemastery schema built with `z.object` / `z.number` / `z.natural`
  / `z.boolean` / `z.string` / `z.array`. Each field has an explicit
  default. Validate via the same `createRequire` pattern we already
  use for `dsh-tools`.
- **Tuning** — shorten the default session watch idle threshold from
  10 minutes to **3 minutes** and the cooldown from 5 to **2 minutes**.
  10 minutes is too long for live sessions; if a turn is silent for
  3 minutes we should ask the agent to continue.
- **Peer dep** — add `@deepseek-ai/schemastery` (already in every
  dsh profile's `node_modules` because every dsh plugin depends on it).
- **`tests/config.spec.ts`** — rewritten to test the schemastery
  schema directly (`Config['~standard'].validate`) instead of
  expecting a plain object. `ConfigDefaults` carries the same values
  as the schema defaults for `resolveConfig(env)` tests.

## [0.2.1] — 2026-08-28

### Fixed — ship prebuilt `lib/` so `dsh plugin add` does not run `prepare`

- pnpm 9 refuses to run arbitrary build scripts for git-hosted
  dependencies (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`). The cleanest
  fix is to commit the build output so the host can `require
  lib/index.js` directly without invoking a script.
- **`.gitignore`** — keep tracking `lib/`.
- **`package.json`** — drop the `prepare` script; replace it with
  `prepublishOnly` (npm publish flow still typechecks + tests +
  builds, but git installs do not).
- **`lib/`** is now part of the v0.2.1 release artifact.

## [0.2.0] — 2026-08-28

### Added — live session watch

- **`src/session-watch.ts`** — in-process monitor for every dsh session in the
  host process. Subscribes to the `session/event` cordis event that dsh fires
  for each session; keeps a per-session state machine (idle, last failure,
  nudges sent, last manual user message).
- **Idle detection** — a session is "stuck" when it has not emitted any new
  event for `watchIdleThresholdMs` (default 10 min) while still inside a
  `turn/start` / `turn/end` window. Default 10 min; tuneable per environment.
- **Recovery** — when a session is stuck, the watcher sends a `继续` user
  message through `ctx.agents.get(sessionId).followup(...)`. This is the
  exact primitive the community `dsh-auto-continue` plugin uses — we
  re-implemented it inside dsh-doctor to give you layered protection in
  one bundle.
- **Three protections against over-firing**:
  1. `watchNudgeCooldownMs` between two nudges of the same session.
  2. `watchMaxNudgesPerSession` cap, reset on `turn/end:completed`.
  3. If a real `user/message` (source kind `user`) arrived within 5 s, the
     doctor steps back and assumes the human is driving.
- **Three new model-facing tools**:
  - `dsh_doctor_watch_list` — list every tracked session.
  - `dsh_doctor_watch_nudge` — manually inject a custom message.
  - `dsh_doctor_watch_cancel` — cancel a turn with `kind: 'user'`.
- **Dependency story** — `session-watch.ts` never `require()`s a dsh host
  package. It only reads `ctx.agents` and `ctx.on('session/event', ...)`,
  both injected by the dsh host runtime. If they are missing, the watch
  degrades to a no-op and logs a warning; the other 9 tools + the watchdog
  still work.

### Added — config knobs

`watchEnabled`, `watchIdleThresholdMs`, `watchNudgeCooldownMs`,
`watchMaxNudgesPerSession`, `watchContinueText`, `watchTickIntervalMs` —
each with a matching `DSH_DOCTOR_WATCH_*` env var override. All defaults
listed in the README.

### Changed

- `cordis.patch.yml` now declares the new watch fields with safe defaults.
- `apply(ctx, config)` now installs both the tool error capture and the
  session watch; both are wrapped in `try / catch` so a host that doesn't
  expose the relevant events does not break the plugin load.
- `dsh_doctor_status` output now includes `watchActive`,
  `trackedSessions` and a snapshot of the tool error summary alongside
  the existing fields.
- `dsh_doctor_uninstall` also disposes the watch handle.

### Tests

- **`tests/session-watch.spec.ts`** — 11 new tests covering fill-template,
  no-agents-service no-op, tracking, failure capture, manual nudge,
  manual cancel, and unknown-session handling.
- **Total: 83 unit tests across 9 spec files, all green.**

### Notes

- The runtime peer-version guard still targets `@deepseek-ai/dsh-tools`
  `^0.1.0-rc.6`. We do not pull in `dsh-agent` / `dsh-session` /
  `dsh-settings` as devDeps; the session watch types are local and the
  dsh host runtime is expected to provide `ctx.agents` at load time.
- DSH community auto-continue is now subsumed for the core feature
  (idle nudge + cancel). If you depend on its UI / notification bridge,
  keep it installed alongside dsh-doctor — they do not conflict.

---

## [0.1.0] — 2026-08-28

### Added

- **Web boot recovery** (60 s budget) — health probe every 30 s, triage
  engine, simple / complex recovery paths, safe-mode patch layer,
  rotating logs (5 MB × 3), rate-limited restarts.
- **Tool error capture** — subscribes to `tools/pre-execute`,
  `tools/execute`, `tools/post-execute` cordis events; classifies every
  failed tool call into `transient` / `agent` / `business`; records to
  `logs/tool-errors.log` and a per-session in-memory queue. Default
  policy: observe, never mutate the waterfall.
- **Standalone Node watchdog** — written to `$DSH_HOME/doctor/watchdog.js`,
  runs as a per-user platform service (LaunchAgent / systemd / Task
  Scheduler). Dep-free (only `node:fs/path/os/http/child_process/crypto`).
- **9 model-facing tools** — install, uninstall, status, pause, resume,
  diagnose, safe_mode_enter, safe_mode_exit, drain_deferred.
- **Runtime peer-version guard** — refuses to load if
  `@deepseek-ai/dsh-tools` resolves outside `^0.1.0-rc.6`.
- **72 unit tests** across 8 spec files; typecheck + build green.

[0.2.5]: https://github.com/d86e/dsh-doctor/releases/tag/v0.2.5
[0.2.4]: https://github.com/d86e/dsh-doctor/releases/tag/v0.2.4
[0.2.3]: https://github.com/d86e/dsh-doctor/releases/tag/v0.2.3
[0.2.2]: https://github.com/d86e/dsh-doctor/releases/tag/v0.2.2
[0.2.1]: https://github.com/d86e/dsh-doctor/releases/tag/v0.2.1
[0.2.0]: https://github.com/d86e/dsh-doctor/releases/tag/v0.2.0
[0.1.0]: https://github.com/d86e/dsh-doctor/releases/tag/v0.1.0
