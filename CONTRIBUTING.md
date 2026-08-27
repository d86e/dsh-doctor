# Contributing to dsh-doctor

Thanks for your interest in improving `dsh-doctor`. Bug reports, documentation fixes, and small patches are all welcome.

## Project ground rules

- **No telemetry, no update checks, no network calls.** This is a local recovery tool. If your change needs to phone home, it does not belong here.
- **The watchdog must stay dependency-free.** The whole point of `src/watchdog.standalone.ts` is that the generated script runs on any Node ≥ 18 with zero `node_modules`. New code that targets `watchdog.standalone.ts` can only use Node built-ins.
- **Safety over cleverness.** When in doubt, do nothing and log. A watchdog that loops aggressively is worse than no watchdog.
- **Backwards compatibility.** Once a tool name is shipped, it cannot be removed. Adding parameters is fine; renaming them is a breaking change.

## Development setup

Requires Node ≥ 18 and pnpm 9 (Corepack will fetch it automatically).

```bash
git clone https://github.com/d86e/dsh-doctor.git
cd dsh-doctor
corepack enable
pnpm install
```

Common scripts:

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | TypeScript strict check. Must pass. |
| `pnpm test` | Vitest unit tests. Must pass. |
| `pnpm test:watch` | Watch-mode tests while you iterate. |
| `pnpm run build` | Emit `lib/` from `src/`. CI also runs this. |
| `pnpm test:dsh-smoke` | Live DSH install + boot smoke (requires a real DSH). |

## Pull request flow

1. Fork and branch from `main`.
2. Make your change with tests where applicable. The triage engine (`src/triage.ts`) and the watchdog body (`src/watchdog.standalone.ts`) are the two areas most worth covering.
3. Run `pnpm typecheck && pnpm test` locally.
4. Open a PR with a clear description of the problem and the fix. Screenshots / log excerpts are welcome.
5. Address review feedback. Squash-merge is enabled on `main`, so feel free to commit incrementally.

## Adding a triage pattern

1. Add a `Pattern` entry to `src/triage.ts`. The matcher is plain regular expression over a log buffer; keep it small and specific.
2. Add a fixture to `tests/triage.spec.ts` that exercises both the positive and negative match.
3. Update the README "What it does" section and CHANGELOG.

## Reporting bugs

Use the bug report template. Include:

- `dsh --version`
- `node --version`
- Output of `dsh_doctor_status` (if installed)
- The last 200 lines of `$DSH_HOME/doctor/logs/doctor.log`
- The dsh web log line that triggered the failure (if any)

## Releasing

`dsh-doctor` follows semver. The maintainer (`@d86e`) cuts a release by:

1. Bumping `version` in `package.json`.
2. Adding a `CHANGELOG.md` section.
3. `git tag -a vX.Y.Z -m "vX.Y.Z"` and `git push --tags`.
4. `gh release create vX.Y.Z --notes-file CHANGELOG.md`.

The npm publish step is opt-in (and out of scope for v0.1.0).

## Code of conduct

This project follows the [Contributor Covenant v2.1](CODE_OF_CONDUCT.md). Be patient, be kind, assume good faith.
