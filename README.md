# dsh-doctor

[![CI](https://github.com/d86e/dsh-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/d86e/dsh-doctor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/dsh-%3E%3D0.1.0--rc.6-0066ff)](https://github.com/deepseek-ai/deepseek-harness)

> Self-healing watchdog for the DeepSeek Harness **web** profile. Detects plugin-induced boot failures and recovers within a **60-second** downtime budget via triage → fix → restart, falling back to a curated safe-mode profile when a quick fix is not enough. Provides a **CLI doctor** mode with no time budget. Captures **tool errors** via the official `tools/*` event hooks and lets you plug in custom recovery policies.

`dsh-doctor` runs as an **independent Node process** (LaunchAgent on macOS, systemd user unit on Linux, Task Scheduler on Windows) so it survives even when `dsh web` cannot spawn a child. It is **fully independent of `dsh-daemon`**: it does not call it, does not require it, and does not conflict with it. If both are installed, you get layered protection.

---

## Table of contents

- [What it does](#what-it-does)
- [When to use it](#when-to-use-it)
- [Install](#install)
- [Usage](#usage)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Tools](#tools)
- [Tool error handling](#tool-error-handling)
- [Safety guarantees](#safety-guarantees)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Development](#development)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

---

## What it does

`dsh-doctor` covers three independent recovery jobs:

### 1. Web boot recovery (60-second budget)

`dsh web` is just a Node process; most boot failures are caused by a third-party plugin: a `cordis.patch.yml` row that points at a broken package, a schema mismatch, a `Cannot find module` after an upgrade, a duplicate `loader entry id`. The watchdog automates the "SSH in, hand-edit YAML, restart" loop with a hard time budget:

1. **Watch** — health-probe `http://127.0.0.1:$DSH_WEB_PORT/health` every `healthIntervalMs` (default 30 s).
2. **Triage** — on three consecutive failures, read the last 200 lines of the boot log and classify the failure against known patterns (`duplicate loader entry id`, `Schema parse error`, `Cannot find module`, `EADDRINUSE`, etc.).
3. **Recover — simple path** (target ≤ 20 s): disable the offending patch row, restart `dsh web`, verify `/health`.
4. **Recover — complex path** (only if simple path misses or budget is exhausted): write a *safe-mode* patch layer that overrides every bundle except a curated allow-list (default: `dsh-core`), restart, verify.
5. **Snapshot** the working bundle set into `last-known-good.json` so future triage has a baseline.
6. **Back off** — recovery attempts are rate-limited (3 per 5 minutes) so a truly broken host is loud, not a tight loop.

The whole flow is engineered to bring `dsh web` back to a usable state within **60 seconds** of the first failed probe.

### 2. CLI doctor (no time budget)

`dsh doctor` is an interactive command for when `dsh web` is **already broken and never came up** — there is no "previous uptime" to recover, so the 60-second budget does not apply. The CLI keeps trying simple paths and only falls back to safe-mode (with a final attempt to disable individual plugin rows) when nothing else works, with **no time limit**:

```
$ dsh doctor
[doctor] reading ~/.dsh/profiles/web/cordis.patch.yml…
[doctor] attempt 1: simple path (disable duplicate-id row for dsh-foo-bar)
[doctor] restart: dsh web --port 3080
[doctor] health: ❌ (1/3) — retrying
[doctor] attempt 2: complex path (safe-mode allow-list: dsh-core)
[doctor] restart: dsh web --port 3080
[doctor] health: ✅ — recovered after 47.2s
```

### 3. Tool error capture (extensible)

`dsh web` invokes dozens of tools a minute. When a tool call fails (transient network error, model error, business error, or an unhandled exception), `dsh-doctor` subscribes to the official `tools/pre-execute` / `tools/execute` / `tools/post-execute` event waterfalls and **classifies** the failure into one of three buckets:

| Bucket | Examples | Default behaviour |
| --- | --- | --- |
| **Transient** (auto-retry) | Network reset, 5xx, 429, `ETIMEDOUT` | Recorded; default policy is to **not** interfere with the current turn — the agent will see the tool's error and decide. |
| **Agent** (defer) | `401`/`403` auth, quota exhausted, unknown model, context overflow | Recorded into a per-session "deferred" queue. The doctor exposes a tool (`dsh_doctor_drain_deferred`) for the next quiet turn to surface them. |
| **Business** (pass through) | `404`/`422`/`409`, validation errors, application throws | Recorded; **never** mutated. The current task is sacred. |

You can plug in your own policy through a small extension point (see [Tool error handling](#tool-error-handling)). The default policy is deliberately conservative: it does not change what the agent sees during a live turn. Recording is opt-out (`toolErrorCapture: false` in config).

---

## When to use it

Use `dsh-doctor` if you:

- Run `dsh web` as your daily driver and have ever come back to a broken state because a plugin update went wrong.
- Operate `dsh web` on a headless host (a small VPS, a Mac mini in a closet) where SSHing in by hand is friction.
- Want plugin installation to be safe to attempt — knowing that even if a plugin breaks the boot, the next minute will be fine again.
- Want a single place to capture and audit tool errors across every session.
- Already use `dsh web` in production for a team and need a recovery story for off-hours.

You do **not** need it if you never install third-party plugins, or if you are happy to fix broken boots by hand.

## Install

### Option A — install with `dsh plugin`, mount as a composition row (recommended)

1. Install the package into the web profile with the official plugin manager:

   ```bash
   dsh plugin --profile web add @d86e/dsh-doctor
   ```

   (needs `pnpm` on `PATH` — enable it once with `corepack enable`.)

2. Restart `dsh web`. The package declares a `dsh.bundle` manifest, so `dsh plugin add` automatically appends it to `dsh.profile.bundles` and it mounts as a bundle layer at boot — you do **not** need (and **must not**) also insert the same row manually into `~/.dsh/profiles/web/cordis.patch.yml`, or boot fails with `duplicate loader entry id: dsh-doctor`.

3. The eight `dsh_doctor_*` tools become available to every agent — ask the agent to run `dsh_doctor_install`. That tool writes the standalone watchdog and registers the platform service.

To upgrade later: `dsh plugin --profile web update @d86e/dsh-doctor` (plus a `dsh_doctor_reinstall` to regenerate the watchdog if its body changed).

> **Why not just `npm install -g`?** The loader imports `name:` rows with Node's ESM resolution anchored at the profile directory (`~/.dsh/profiles/web/`); the global `node_modules` is not on that resolution chain (and `NODE_PATH` does not apply to ESM). The profile's own `node_modules` — managed here by pnpm — is what makes the package reachable.

### Option B — dynamic Cordis plugin (no install)

Paste the compiled `lib/index.js` into the `code.host` field of `cordis_define` and run it. This is how the plugin is developed and verified in a live session: the sandbox supplies the `harness` global, and the file ends with `return plugin;`. The watchdog will still need to be generated by running `dsh_doctor_install` once.

### Permissions

The watchdog manages per-user system services (LaunchAgent plist, systemd unit, Task Scheduler XML) and files under `$DSH_HOME`, so the plugin requests `danger-full-access` for its file and command operations. On a deployment that denies escalation, the tools fail with sandbox denials — you can still run the watchdog by hand from a privileged shell.

## Usage

After installation, the typical first run is:

```text
User: install the doctor watchdog please
Agent: running dsh_doctor_install …
  ✓ generated $DSH_HOME/doctor/watchdog.js
  ✓ registered macOS LaunchAgent com.deepseek-ai.dsh-doctor
  ✓ started watchdog (pid 4242)
  ✓ first health probe OK at 2026-01-15T10:00:00Z
```

A few days later, a plugin update breaks the boot:

```text
[watchdog tick 1042] health probe failed (3/3)
[watchdog] triage: pattern "duplicate loader entry id: dsh-foo-bar"
[watchdog] simple path: disable dsh-foo-bar row in cordis.patch.yml
[watchdog] restart: dsh web --port 3080
[watchdog tick 1043] health probe OK — recovered in 18.4s
```

CLI mode for when `dsh web` is **already** broken and never came up:

```bash
dsh doctor
```

The CLI is a separate entry point that has no time budget. It will keep trying simple paths and only fall back to safe-mode when nothing else works.

Check on it any time:

```text
User: doctor status?
Agent: dsh_doctor_status →
  installed:  yes
  running:    yes (pid 4242, uptime 3d 4h)
  last 5 recoveries:
    2026-01-15 10:00  simple: disabled dsh-foo-bar (18.4s)
    2026-01-12 22:14  complex: safe-mode (because 2 simple attempts failed; 47.2s)
    2026-01-09 03:00  probe-only (auto-recovered within 1 tick)
  tool errors (last hour):
    transient: 14   agent: 0   business: 6   total: 20
```

## Architecture

```
   ┌──────────────────────────────────────────────────────────┐
   │                  $DSH_HOME/doctor/                        │
   │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐ │
   │  │ watchdog.js │  │ last-known-  │  │ safe-mode.patch  │ │
   │  │ (standalone │  │ good.json    │  │ .yml             │ │
   │  │  Node)      │  │              │  │ (complex path)   │ │
   │  └─────────────┘  └──────────────┘  └──────────────────┘ │
   │  ┌────────────────────────────────────────────────────┐  │
   │  │ logs/watchdog.log  ·  logs/doctor.log  ·           │  │
   │  │ logs/tool-errors.log (5 MB × 3)                    │  │
   │  └────────────────────────────────────────────────────┘  │
   │  ┌────────────────────────────────────────────────────┐  │
   │  │ state/  .doctor-installed  .doctor-stopped         │  │
   │  │         .doctor-restart.lock                       │  │
   │  └────────────────────────────────────────────────────┘  │
   └──────────────────────────────────────────────────────────┘
                ▲                                ▲
       platform service              package: @d86e/dsh-doctor
     (LaunchAgent / systemd          (loaded by dsh web; provides
      / Task Scheduler)              8 dsh_doctor_* tools + the
                                     tool-error capture waterfall)
                │                                │
                └──────────── health ────────────┘
                                  │
                       ┌──────────┴──────────┐
                       │  dsh web (3080)    │
                       │  cordis profile    │
                       └────────────────────┘

   ┌──────────────────────────────────────────────────────────┐
   │   CLI:  dsh doctor  ──── no 60s budget, runs to finish  │
   └──────────────────────────────────────────────────────────┘
```

The watchdog is a **standalone Node script** generated at install time:

- dependency-free (only Node built-ins), so it runs even if every `node_modules` is corrupt;
- single-instance lock via `~/.dsh/doctor/.doctor-watchdog.pid`;
- handles `SIGINT` / `SIGTERM` / `SIGHUP` by cleaning up and exiting;
- reads its own config from `~/.dsh/doctor/config.json` (written by `dsh_doctor_install`) so the user's settings survive dsh-doctor upgrades.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full state machine and the failure-recovery decision tree.

## Configuration

Configuration is set in `cordis.patch.yml` (see [cordis.patch.yml](cordis.patch.yml)) and surfaced to the watchdog via `dsh_doctor_install`:

| Key | Default | Meaning |
| --- | --- | --- |
| `healthIntervalMs` | `30000` | Milliseconds between `/health` probes. |
| `healthFailuresToRecover` | `3` | Consecutive failures before triage starts. |
| `recoveryBudgetMs` | `60000` | Hard ceiling on total downtime per incident. |
| `logMaxBytes` | `5242880` | Per-log rotation size (5 MB). |
| `logBackups` | `3` | Number of rotated log files kept. |
| `safeModeBundles` | `['dsh-core']` | Bundles kept enabled in complex-path safe mode. |
| `toolErrorCapture` | `true` | Subscribe to `tools/*` event waterfalls. |
| `toolErrorMaxQueue` | `500` | Max deferred agent errors kept per session before eviction. |

Environment overrides (read by the watchdog at every tick):

| Variable | Effect |
| --- | --- |
| `DSH_WEB_PORT` | Port to probe. Defaults to the value dsh web is currently using. |
| `DSH_HOME` | State directory. Defaults to `~/.dsh`. |
| `DSH_DOCTOR_HEALTH_INTERVAL` | Override `healthIntervalMs` (ms). |
| `DSH_DOCTOR_HEALTH_FAILURES` | Override `healthFailuresToRecover`. |
| `DSH_DOCTOR_BUDGET_MS` | Override `recoveryBudgetMs`. |

## Tools

Eight model-facing tools, all prefixed `dsh_doctor_`:

| Tool | What it does |
| --- | --- |
| `dsh_doctor_install` | Generate `watchdog.js`, register the platform service, start the watchdog. |
| `dsh_doctor_uninstall` | Unregister the platform service, remove state files. Logs are kept unless `purgeLogs=true`. |
| `dsh_doctor_status` | Snapshot: installed, running, last 5 recoveries, uptime, port, current mode, tool-error counts. |
| `dsh_doctor_pause` | Writes `.doctor-stopped` — watchdog skips recovery but still health-probes. |
| `dsh_doctor_resume` | Clears `.doctor-stopped`. |
| `dsh_doctor_diagnose` | One-shot triage of the current failure, no restart. Returns the verdict. |
| `dsh_doctor_safe_mode_enter` | Manually enable the safe-mode patch layer. |
| `dsh_doctor_safe_mode_exit` | Manually disable the safe-mode patch layer. |
| `dsh_doctor_drain_deferred` *(new in 0.1.0)* | Surface the queued "deferred" agent errors to the calling session. |

## Tool error handling

`dsh-doctor` subscribes to the `tools/pre-execute` and `tools/execute` waterfalls that every dsh plugin can hook into. It uses them in a deliberately narrow way:

- **It does not block or retry** a tool call mid-turn. The agent's current task is sacred.
- **It classifies** every error into one of three buckets (see [What it does](#what-it-does-3)).
- **It records** the error (rotating log + optional per-session memory queue).
- **It exposes a tool** (`dsh_doctor_drain_deferred`) for the agent to surface deferred errors when it has a quiet moment.

### Custom policies

If you want to do more than record, register a custom classifier or policy through the `apply()` extension point. The signatures are:

```ts
import type { ToolErrorContext, ToolErrorClass } from '@d86e/dsh-doctor'

export function classifyToolError(ctx: ToolErrorContext): ToolErrorClass {
  if (ctx.error?.message?.includes('rate limit')) return 'transient'
  if (ctx.error?.message?.includes('quota'))     return 'agent'
  return 'business'
}
```

The classifier runs on every `tools/execute` error before the doctor's default classifier; returning `'transient' | 'agent' | 'business'` overrides the default for that call.

## Safety guarantees

- **No broad pkill / killall.** Only the pid recorded in `~/.dsh/profiles/web/.dsh-web.pid` is signaled. If pid discovery fails, the watchdog logs and **skips the kill step** rather than risk killing the user's other services.
- **No writes to `cordis.patch.yml` outside triage.** Every change is staged as a sibling file (e.g. `cordis.patch.yml.doctor-disabled-<id>`) so a manual `dsh plugin update` is not silently overwritten.
- **No remote calls.** No telemetry, no update checks, no "phone home".
- **Bounded retries.** A truly broken host is loud (alarm log + slower ticks) — not a tight loop.
- **60-second downtime budget** is enforced inside the watchdog by a single monotonic timer; the complex path is only entered if the budget allows it, otherwise the safe-mode patch is staged for the next tick.
- **Tool errors are observed, not mutated** by default. The doctor never blocks a tool call mid-turn. Policies are opt-in.
- **Tested against** `@deepseek-ai/dsh-tools` `^0.1.0-rc.6` and `@deepseek-ai/cordis` `^4.0.1`. The plugin refuses to load if the resolved host version does not satisfy the range.

## Troubleshooting

Common issues and how to read `logs/doctor.log` are documented in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). A quick guide:

- `watchdog not running` after install — re-run `dsh_doctor_install`; the platform service may have failed to register (e.g. LaunchAgent on a managed Mac).
- `recovery budget exhausted` — `dsh_doctor_diagnose` will show whether simple path found a candidate. If it didn't, your cordis profile is structurally broken; safe-mode should have engaged.
- Stale `.doctor-restart.lock` after a crashed watchdog — delete the file; the watchdog will not start while it is fresh.
- Tool errors not appearing — check `logs/tool-errors.log`. If empty and you expected captures, verify `toolErrorCapture: true` in `cordis.patch.yml`.

## Roadmap

The v0.1.0 release covers doctor + tool error capture. The following are planned for later versions, gated on dsh host dependency stability:

- **v0.2.0 — Active session watch**: subscribe to `turn/end` and `host/agent-error` events to detect silent timeouts and inject a "继续" prompt. Blocked on being able to `require('@deepseek-ai/dsh-agent')` from a plugin install (currently pnpm isolates dsh host packages under `.pnpm/`, not in root `node_modules`).
- **v0.3.0 — Loop guard**: detect a running turn spinning in place (same tool, same args, same result) and restart it with a configurable message.
- **v0.4.0 — Settings card + browser notifications**: a `web` profile UI for tuning without editing YAML.
- **v1.0.0 — Full replacement of dsh-auto-continue + dsh-daemon scopes** (if the community converges on a single recovery story).

## Development

```bash
git clone https://github.com/d86e/dsh-doctor.git
cd dsh-doctor
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm run build
```

The watchdog source-of-truth lives at `src/watchdog.standalone.ts`; `src/watchdog.ts` reads it, inlines the version stamp, and writes it to `$DSH_HOME/doctor/watchdog.js` at install time. Tests in `tests/watchdog.spec.ts` validate that the generated script is parseable and self-contained.

A live DSH smoke test (requires a real DSH install):

```bash
pnpm test:dsh-smoke
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and feature requests use the templates in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/).

## Security

To report a vulnerability, **do not open a public issue.** See [SECURITY.md](SECURITY.md) for the private contact channel.

## License

[MIT](LICENSE) © 2026 Tommy (d86e)
