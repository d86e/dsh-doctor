---
name: Bug report
about: Something dsh-doctor did was wrong, surprising, or unsafe
title: "[bug] "
labels: ["bug", "needs-triage"]
assignees: []
---

## What happened

A clear and concise description of what the bug is.

## What I expected

What you expected to happen instead.

## Reproduction

Steps to reproduce the behaviour:

1. `dsh plugin --profile web add @d86e/dsh-doctor`
2. `dsh_doctor_install`
3. …

## Environment

- `dsh --version`:
- `node --version`:
- `pnpm --version`:
- OS and version (e.g. macOS 14.5, Ubuntu 24.04, Windows 11):
- `dsh_doctor_status` output (if installed):

## Logs

- Last 200 lines of `~/.dsh/doctor/logs/doctor.log` (paste in a code block, redact any tokens):
- The dsh web boot log line that triggered the failure, if any:

## Severity

- [ ] Blocks me from using `dsh web` at all
- [ ] Workaround exists (please describe)
- [ ] Minor / cosmetic
