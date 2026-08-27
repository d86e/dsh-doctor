# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x   | ✅ Active development — security fixes shipped promptly. |
| < 0.1.0 | ❌ Not supported. Please upgrade. |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Email `d86e@users.noreply.github.com` with:

- A short description of the issue and its impact.
- A reproducible proof-of-concept (snippet, command sequence, or patch file).
- The version of `dsh-doctor` affected (output of `pnpm list @d86e/dsh-doctor` or `cat node_modules/@d86e/dsh-doctor/package.json | jq .version`).
- The host environment: OS, Node version, dsh version.

You will receive an acknowledgement within **72 hours**. A fix (or a workaround
and a timeline) will be discussed privately before any public disclosure.

## Threat model

`dsh-doctor` is a **local recovery tool** with these trust assumptions:

- The host user is the only actor. There is no network surface to attack.
- The watchdog runs with the same privileges as the user that installed it. It
  manages per-user system services (LaunchAgent / systemd / Task Scheduler) and
  files under `$DSH_HOME`; a malicious local user could already do that by hand.
- Plugin triage reads the dsh web boot log and the `cordis.patch.yml` file. It
  writes back **sibling** files (`*.doctor-disabled-*`) rather than editing the
  live patch file, so an attacker who controls the boot log cannot directly
  mutate dsh's boot configuration.

Out of scope:

- Vulnerabilities in `dsh` itself (`@deepseek-ai/dsh-tools`, `@deepseek-ai/cordis`).
  Please report those upstream.
- Vulnerabilities in third-party plugins installed alongside `dsh-doctor`.

## Hardening tips

- Restrict who can read `$DSH_HOME/doctor/` (defaults to `0600` for the
  watchdog script and `0700` for the directory).
- Use the safe-mode allow-list (`safeModeBundles`) to keep only bundles you
  trust; the watchdog will fall back to that allow-list in complex-path recovery.
- If you operate a shared host, `dsh_doctor_pause` is the right move while a
  user is debugging a custom plugin — the watchdog will keep probing but will
  not restart.
