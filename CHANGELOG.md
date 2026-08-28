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
