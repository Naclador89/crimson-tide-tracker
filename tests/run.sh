#!/usr/bin/env bash
#
# Runs the whole suite:
#
#   1. Unit tests for cycle-core.js, once per timezone. The timezone loop is
#      not optional — the bug that shifted every prediction by a day was
#      invisible in UTC, which is what a default CI runner uses.
#   2. Browser tests for the parts a unit test cannot reach: service worker,
#      PWA manifest, notifications, storage recovery, accessibility, rendering.
#      Skipped with a notice when Playwright is not installed.
#
# Usage:  tests/run.sh            all of it
#         tests/run.sh unit       unit tests only (no browser needed)
#         tests/run.sh e2e        browser tests only
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8790}"
WHAT="${1:-all}"
FAILED=0

run_unit() {
  echo "══ Unit — cycle-core.js ══"
  for tz in Europe/Berlin UTC America/New_York Pacific/Auckland America/Sao_Paulo; do
    printf '  %-22s ' "$tz"
    if out=$(TZ="$tz" node --test "$ROOT/tests/core.test.js" 2>&1); then
      echo "$(grep -E '^# pass' <<<"$out" | tr -dc '0-9') passed"
    else
      echo "FAILED"
      echo "$out" | grep -E 'not ok|AssertionError|expected|actual' | head -20 | sed 's/^/      /'
      FAILED=1
    fi
  done
}

run_e2e() {
  echo
  echo "══ Browser — index.html ══"
  if ! command -v python3 >/dev/null; then
    echo "  SKIP: python3 needed to serve the app"
    return
  fi

  python3 -m http.server "$PORT" --directory "$ROOT" >/dev/null 2>&1 &
  local server=$!
  trap 'kill '"$server"' 2>/dev/null' EXIT

  for _ in $(seq 30); do
    curl -sf -o /dev/null "http://localhost:$PORT/index.html" && break
    sleep 0.2
  done
  if ! curl -sf -o /dev/null "http://localhost:$PORT/index.html"; then
    echo "  FAIL: server did not come up on port $PORT"
    FAILED=1
    return
  fi

  for suite in critical medium small icons; do
    echo "  ── $suite ──"
    if BASE_URL="http://localhost:$PORT" node "$ROOT/tests/e2e/$suite.js" 2>&1 | sed 's/^/    /'; then :; else FAILED=1; fi
  done

  kill "$server" 2>/dev/null
  trap - EXIT
}

case "$WHAT" in
  unit) run_unit ;;
  e2e)  run_e2e ;;
  all)  run_unit; run_e2e ;;
  *)    echo "usage: tests/run.sh [unit|e2e|all]"; exit 2 ;;
esac

echo
if [ "$FAILED" -eq 0 ]; then echo "✔ alles grün"; else echo "✘ es gab Fehler"; fi
exit "$FAILED"
