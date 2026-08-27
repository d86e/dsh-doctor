#!/usr/bin/env bash
# dsh-smoke.sh — fresh DSH profile install + assert doctor tools mount.
#
# This is a best-effort smoke test, not a substitute for live verification.
# It requires a real `dsh` install on PATH. It will:
#   1. Create a temporary DSH_HOME.
#   2. Build the plugin (if not already built).
#   3. Run `dsh plugin --profile web add <source>` — source can be:
#        a. a local tarball path:   scripts/dsh-smoke.sh ./path/to/dsh-doctor.tgz
#        b. a git URL:              scripts/dsh-smoke.sh https://github.com/d86e/dsh-doctor.git
#        c. a git URL with ref:     scripts/dsh-smoke.sh https://github.com/d86e/dsh-doctor.git#v0.2.0
#        d. (no arg) build a local tarball and use it.
#   4. Verify the bundle manifest is registered.
#   5. Start `dsh web` and probe /health.
#   6. Tear everything down.
#
# Exit code 0 = all good. Non-zero = at least one assertion failed.
set -euo pipefail

PLUGIN_DIR="${PLUGIN_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
SOURCE="${1:-}"
SMOKE_TMP="$(mktemp -d -t dsh-doctor-smoke-XXXXXX)"
export DSH_HOME="$SMOKE_TMP/.dsh"
export DSH_WEB_PORT="${DSH_WEB_PORT:-13080}"

cleanup() {
  if [[ -n "${WEB_PID:-}" ]] && kill -0 "$WEB_PID" 2>/dev/null; then
    kill "$WEB_PID" 2>/dev/null || true
    wait "$WEB_PID" 2>/dev/null || true
  fi
  rm -rf "$SMOKE_TMP"
}
trap cleanup EXIT

cd "$PLUGIN_DIR"

# 1. Build.
echo "[smoke] building…"
pnpm --silent run build

# 2. Resolve the install source.
if [[ -n "$SOURCE" ]]; then
  INSTALL_SOURCE="$SOURCE"
else
  echo "[smoke] packing…"
  TARBALL_PATH="$(pnpm --silent pack --pack-destination "$SMOKE_TMP" | tail -1)"
  echo "[smoke] tarball: $TARBALL_PATH"
  INSTALL_SOURCE="$TARBALL_PATH"
fi

# 3. Install into the web profile.
echo "[smoke] dsh plugin --profile web add $INSTALL_SOURCE"
dsh plugin --profile web add "$INSTALL_SOURCE"

# 4. Verify the bundle manifest is wired into the profile.
PROFILE_DIR="$DSH_HOME/profiles/web"
if [[ ! -f "$PROFILE_DIR/cordis.yml" ]] && [[ ! -f "$PROFILE_DIR/cordis.patch.yml" ]]; then
  echo "[smoke] FAIL: no cordis.yml / cordis.patch.yml under $PROFILE_DIR"
  exit 1
fi
echo "[smoke] profile directory looks ok: $PROFILE_DIR"

# 5. Start dsh web.
echo "[smoke] starting dsh web on port $DSH_WEB_PORT…"
( dsh web --port "$DSH_WEB_PORT" >"$SMOKE_TMP/dsh-web.log" 2>&1 ) &
WEB_PID=$!

# 6. Probe /health for up to 30 s.
HEALTH_OK=0
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${DSH_WEB_PORT}/health" >/dev/null 2>&1; then
    HEALTH_OK=1
    echo "[smoke] /health OK after ${i}s"
    break
  fi
  sleep 1
done

if [[ "$HEALTH_OK" -ne 1 ]]; then
  echo "[smoke] FAIL: /health did not return 200 within 30s"
  echo "---- dsh web log ----"
  cat "$SMOKE_TMP/dsh-web.log" || true
  exit 1
fi

echo "[smoke] OK"
