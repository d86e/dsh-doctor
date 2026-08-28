# Changelog

All notable changes to `@d86e/dsh-doctor` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **CLI doctor** (no time budget) — unbounded triage + recovery for
  already-broken installs, runs to completion.
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

[0.2.0]: https://github.com/d86e/dsh-doctor/releases/tag/v0.2.0
[0.1.0]: https://github.com/d86e/dsh-doctor/releases/tag/v0.1.0
