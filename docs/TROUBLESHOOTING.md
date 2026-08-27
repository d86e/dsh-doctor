# Troubleshooting

A field guide to the things that can go wrong with `dsh-doctor` and how to read its logs.

## Where are the logs?

```
~/.dsh/doctor/logs/watchdog.log   # the watchdog itself — probes, restarts, state transitions
~/.dsh/doctor/logs/doctor.log     # the plugin's tool calls (install/uninstall/status/...)
```

Both are rotated at 5 MB × 3.

## "watchdog is not running"

Symptoms: `dsh_doctor_status` says `running: no`, but the platform service is registered.

Fix:

1. macOS: `launchctl list | grep dsh-doctor` — if absent, re-run `dsh_doctor_install`. If present but not running, `launchctl kickstart -k gui/$(id -u)/com.deepseek-ai.dsh-doctor`.
2. Linux: `systemctl --user status dsh-doctor` — if failed, `journalctl --user -u dsh-doctor -n 100` and look for the actual error. If `systemctl` is unavailable, check the cron fallback (`crontab -l | grep dsh-doctor`).
3. Windows: `schtasks /Query /TN "DshDoctor"`. The watchdog is launched by `wscript.exe`; check the VBS launcher exists at the expected path.

## "recovery budget exhausted"

This is logged at `WARN` level in `watchdog.log`. It means the watchdog entered a recovery but the 60-second budget was spent before `/health` returned 200. Two cases:

- **The simple path misdiagnosed.** Run `dsh_doctor_diagnose` and read the verdict. The likely cause is a new failure pattern the triage engine does not know yet. File an issue with the log line that tripped the unknown.
- **The dsh install itself is broken.** `node --version` is too old, or `~/.dsh/profiles/web/cordis.yml` is structurally invalid. The complex path (safe-mode) should have engaged; if it didn't, the patch was already overridden by something else and the watchdog does not know.

## "stale restart lock"

`$DSH_HOME/doctor/.doctor-restart.lock` exists and is fresh (TTL 120 s). The watchdog respects it and skips recovery — typically because a `dsh_doctor_install` or `_uninstall` is in progress, or a previous watchdog crashed and the lock was not cleaned up. Wait 120 s, or delete the file manually.

## "duplicate loader entry id: dsh-doctor"

You installed `dsh-doctor` via Option A and **also** added a manual `- insert: dsh-doctor` row to `~/.dsh/profiles/web/cordis.patch.yml`. Remove the manual row, keep the `cordis.patch.yml` from the package directory untouched, and restart `dsh web`.

## "watchdog restarts `dsh web` in a tight loop"

The watchdog is in `STATE_ALARM`. The 5-second slow tick keeps it from being a tight loop, but if `/health` is consistently failing, the loop will keep firing. The two most common causes:

- `DSH_WEB_PORT` is wrong. Set it in the environment before running `dsh_doctor_install`, or pass `--port` to `dsh web` so the pid file points to the right port.
- The dsh web log has a new failure mode that the triage engine does not recognise. Run `dsh_doctor_diagnose` for the verdict, and consider filing an issue.

## "complex path keeps firing"

`dsh-doctor` is disabling a row to keep `dsh web` alive, which means there is a real problem with that plugin. The fix is upstream:

1. `dsh_doctor_status` will show the last 5 recoveries; look for a repeated `id`.
2. Either uninstall the plugin (`dsh plugin --profile web remove <pkg>`) or open an issue with the plugin author.
3. The watchdog's snapshot in `last-known-good.json` is updated on every successful recovery, so a stable state is preserved across restarts.

## How to read a recovery log line

```
[watchdog tick 1042] health probe failed (3/3)              ← state transition: HEALTHY → TRIAGE
[watchdog] triage: pattern "duplicate loader entry id: dsh-foo-bar"   ← matched pattern 2
[watchdog] simple path: stage disable for dsh-foo-bar                  ← action plan
[watchdog] restart: dsh web --port 3080                                ← the restart
[watchdog tick 1043] health probe OK — recovered in 18.4s              ← state transition: VERIFY → HEALTHY
```

If the recovery took > 20 s, look at the gap between `restart:` and the next line. If > 60 s, expect a "recovery budget exhausted" line right after.

## How to disable the watchdog temporarily without uninstalling

`dsh_doctor_pause` writes `.doctor-stopped`; the watchdog will keep probing but will not restart. Resume with `dsh_doctor_resume`.

## How to permanently remove

`dsh_doctor_uninstall` unregisters the platform service and removes state files. Then `dsh plugin --profile web remove @d86e/dsh-doctor` to remove the package, and restart `dsh web`.
