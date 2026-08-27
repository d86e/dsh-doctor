# dsh-doctor

[![CI](https://github.com/d86e/dsh-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/d86e/dsh-doctor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/dsh-%3E%3D0.1.0--rc.6-0066ff)](https://github.com/deepseek-ai/deepseek-harness)

> Self-healing watchdog for the DeepSeek Harness **web** profile. Recovers from plugin-induced boot failures within a **60-second** downtime budget. Runs an unbounded `dsh doctor` CLI for already-broken installs. Captures every **tool error** through the official `tools/*` event hooks. **Watches every live session** and nudges stuck turns back to life.

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
- [Session watching](#session-watching)
- [Safety guarantees](#safety-guarantees)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Development](#development)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

---

## What it does

Four jobs, in one plugin:

| Job | Where it runs | Time budget | Trigger |
| --- | --- | --- | --- |
| **1. Web boot recovery** | Standalone Node process (LaunchAgent / systemd / Task Scheduler) | **60 seconds** per incident | `dsh web` health probe fails N times in a row |
| **2. CLI doctor** | `dsh doctor` in your shell, drives the same `apply(ctx, config)` code path | **No budget** — keeps trying until solved | You start it |
| **3. Tool error capture** | In-process, attached to the `tools/*` cordis event waterfalls | Passive — never blocks the host | Any tool call fails in any session |
| **4. Live session watch** | In-process, attached to `session/event` | Tick every 30 s, no events lost | A turn is `running` with no new event for `watchIdleThresholdMs` (default 10 min) |

### 1. Web boot recovery (60 s budget)

Every 30 s the watchdog probes `http://127.0.0.1:$DSH_WEB_PORT/health`. After 3 consecutive failures it enters the **triage** state machine, with a hard 60-second ceiling on total downtime per incident.

**Simple path** (~10 s) — the most common case, a single broken plugin:

1. Read the last 200 lines of the dsh web log.
2. Run **triage** against a regex pattern table (EADDRINUSE, duplicate loader entry, schema parse error, module-not-found, plugin load error, …).
3. If the failing bundle is identified, **disable that single row** in `~/.dsh/profiles/web/cordis.patch.yml` (write the change to a sibling `cordis.patch.yml.dr-disabled-<bundle>` file — your original is never edited).
4. Restart dsh web. The boot succeeds because the offending bundle is gone.

**Complex path** (≤60 s) — multiple bundles, the simple path didn't work, or the failure is unknown:

1. Drop a **safe-mode patch** into the profile that overrides every bundle with a no-op config (`safeMode: true`), except an explicit allow-list (`safeModeBundles`, default `["dsh-core"]`).
2. Restart dsh web. The profile boots in safe mode — all your dsh_doctor_* tools are still available, every other plugin is silenced.
3. Write a `restart-lock` marker so a `dsh doctor` invocation running in parallel can skip the 60 s budget and work unbounded until safe mode is gone.

**Invariants** enforced on every recovery:

- The watchdog only kills the PID it reads from `~/.dsh/profiles/web/.dsh-web.pid`. It never invokes `pkill`, `killall`, or any pattern-killer.
- A sibling file pattern means your real `cordis.patch.yml` is never silently mutated. Inspect / revert at any time.
- If 60 s elapses without a healthy probe, the watchdog backs off and retries on the next probe tick instead of thrashing.

### 2. CLI doctor (no time budget)

```
$ dsh doctor
```

Same triage + recovery engine, but:

- Started in the foreground, not as a service.
- The 60-second budget is **disabled**. It keeps iterating (fix → restart → probe → fix → …) until the profile boots cleanly.
- More aggressive fallbacks are allowed because a human is watching: when simple + safe-mode both fail, it will eventually offer to disable **every** non-allow-listed bundle and boot with only the allow-list.
- A "what did you change?" summary is printed at the end so the human can revert anything they don't want.

### 3. Tool error capture

Every tool call in dsh passes through a `tools/*` cordis event waterfall. `dsh-doctor` subscribes to `tools/execute` and `tools/post-execute` and runs every failed result through a **classifier** (default: `transient` / `agent` / `business`) and a **policy** (default: record + log, optionally defer). The doctor never mutates the waterfall itself — it observes.

The 9th model-facing tool, `dsh_doctor_drain_deferred(sessionId)`, lets the agent pull queued errors at a quiet moment in the current turn and decide what to do.

### 4. Live session watch

Every session in the dsh process emits a `session/event` (`turn/start`, `turn/end`, `tool/call`, `tool/result`, `user/message`, `assistant/message`, …). `dsh-doctor` keeps a per-session state machine:

```
                    ┌──────────────┐
                    │  event fires │ ◀── every session event
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  reset idle  │
                    │   counter    │
                    └──────┬───────┘
                           │
              (every watchTickIntervalMs)
                           │
                    ┌──────▼───────────────────┐
                    │ is turn running?         │
                    │ is no-event-time > N?    │
                    │ cooldown elapsed?        │
                    │ nudgesSent < cap?        │
                    │ user is not currently    │
                    │ driving the session?     │
                    └──────┬───────────────────┘
                       yes  │
                    ┌──────▼────────────────────┐
                    │ agent.followup("继续")    │
                    │ count +1                  │
                    └───────────────────────────┘
```

The doctor **does not write code, does not run commands, does not touch the model**. It sends a `继续` user message through the same `agent.followup` primitive the dsh community's `dsh-auto-continue` uses. If the agent is in a true infinite loop, `dsh_doctor_watch_cancel` is also exposed for explicit user intervention.

Manual control tools are also exposed: `dsh_doctor_watch_list` shows every tracked session, `dsh_doctor_watch_nudge` lets you inject a custom message, `dsh_doctor_watch_cancel` aborts the current turn with `kind: 'user'` so it is not confused with a system stop.

---

## When to use it

You want `dsh-doctor` if you:

- Have ever had a bad plugin update take down your `dsh web` for hours because you had to SSH in, read logs, edit JSON, and restart by hand.
- Run multiple plugins and want a layer between "broken plugin" and "completely dead profile."
- Run long, unattended agent tasks that occasionally get stuck waiting on a flaky network call or an interrupted LLM stream.
- Already use `dsh-auto-continue` and want a more thorough, self-contained solution (dsh-doctor subsumes its core logic — keep using both if you depend on its UI; or uninstall it once you upgrade to dsh-doctor ≥ 0.2.0).
- Want **layered protection** alongside `dsh-daemon` (they don't conflict; dsh-doctor also covers the "dsh web came up at all" case).

You do **not** want dsh-doctor if:

- You are on a single-plugin setup and prefer to fix breakage by hand.
- You want an "AI automatically debugs my DSH install" agent — that's a different product. dsh-doctor is a watchdog, not an AI.

---

## Install

### Option A — as a dsh plugin (recommended)

```bash
dsh plugin add @d86e/dsh-doctor
dsh plugin reload
```

This mounts the 12 `dsh_doctor_*` tools. To also enable the standalone watchdog (recommended):

```bash
# Tell the dsh agent to use dsh_doctor_install
> dsh_doctor_install
```

The `install` tool:

1. Writes `~/.dsh/doctor/watchdog.js` (standalone dep-free Node).
2. Writes the platform service spec (LaunchAgent / systemd / Task Scheduler).
3. Starts the service.
4. The service starts probing `127.0.0.1:3080/health` immediately.

### Option B — dynamic (sandboxed one-off)

Useful for a single session, no install. Ask any agent:

```
> Use the dsh doctor from https://raw.githubusercontent.com/d86e/dsh-doctor/v0.2.0/lib/index.js
```

Then call `dsh_doctor_install` when you are ready to make it permanent.

---

## Usage

After install, you can ask the agent:

```
> dsh_doctor_status
> dsh_doctor_diagnose
> dsh_doctor_watch_list
> dsh_doctor_safe_mode_enter
> dsh_doctor_drain_deferred
```

From a shell:

```bash
dsh doctor                  # unbounded CLI doctor (foreground)
dsh doctor --dry-run        # triage only, no writes
```

To uninstall:

```
> dsh_doctor_uninstall
```

---

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full state machine, file layout, and inter-process protocol.

```
┌──────────────────────────────────────────────────────────────┐
│  dsh web process (cordis composition rows)                  │
│                                                              │
│   ┌────────────────────┐  ┌────────────────────┐            │
│   │ tools/ event hooks │  │ session/event hooks│            │
│   └────────┬───────────┘  └─────────┬──────────┘            │
│            │                       │                         │
│            ▼                       ▼                         │
│   ┌──────────────────────────────────────────────┐          │
│   │  dsh-doctor (apply)                          │          │
│   │   ├ tool error capture (waterfall listener)  │          │
│   │   ├ session watch (timer + ctx.agents)       │          │
│   │   └ 12 dsh_doctor_* tools                    │          │
│   └──────────────────────────────────────────────┘          │
└──────────────────────────┬───────────────────────────────────┘
                           │ (file-system state)
                           ▼
  ┌──────────────────────────────────────────────────┐
  │  $DSH_HOME/doctor/                               │
  │   ├ watchdog.js      standalone dep-free script  │
  │   ├ watchdog.pid     current watchdog pid       │
  │   ├ installed-marker  plugin-version stamp      │
  │   ├ stopped-marker   pause flag                 │
  │   ├ safe-mode.patch  auto-generated disable     │
  │   └ logs/                                        │
  │     ├ watchdog.log   (5MB × 3 rotation)         │
  │     ├ doctor.log     (5MB × 3 rotation)         │
  │     └ tool-errors.log                          │
  └──────────────────────────────────────────────────┘
                           ▲
                           │ (HTTP /health probe)
                           │
  ┌────────────────────────┴─────────────────────────┐
  │  watchdog.js (LaunchAgent / systemd / Task Sched) │
  │   - 30 s health probe                             │
  │   - triage + simple/complex recovery              │
  │   - no pkill, no killall, no remote fetch          │
  └────────────────────────────────────────────────────┘
```

---

## Configuration

All knobs can be set either in `cordis.patch.yml` (under `config:`) or via `DSH_DOCTOR_*` environment variables.

| Field | Env var | Default | Description |
| --- | --- | --- | --- |
| `healthIntervalMs` | `DSH_DOCTOR_HEALTH_INTERVAL` | `30000` | Health probe period |
| `healthFailuresToRecover` | `DSH_DOCTOR_HEALTH_FAILURES` | `3` | Failures before triage |
| `recoveryBudgetMs` | `DSH_DOCTOR_BUDGET_MS` | `60000` | Hard ceiling per incident (watchdog) |
| `logMaxBytes` | — | `5242880` | Per-log rotation size |
| `logBackups` | — | `3` | Rotated log files kept |
| `safeModeBundles` | — | `["dsh-core"]` | Bundles kept in safe mode |
| `toolErrorCapture` | `DSH_DOCTOR_TOOL_ERROR_CAPTURE` | `true` | Subscribe to `tools/*` |
| `toolErrorMaxQueue` | `DSH_DOCTOR_TOOL_ERROR_QUEUE` | `500` | Per-session queue cap |
| `watchEnabled` | `DSH_DOCTOR_WATCH_ENABLED` | `true` | Master switch for session watch |
| `watchIdleThresholdMs` | `DSH_DOCTOR_WATCH_IDLE_MS` | `600000` | Idle timeout (10 min) |
| `watchNudgeCooldownMs` | `DSH_DOCTOR_WATCH_COOLDOWN_MS` | `300000` | Min interval between nudges |
| `watchMaxNudgesPerSession` | `DSH_DOCTOR_WATCH_MAX_NUDGES` | `3` | Cap before giving up |
| `watchContinueText` | `DSH_DOCTOR_WATCH_TEXT` | `"继续"` | Text to inject (supports `{elapsed}`, `{turn}`, `{sessionId}`) |
| `watchTickIntervalMs` | `DSH_DOCTOR_WATCH_TICK_MS` | `30000` | Idle-check period |

### Tool error classifier — replace it

If the default classification (network/5xx/429 → `transient`, 401/403/quota/context-overflow → `agent`, else → `business`) is wrong for your stack, pass your own classifier / policy when you register the plugin from a wrapper bundle. Both functions receive the full `ToolErrorContext` and return synchronously.

### Session watch text — localize it

`watchContinueText` accepts the placeholders `{elapsed}` (seconds since last event), `{turn}` (current turn number), `{sessionId}`. So `"已经过去 {elapsed} 了，请继续第 {turn} 步"` works.

---

## Tools

12 model-facing tools, all `dsh_doctor_*` prefixed.

| Tool | Purpose |
| --- | --- |
| `dsh_doctor_install` | Generate the standalone watchdog and platform service |
| `dsh_doctor_uninstall` | Unregister, remove state files (logs optional) |
| `dsh_doctor_status` | Installed? running? uptime? last 5 recoveries? watch snapshot? |
| `dsh_doctor_pause` | Stop recovery, keep probing |
| `dsh_doctor_resume` | Re-enable recovery |
| `dsh_doctor_diagnose` | One-shot triage, no writes |
| `dsh_doctor_safe_mode_enter` | Manually drop a safe-mode patch |
| `dsh_doctor_safe_mode_exit` | Remove the safe-mode patch |
| `dsh_doctor_drain_deferred` | Pull queued agent-class tool errors for a session |
| `dsh_doctor_watch_list` | List every session the doctor is tracking |
| `dsh_doctor_watch_nudge` | Manually inject a "继续" message into a session |
| `dsh_doctor_watch_cancel` | Cancel the current turn of a session (kind=user) |

---

## Tool error handling

By default the doctor **observes** tool errors; it never retries and never mutates the waterfall. To change that, the `installToolErrorCapture` API is exported for wrapper bundles:

```ts
import { installToolErrorCapture, defaultClassify, defaultPolicy } from '@d86e/dsh-doctor/tool-errors'

installToolErrorCapture(ctx, config, log, {
  // user classifier: nil-pointers count as agent-class
  (ctx) => ctx.message.includes('panic') ? 'agent' : null,
}, defaultPolicy)
```

See [`src/tool-errors.ts`](src/tool-errors.ts) for the full contract.

---

## Session watching

The doctor keeps a per-session state machine in-process. It is read-only with respect to the model and the agent's tool calls — the **only** action it takes is `agent.followup({content: [{type: 'text', text: '继续'}], source: {kind: 'user'}})`.

Three protections against over-firing:

1. **Cooldown** — two nudges to the same session must be at least `watchNudgeCooldownMs` apart.
2. **Cap** — a session that has been nudged `watchMaxNudgesPerSession` times in its lifetime is left alone until the next `turn/end:completed`.
3. **User override** — if a real `user/message` (`source.kind === 'user'`) arrived within 5 s of the candidate nudge time, the doctor steps back and assumes the human is driving.

The watch is **degrades silently** if the dsh host does not expose `ctx.agents` (i.e. an older dsh). The 12 tools still work, the watchdog still works — only the in-process nudging is gone.

---

## Safety guarantees

- **No network calls** by the watchdog (it probes `127.0.0.1` only).
- **No `pkill` / `killall`** anywhere. Only the recorded `~/.dsh/profiles/web/.dsh-web.pid` is signaled.
- **No silent mutation** of your `cordis.patch.yml`. Disable / safe-mode actions write to sibling files (`cordis.patch.yml.dr-disabled-<bundle>`, `cordis.patch.yml.dr-safemode`).
- **The watchdog is dep-free** (only `node:fs/path/os/http/child_process/crypto`). It runs even if dsh cannot start its own node_modules.
- **No telemetry**, no analytics, no phone-home.
- **`dsh_doctor_safe_mode_exit` is idempotent** — running it twice is safe.
- **Nudges never modify model state** — they only send a user message through the same primitive the dsh-auto-continue community plugin uses.

---

## Troubleshooting

See [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

---

## Roadmap

Done:

- ✅ **0.2.0** — Live session watch with idle detection + nudge + cancel.
- ✅ **0.1.0** — Web boot recovery, CLI doctor, tool error capture.

Future:

- Optional browser notification bridge (for users running the dsh Web UI).
- Pluggable triage patterns (load your own regex table from a file).
- `dsh_doctor_simulate` — run a fake failure end-to-end against a test profile to validate the watchdog.

---

## Development

```bash
git clone https://github.com/d86e/dsh-doctor
cd dsh-doctor
pnpm install
pnpm test          # 83 unit tests
pnpm run build     # tsc → lib/
pnpm run typecheck
```

`tests/dsh-smoke.sh` is a shell-only smoke that builds → packs → would `dsh plugin add`. It is skipped in CI because the CI host does not have `dsh` installed.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## Security

See [`SECURITY.md`](SECURITY.md). Report vulnerabilities via the GitHub Security tab — do not file a public issue.

---

## License

[MIT](LICENSE) — 2026 Tommy (d86e).
