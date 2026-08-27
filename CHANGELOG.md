# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-01-15

### Added

- **Web boot recovery (60-second budget)** — standalone Node watchdog
  (`$DSH_HOME/doctor/watchdog.js`) registered as a per-user platform
  service on macOS (LaunchAgent), Linux (systemd user unit, cron
  fallback), and Windows (Task Scheduler via VBS launcher —
  best-effort, unverified).
- **CLI doctor (no time budget)** — `dsh doctor` reuses the same
  triage + recovery primitives for when `dsh web` never came up; runs
  to completion with no 60s cap.
- **Tool error capture** — in-process subscription to
  `tools/pre-execute` / `tools/execute` / `tools/post-execute`. Errors
  are classified into `transient` / `agent` / `business` and recorded
  to `logs/tool-errors.log` plus an in-memory per-session queue.
  `dsh_doctor_drain_deferred` surfaces queued errors on demand.
  Default behaviour: **observe, never mutate** the waterfall.
- Triage engine that classifies boot failures against known patterns:
  - `duplicate loader entry id: <id>` → disable that row, restart.
  - `Schema parse error.*<pkg>` → disable that row, restart.
  - `Cannot find module '<pkg>'` → mark row as broken-deps, disable, restart.
  - `EADDRINUSE` → kill only the recorded pid, restart.
  - Generic stack naming a plugin → disable that one row.
- Simple-path recovery (target ≤ 20 s) for the above.
- Complex-path recovery: safe-mode patch layer that overrides every
  bundle except `safeModeBundles` (default `['dsh-core']`).
- `last-known-good.json` snapshot of the last successfully booted profile.
- Rotating logs (5 MB × 3) under `$DSH_HOME/doctor/logs/`.
- Single-instance pid lock and graceful signal handling in the watchdog.
- Eight model-facing tools: `dsh_doctor_install`, `dsh_doctor_uninstall`,
  `dsh_doctor_status`, `dsh_doctor_pause`, `dsh_doctor_resume`,
  `dsh_doctor_diagnose`, `dsh_doctor_safe_mode_enter`,
  `dsh_doctor_safe_mode_exit`, `dsh_doctor_drain_deferred`.
- Runtime peer-version guard: refuses to load if the resolved
  `@deepseek-ai/dsh-tools` is outside `^0.1.0-rc.6`.
- CI: typecheck → build → unit tests → pack.

### Known limitations

- Windows Task Scheduler path is implemented but has not been verified
  on a real Windows machine.
- The watchdog cannot recover from a node-binary corruption (e.g.
  wrong Node version) — it will keep the simple path failing;
  safe-mode will also fail; the alarm log will be the only signal.
- The triage engine only knows the patterns documented above. New
  failure modes from future dsh versions will land in the complex
  path until patterns are added.
- **Active session watch** (subscribe to `turn/end`, `host/agent-error`,
  inject "继续") and **loop guard** are not in 0.1.0. They require
  `require('@deepseek-ai/dsh-agent')` and
  `require('@deepseek-ai/dsh-settings')` from a plugin install, which
  pnpm currently isolates under `.pnpm/`. Planned for 0.2.0.
- The tool-error default policy is deliberately conservative: it
  observes the waterfall but does not block, retry, or rewrite. To
  change behaviour, register a custom classifier through the
  extension point described in `docs/ARCHITECTURE.md`.

[Unreleased]: https://github.com/d86e/dsh-doctor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/d86e/dsh-doctor/releases/tag/v0.1.0
