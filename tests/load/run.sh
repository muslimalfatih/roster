#!/usr/bin/env bash
# Runs one k6 script against a FRESH roster_load database on a throwaway port.
#
#   ./tests/load/run.sh booking-last-seat
#   ./tests/load/run.sh payment-failure.js
#
# Exits with k6's exit code, so a violated threshold fails your shell / CI.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

SCRIPT="${1:-}"
[ -n "$SCRIPT" ] || { echo "usage: $0 <booking-last-seat|booking-duplicate|payment-failure>" >&2; exit 2; }
[ "${SCRIPT##*.}" = "js" ] || SCRIPT="$SCRIPT.js"
[ -f "$ROOT/tests/load/$SCRIPT" ] || { echo "no such script: tests/load/$SCRIPT" >&2; exit 2; }

# apps/api/.env holds LOAD_DATABASE_URL, SEAT_HOLD_MINUTES, CORS_ORIGIN.
set -a; [ -f "$ROOT/apps/api/.env" ] && . "$ROOT/apps/api/.env"; set +a
: "${LOAD_DATABASE_URL:?set LOAD_DATABASE_URL in apps/api/.env}"

PORT="${LOAD_PORT:-3999}"
[ "$PORT" != "3000" ] || { echo ":3000 is taken by an unrelated app — pick another LOAD_PORT" >&2; exit 2; }
BASE_URL="http://localhost:$PORT"

API_PID=""
cleanup() { [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null; wait "$API_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM   # the API dies even if k6 fails, throws, or is Ctrl-C'd

echo "==> resetting roster_load"
# Run from $ROOT so bun does not auto-load apps/api/.env and point us at the dev DB.
( cd "$ROOT" && DATABASE_URL="$LOAD_DATABASE_URL" bun apps/api/scripts/reset-db.ts )

echo "==> starting API on $BASE_URL"
( cd "$ROOT" && DATABASE_URL="$LOAD_DATABASE_URL" PORT="$PORT" exec bun apps/api/src/index.ts ) &
API_PID=$!

for _ in $(seq 1 60); do
  curl -sf "$BASE_URL/api/health" >/dev/null && break
  kill -0 "$API_PID" 2>/dev/null || { echo "API died on startup" >&2; exit 1; }
  sleep 0.25
done
curl -sf "$BASE_URL/api/health" >/dev/null || { echo "API never became healthy" >&2; exit 1; }

echo "==> k6 run $SCRIPT"
CODE=0
k6 run -e BASE_URL="$BASE_URL" "$ROOT/tests/load/$SCRIPT" || CODE=$?
echo "==> k6 exit $CODE"
exit "$CODE"
