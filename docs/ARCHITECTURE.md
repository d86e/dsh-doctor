# Architecture

This document expands on the README's overview. It is the canonical reference for the watchdog state machine, the triage decision tree, and the file layout under `$DSH_HOME/doctor/`.

## Scope (v0.1.0)

`dsh-doctor` v0.1.0 covers three independent jobs:

| Job | Time budget | What it does | Where it lives |
| --- | --- | --- | --- |
| **Web boot recovery** | 60 s hard cap | Health-probe `dsh web`, triage the boot log, disable the broken plugin row, restart. | Standalone `watchdog.js` running as a per-user platform service. |
| **CLI doctor** | none | Same triage + recovery primitives, but invoked from a shell, runs to completion (or user Ctrl-C). | `src/cli/` (added in 0.1.0). |
| **Tool error capture** | none (passive) | Subscribe to `tools/pre-execute` / `tools/execute`, classify the failure into transient / agent / business, record to log + memory queue. | In-process, in the plugin's `apply()`. |

Out of scope for 0.1.0 (planned for 0.2.0+ — see `ROADMAP.md` and the README):

- Active session watch (subscribe to `turn/end`, `host/agent-error`, inject a "继续" prompt) — requires `@deepseek-ai/dsh-agent` and `@deepseek-ai/dsh-settings` to be reachable from a plugin install, which pnpm currently isolates under `.pnpm/`.
- Loop guard (same tool, same args, same result) — same dependency story.
- Settings card UI — only available in the `web` profile runtime.

## State machine (watchdog)

```
                    ┌──────────────────────────────────┐
                    │  STATE_BOOTING                   │
                    │  generate config, install marker │
                    └────────────┬─────────────────────┘
                                 │
                                 ▼
                    ┌──────────────────────────────────┐
                    │  STATE_HEALTHY                   │◀──────┐
                    │  tick: probe /health             │       │
                    └────────────┬─────────────────────┘       │
                                 │ (N consecutive failures)    │
                                 ▼                              │
                    ┌──────────────────────────────────┐       │
                    │  STATE_TRIAGE                    │       │
                    │  scan log → pick action plan     │       │
                    └────────────┬─────────────────────┘       │
                                 │                              │
                  ┌──────────────┴───────────────┐              │
                  ▼                              ▼              │
      ┌──────────────────────┐      ┌──────────────────────┐   │
      │  STATE_SIMPLE_FIX    │      │  STATE_COMPLEX_FIX   │   │
      │  disable row, restart │      │  apply safe-mode,    │   │
      │  target ≤ 20s        │      │  restart             │   │
      └────────────┬─────────┘      └────────────┬─────────┘   │
                   │                             │             │
                   └─────────────┬───────────────┘             │
                                 ▼                              │
                    ┌──────────────────────────────────┐       │
                    │  STATE_VERIFY                    │───────┘
                    │  probe /health for ≤ 20s         │
                    └────────────┬─────────────────────┘
                                 │ (probe fails)
                                 ▼
                    ┌──────────────────────────────────┐
                    │  STATE_ALARM                     │
                    │  back off, log loudly, slow tick │
                    └──────────────────────────────────┘
```

The transition from `STATE_TRIAGE` to `STATE_COMPLEX_FIX` is only allowed if the elapsed time since the first failure is below `recoveryBudgetMs` (default 60 s). Otherwise the watchdog stages the safe-mode patch on disk and lets the next tick handle it — preventing a recovery that itself takes too long.

## CLI state machine (dsh doctor)

```
START
  │  read ~/.dsh/profiles/web/{cordis.yml, cordis.patch.yml}
  │  tail logs/dsh-web.log
  ▼
TRIAGE
  │  match against PATTERNS (same as watchdog)
  │  → plan ∈ {disable-row, kill-pid, safe-mode, no-op}
  ▼
RECOVERY LOOP   ◀────────────────────────────┐
  │  execute plan                            │
  │  restart `dsh web` (via process spawn)   │
  │  poll /health with 2s timeout            │
  │  total elapsed > recoveryBudgetMs?       │
  │    no, but /health not OK                │
  │      → try a more aggressive plan        │
  │      (the CLI has no time cap,           │
  │       it tries disable-row → kill-pid →  │
  │       safe-mode → all-bundles-disabled)  │
  │                                          │
  ▼                                          │
SUCCESS (health OK) ─────────────────────────┘
  │
  ▼
END
```

The CLI differs from the watchdog in two ways:

1. **No 60-second budget.** The CLI runs to completion; the only exit conditions are `/health` returning 200 or every plan tried. This is appropriate because the user's previous web session was already broken — there is no "downtime" to bound.
2. **Aggressive fallback.** When disable-row and kill-pid do not work, the CLI tries safe-mode; if safe-mode still does not boot, the CLI writes a final patch that disables every `- insert:` row except the doctor's own. The user is then asked to either accept that state or to repair by hand.

## Triage decision tree

```
log_buffer = read last 200 lines of dsh web log
for pattern in PATTERNS (in priority order):
    if pattern.matches(log_buffer):
        return pattern.action
return Action.UNKNOWN  // simple path: do not restart; complex path: safe-mode
```

