## What

A short summary of the change.

## Why

Link the issue or describe the motivation.

## How

A few bullet points on the technical approach (especially for triage / watchdog changes).

## Testing

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] New test added (if behaviour change)
- [ ] `CHANGELOG.md` updated

## Risk

- [ ] Touches the watchdog body (`src/watchdog.standalone.ts`) — needs extra care
- [ ] Adds a new triage pattern — needs a fixture
- [ ] Changes a tool signature — backwards-compatible?
- [ ] Otherwise low-risk