Pattern priority (highest first):

1. `EADDRINUSE` — kill only the recorded pid, then simple path.
2. `duplicate loader entry id: <id>` — simple path: disable that row.
3. `Schema parse error.*<id>` — simple path: disable that row.
4. `Cannot find module '<pkg>'` — simple path: mark as broken-deps, disable row.
5. Generic stack that names a plugin id — simple path: disable that row.
6. `UNKNOWN` — skip simple path, go directly to complex path.

The priority order is important: an `EADDRINUSE` after a fresh install is almost always an orphan pid; jumping to "disable the latest plugin" first is a worse misdiagnosis.

## File layout under `$DSH_HOME/doctor/`

```
$DSH_HOME/doctor/
├── watchdog.js                 # generated, single-file, dep-free
├── config.json                 # snapshot of plugin Config at install time
├── last-known-good.json        # last successful bundle set
├── safe-mode.patch.yml         # generated, used by complex path
├── .doctor-installed           # presence marker
├── .doctor-stopped             # user-paused marker (optional)
├── .doctor-restart.lock        # in-progress restart (TTL 120 s)
├── .doctor-watchdog.pid        # watchdog pid
├── logs/
│   ├── watchdog.log            # rotated 5 MB × 3
│   ├── doctor.log              # rotated 5 MB × 3
│   ├── dsh-web.log             # mirror of the dsh web stdout/stderr
│   └── tool-errors.log         # rotated 5 MB × 3
├── state/
│   └── (none yet — reserved for future use)
└── platform/                   # generated, platform-specific
    ├── com.deepseek-ai.dsh-doctor.plist   (macOS)
    ├── dsh-doctor.service                 (systemd)
    └── DshDoctorTask.xml + .vbs           (Windows)
```

## Recovery invariants

- **At most 3 recovery attempts per 5 minutes** (watchdog only). Beyond that, the watchdog enters `STATE_ALARM` and ticks at 5 s instead of the configured interval. The CLI has no such limit.
- **A watchdog restart that takes longer than `recoveryBudgetMs` is abandoned mid-flight.** The watchdog writes an alarm log and waits for the next tick — a watchdog that itself becomes the bottleneck is worse than a slow human.
- **The watchdog never edits the live `cordis.patch.yml` directly.** All triage changes are staged as sibling files (`cordis.patch.yml.doctor-disabled-<id>`) so a manual `dsh plugin update` is not clobbered. The watchdog activates a change by renaming a sibling file in place under a single rename call (atomic on POSIX, near-atomic on Windows).
- **The watchdog never runs `pkill`, `killall`, or any broad-kill command.** It only signals the pid recorded in `~/.dsh/profiles/web/.dsh-web.pid`. If that file is missing or stale, the watchdog logs and skips the kill step.

## Tool error capture (in-process)

`dsh-doctor` subscribes to the dsh cordis event waterfalls that every tool dispatch traverses:

```
tool call: model → tools/pre-execute → tools/execute → tools/post-execute
                                              │
                                              ▼
                                  ┌──────────────────────────┐
                                  │ doctor classifier + sink  │
                                  │  bucket ∈ {transient,    │
                                  │             agent,       │
                                  │             business}     │
                                  │  record → tool-errors.log│
                                  │  record → per-session    │
                                  │             memory queue │
                                  └──────────────────────────┘
```

The classification is decided in this order:

1. The user's custom classifier (if registered through the extension point) wins.
2. Otherwise the default classifier — see `src/tool-errors.ts` for the table.
3. Anything not matched by the table is `business` (pass-through, never mutated).

The doctor's default behaviour on every bucket is **observation only** — the waterfall returns `next()` unchanged. The doctor does not block, retry, or rewrite the tool's outcome during a live turn. Deferred (`agent`) errors are kept in a per-session memory queue (default 500 entries, evicted FIFO) for `dsh_doctor_drain_deferred` to surface.

## Why the watchdog is a separate generated script

- The watchdog must survive a `dsh web` that cannot even resolve its own dependencies. The plugin code is loaded by `dsh web`; if the loader is broken, the plugin is unreachable. The watchdog has to be reachable from a clean `node` invocation with no `node_modules` access.
- Upgrades to `dsh-doctor` cannot strand the watchdog on an old version. Each `dsh_doctor_install` (or `_reinstall`) regenerates the standalone script with the current code embedded, so a watchdog upgrade is a *script* upgrade, not a *process* upgrade.
- The watchdog has a single responsibility: keep `dsh web` healthy. Moving it out of the plugin runtime lets the plugin evolve without coupling watchdog correctness to dsh's loader behaviour.

## Why tool error capture stays in-process

- It only needs `tools/pre-execute` / `tools/execute` / `tools/post-execute` — public cordis events that every dsh-tools-based plugin can subscribe to. No host-only deps.
- A separate process for "observation only" would add latency and a serialization boundary for no benefit. The doctor's promise is that the waterfall returns immediately (`next()` unchanged).
- The deferred-queue is per-process (cleared on plugin reload). This is acceptable because the doctor's promise is "available in the *current* session" — cross-session memory is the user's job (or another plugin's).
