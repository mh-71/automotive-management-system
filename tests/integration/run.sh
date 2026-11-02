#!/usr/bin/env bash
# ============================================================
# tests/integration/run.sh — Worker + local D1 integration run
# ------------------------------------------------------------
# Starts `wrangler dev --local`, seeds fixture rows into the LOCAL
# D1 file, runs tests/integration/api.test.mjs over real HTTP, then
# removes every fixture row and stops the Worker.
#
# LOCAL ONLY, by construction:
#   * every wrangler call here passes --local
#   * --remote is never used, and is rejected if passed in
#   * the binding in wrangler.jsonc is taqwa-local, whose database_id
#     is the "local-development-only" placeholder
#   * nothing here deploys
#
# Cleanup runs from an EXIT trap, so fixture rows are removed even if
# a test fails, the suite throws, or the run is interrupted.
#
# Usage:  npm run test:integration          (or: bash tests/integration/run.sh)
# Env:    PORT=8788 npm run test:integration
# ============================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PORT="${PORT:-8787}"
DB="taqwa-local"
BASE="http://127.0.0.1:${PORT}"
# The Worker refuses every write unless API_TOKEN is configured (C-9 fails
# closed), so the test Worker is started with one. It is passed on the command
# line rather than written into wrangler.jsonc, and it is openly a test value:
# a real secret belongs in `wrangler secret put API_TOKEN`, never in the repo.
# The suite sends this same token, so it authenticates through the real gate
# rather than around it.
TEST_API_TOKEN="taqwa-local-test-token-not-a-secret"
# C-12 protects reads as well, and adds a second credential: a browser signs
# in with a passphrase and is given a signed cookie. Both are configured here
# so the suite can exercise both through the real gate. Both are openly test
# values; a real one belongs in `wrangler secret put`, never in the repo.
TEST_PASSPHRASE="taqwa-local-test-passphrase-not-a-secret"
TEST_AUTH_SECRET="taqwa-local-test-signing-key-not-a-secret"
LOG="$(mktemp -t taqwa-worker-XXXXXX.log)"

cd "$ROOT"
export WRANGLER_SEND_METRICS=false

# Refuse to run against anything remote, whatever the caller passed.
for arg in "$@"; do
  if [ "$arg" = "--remote" ]; then
    echo "REFUSED: this suite is local-only. --remote is never valid here." >&2
    exit 2
  fi
done

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
d1() { npx wrangler d1 execute "$DB" --local --command "$1" --json 2>/dev/null | sed -n '/^\[/,$p'; }
d1_file() { npx wrangler d1 execute "$DB" --local --file "$1" --json 2>/dev/null | sed -n '/^\[/,$p'; }

WORKER_PID=""
FOUNDATION_PID=""
UNCONFIGURED_PID=""
SEEDED=0

cleanup() {
  local code=$?
  if [ "$SEEDED" = "1" ]; then
    say "Removing fixture rows"
    d1_file "$HERE/fixtures/cleanup.sql" >/dev/null
    local left
    left=$(d1 "SELECT (SELECT count(*) FROM services WHERE id LIKE 'SRV-9%')
                    + (SELECT count(*) FROM customers WHERE id LIKE 'CUS-9%')
                    + (SELECT count(*) FROM vehicles WHERE id LIKE 'VEH-9%')
                    + (SELECT count(*) FROM mechanics WHERE id LIKE 'MEC-9%')
                    + (SELECT count(*) FROM parts WHERE id LIKE 'PRT-9%')
                    + (SELECT count(*) FROM appointments WHERE id LIKE 'APT-9%')
                    + (SELECT count(*) FROM job_cards WHERE id LIKE 'JOB-9%')
                    + (SELECT count(*) FROM job_card_services WHERE job_card_id LIKE 'JOB-9%')
                    + (SELECT count(*) FROM job_card_parts WHERE job_card_id LIKE 'JOB-9%')
                    + (SELECT count(*) FROM invoices WHERE id LIKE 'INV-9%')
                    + (SELECT count(*) FROM invoice_services WHERE invoice_id LIKE 'INV-9%')
                    + (SELECT count(*) FROM invoice_parts WHERE invoice_id LIKE 'INV-9%')
                    + (SELECT count(*) FROM payments WHERE id LIKE 'PAY-9%')
                    + (SELECT count(*) FROM expenses WHERE id LIKE 'EXP-9%')
                    + (SELECT count(*) FROM inventory_transactions WHERE id LIKE 'STK-9%')
                    + (SELECT count(*) FROM invoice_adjustments)
                    + (SELECT count(*) FROM follow_ups)
                    + (SELECT count(*) FROM follow_up_contacts)
                    + (SELECT count(*) FROM follow_up_tasks)
                    + (SELECT count(*) FROM estimates) + (SELECT count(*) FROM estimate_services)
                    + (SELECT count(*) FROM estimate_parts) + (SELECT count(*) FROM estimate_events)
                    + (SELECT count(*) FROM notifications) + (SELECT count(*) FROM notification_reads)
                    + (SELECT count(*) FROM settings WHERE id = 1) AS n" \
           | grep -oE '"n": *[0-9]+' | grep -oE '[0-9]+')
    # Counters matter as much as rows from C-2 onward: a write test that
    # allocates an id leaves no row behind once it is deleted, but the counter
    # it advanced is invisible to the check above. A non-zero total means a
    # test allocated an id and did not restore it.
    local counters
    counters=$(d1 "SELECT sum(last_value) AS n FROM id_counters" \
           | grep -oE '"n": *[0-9]+' | grep -oE '[0-9]+')
    if [ "${counters:-0}" != "0" ]; then
      echo "  WARNING: id_counters total is ${counters:-?}, expected 0 — a test allocated ids without restoring them" >&2
      [ "$code" = "0" ] && code=1
    fi

    if [ "${left:-x}" = "0" ]; then
      echo "  all fixture rows removed"
    else
      echo "  WARNING: ${left:-?} fixture row(s) still present — remove them before committing" >&2
      [ "$code" = "0" ] && code=1
    fi
  fi

  if [ -n "$UNCONFIGURED_PID" ]; then
    kill -- "-$UNCONFIGURED_PID" 2>/dev/null || kill "$UNCONFIGURED_PID" 2>/dev/null
    wait "$UNCONFIGURED_PID" 2>/dev/null
  fi
  if [ -n "$FOUNDATION_PID" ]; then
    kill -- "-$FOUNDATION_PID" 2>/dev/null || kill "$FOUNDATION_PID" 2>/dev/null
    wait "$FOUNDATION_PID" 2>/dev/null
  fi

  if [ -n "$WORKER_PID" ]; then
    say "Stopping Worker"
    # Negative pid = the whole process group that setsid created.
    kill -- "-$WORKER_PID" 2>/dev/null || kill "$WORKER_PID" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8; do kill -0 "$WORKER_PID" 2>/dev/null || break; sleep 1; done
    kill -9 -- "-$WORKER_PID" 2>/dev/null
    kill -9 "$WORKER_PID" 2>/dev/null
    wait "$WORKER_PID" 2>/dev/null
    sleep 1

    local stray
    stray=$(pgrep -f "workerd serve .*:$PORT" 2>/dev/null)
    [ -n "$stray" ] && { echo "  reaping stray workerd: $stray"; kill -9 $stray 2>/dev/null; sleep 1; }

    if curl -s -m 2 -o /dev/null "$BASE/api/health"; then
      echo "  WARNING: something is still listening on port $PORT" >&2
      [ "$code" = "0" ] && code=1
    else
      echo "  port $PORT free"
    fi
  fi
  rm -f "$LOG"
  exit $code
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------- start
say "Starting Worker on port $PORT (local D1)"
# setsid puts wrangler in its own process group, so the EXIT trap can signal
# the whole tree. wrangler spawns workerd as a grandchild, and killing only the
# parent leaves workerd alive and holding the port.
setsid npx wrangler dev --local --port "$PORT" \
  --var "API_TOKEN:$TEST_API_TOKEN" \
  --var "AUTH_PASSPHRASE:$TEST_PASSPHRASE" \
  --var "AUTH_SECRET:$TEST_AUTH_SECRET" > "$LOG" 2>&1 &
WORKER_PID=$!

for _ in $(seq 1 45); do
  curl -s -m 2 -o /dev/null "$BASE/api/health" && break
  kill -0 "$WORKER_PID" 2>/dev/null || { echo "Worker exited during startup:" >&2; tail -20 "$LOG" >&2; exit 1; }
  sleep 1
done
curl -s -m 2 -o /dev/null "$BASE/api/health" || { echo "Worker did not become ready:" >&2; tail -20 "$LOG" >&2; exit 1; }
echo "  ready"

if ! curl -s "$BASE/api/health" | grep -q '"migrated": true'; then
  echo "Schema is not applied to the local database. Run: npm run db:migrate:local" >&2
  exit 1
fi
echo "  schema applied"

# ------------------------------------------------------- safety preflight
# The suite asserts exact row counts, so it needs these three tables to hold
# nothing but the fixtures. Refusing here also means the run can never delete
# rows it did not create.
#
# settings matters most here. Every other fixture hides in a reserved `9%` id
# range that cannot collide with real data, but settings is capped at a single
# row by CHECK (id = 1), so the fixture row and a real one are the same row.
# This count is the only thing standing between the suite and a shop's own
# saved settings: if the table holds anything, the run refuses rather than
# overwriting it.
#
# id_counters is in the sum for the same reason, and it is what makes the
# counter reset in cleanup.sql safe: the run starts only when every counter is
# already 0, so putting them back to 0 afterwards restores exactly the state
# found, never a real shop's sequence.
say "Checking the local database is clear"
COUNTS=$(d1 "SELECT (SELECT count(*) FROM services) + (SELECT count(*) FROM customers) + (SELECT count(*) FROM vehicles) + (SELECT count(*) FROM mechanics) + (SELECT count(*) FROM parts) + (SELECT count(*) FROM appointments) + (SELECT count(*) FROM job_cards) + (SELECT count(*) FROM job_card_services)
                    + (SELECT count(*) FROM job_card_parts) + (SELECT count(*) FROM invoices)
                    + (SELECT count(*) FROM invoice_services) + (SELECT count(*) FROM invoice_parts)
                    + (SELECT count(*) FROM payments) + (SELECT count(*) FROM expenses)
                    + (SELECT count(*) FROM inventory_transactions)
                    + (SELECT count(*) FROM invoice_adjustments)
                    + (SELECT count(*) FROM follow_ups)
                    + (SELECT count(*) FROM follow_up_contacts)
                    + (SELECT count(*) FROM follow_up_tasks)
                    + (SELECT count(*) FROM estimates) + (SELECT count(*) FROM estimate_services)
                    + (SELECT count(*) FROM estimate_parts) + (SELECT count(*) FROM estimate_events)
                    + (SELECT count(*) FROM staff)
                    + (SELECT count(*) FROM user_accounts)
                    + (SELECT count(*) FROM attendance)
                    + (SELECT count(*) FROM notifications) + (SELECT count(*) FROM notification_reads)
                    + (SELECT count(*) FROM settings)
                    + (SELECT sum(last_value) FROM id_counters) AS n" \
         | grep -oE '"n": *[0-9]+' | grep -oE '[0-9]+')
if [ "${COUNTS:-x}" != "0" ]; then
  cat >&2 <<MSG
REFUSED: the fixture tables (services/customers/vehicles/mechanics/parts/
appointments/job_cards/invoices/line tables/payments/expenses/settings/
inventory_transactions) already hold rows, or id_counters is not at zero:
${COUNTS:-?}.

This suite asserts exact counts, so it only runs against an empty local
database, and it will not delete rows it did not insert. Clear the local
database yourself first, or point PORT/wrangler at a scratch one.
MSG
  exit 1
fi
echo "  empty — safe to seed"

# ----------------------------------------------------------------- seed
say "Seeding fixtures"
SEEDED=1
d1_file "$HERE/fixtures/seed.sql" | grep -q '"success": true' || { echo "Seeding failed" >&2; exit 1; }
echo "  6 services, 2 customers, 2 vehicles, 3 mechanics, 3 parts, 6 appointments,"
  echo "  4 job cards (4 service lines, 2 part lines),"
  echo "  4 invoices (4 service lines, 2 part lines), 5 payments, 5 expenses,"
  echo "  5 inventory transactions, 1 settings row (the singleton, id = 1)"

# ------------------------------------------------------------------ run
say "Running tests/integration/api.test.mjs"
TAQWA_API_BASE="$BASE" TAQWA_API_TOKEN="$TEST_API_TOKEN" \
  TAQWA_PASSPHRASE="$TEST_PASSPHRASE" node "$HERE/api.test.mjs"
RESULT=$?

# ------------------------------------------------- write foundation (C-1)
# src/lib/write.js has two behaviours that only a real database can show:
# that a failed env.DB.batch() rolls everything back, and that
# UPDATE ... RETURNING hands concurrent callers distinct numbers. C-1 ships
# no write route, so they are exercised through a TEST-ONLY Worker entry on a
# second port, bound to the same local D1. Nothing here is registered in
# src/index.js and nothing here is deployed.
FOUNDATION_PORT=$((PORT + 1))
FOUNDATION_BASE="http://127.0.0.1:${FOUNDATION_PORT}"
say "Running tests/integration/foundation-worker.mjs (test-only entry, port $FOUNDATION_PORT)"
setsid npx wrangler dev --local --port "$FOUNDATION_PORT" --config "$ROOT/wrangler.jsonc" \
  "$HERE/foundation-worker.mjs" > "$LOG.foundation" 2>&1 &
FOUNDATION_PID=$!
for _ in $(seq 1 45); do
  curl -s -m 2 -o /dev/null "$FOUNDATION_BASE/" && break
  sleep 1
done
FOUNDATION_JSON=$(curl -s -m 60 "$FOUNDATION_BASE/")
if [ -z "$FOUNDATION_JSON" ]; then
  echo "  foundation worker did not answer:" >&2
  tail -20 "$LOG.foundation" >&2
  RESULT=1
else
  node -e '
    const r = JSON.parse(process.argv[1]);
    r.lines.forEach(l => console.log(l));
    console.log(`\nWrite foundation integration: ${r.pass} passed, ${r.fail} failed`);
    process.exit(r.fail ? 1 : 0);
  ' "$FOUNDATION_JSON" || RESULT=1
fi
rm -f "$LOG.foundation"

# ------------------------------------------------- fail closed (C-9)
# The one authentication behaviour the main Worker cannot show, because it IS
# configured: what an UNCONFIGURED Worker does. A missing API_TOKEN must never
# mean "allow everything" -- that is the bug that ships an open API the first
# time a secret is forgotten. So a third Worker is started on another port with
# NO --var, and asked to write.
UNCONFIGURED_PORT=$((PORT + 2))
UNCONFIGURED_BASE="http://127.0.0.1:${UNCONFIGURED_PORT}"
say "Checking a Worker with no API_TOKEN fails closed (port $UNCONFIGURED_PORT)"
setsid npx wrangler dev --local --port "$UNCONFIGURED_PORT" \
  --config "$ROOT/wrangler.jsonc" > "$LOG.unconfigured" 2>&1 &
UNCONFIGURED_PID=$!
for _ in $(seq 1 45); do
  curl -s -m 2 -o /dev/null "$UNCONFIGURED_BASE/api/health" && break
  sleep 1
done

UNCONF_FAILED=0
uncheck() {  # name, expected, actual
  if [ "$2" = "$3" ]; then
    echo "  PASS  $1"
  else
    echo "  FAIL  $1 -- expected $2, got $3" >&2
    UNCONF_FAILED=1
  fi
}

# Health stays public -- it is how an operator sees the Worker is up, and it
# reads no business data.
uncheck "health still answers with no secret configured" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$UNCONFIGURED_BASE/api/health")"
# C-12: a READ is refused too. The original intent -- an unconfigured Worker
# must never be an OPEN one -- now covers the customer list as well as the
# writes, which is the whole point of the phase.
uncheck "   ...but a collection read is refused" 503 \
  "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$UNCONFIGURED_BASE/api/customers")"
uncheck "   ...and so is the settings singleton" 503 \
  "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$UNCONFIGURED_BASE/api/settings")"
# Signing in is impossible without a configured passphrase, and says so as a
# server fault rather than pretending the passphrase was merely wrong.
uncheck "   ...and signing in is refused as a configuration fault" 503 \
  "$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST \
      -H 'content-type: application/json' -d '{"passphrase":"anything"}' \
      "$UNCONFIGURED_BASE/api/session")"

# Every write is refused, with or without a token, and never allowed.
for probe in \
  "POST /api/customers" \
  "PUT /api/settings" \
  "POST /api/payments" \
  "POST /api/invoices" \
  "DELETE /api/customers/CUS-9001" \
  "POST /api/job-cards/JOB-9003/status"; do
  set -- $probe
  uncheck "$1 $2 is refused, never allowed" 503 \
    "$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X "$1" \
        -H 'content-type: application/json' -d '{"probe":true}' "$UNCONFIGURED_BASE$2")"
  uncheck "   ...and refused with a token too, since none can be right" 503 \
    "$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X "$1" \
        -H 'content-type: application/json' -H "authorization: Bearer $TEST_API_TOKEN" \
        -d '{"probe":true}' "$UNCONFIGURED_BASE$2")"
done

UNCONF_BODY=$(curl -s -m 10 -X POST -H 'content-type: application/json' \
  -d '{"name":"Ghost","phone":"01900-000000"}' "$UNCONFIGURED_BASE/api/customers")
case "$UNCONF_BODY" in
  *auth_not_configured*) echo "  PASS  the refusal names a server configuration error" ;;
  *) echo "  FAIL  unexpected body: $UNCONF_BODY" >&2; UNCONF_FAILED=1 ;;
esac
case "$UNCONF_BODY" in
  *API_TOKEN*) echo "  FAIL  the response names the secret binding" >&2; UNCONF_FAILED=1 ;;
  *) echo "  PASS  and names no secret" ;;
esac
# Nothing it refused may have been written.
GHOSTS=$(d1 "SELECT count(*) AS n FROM customers WHERE name = 'Ghost'" \
  | grep -oE '"n": *[0-9]+' | grep -oE '[0-9]+')
uncheck "   ...and wrote nothing" 0 "${GHOSTS:-unknown}"

[ "$UNCONF_FAILED" = "0" ] || RESULT=1
kill -- "-$UNCONFIGURED_PID" 2>/dev/null || kill "$UNCONFIGURED_PID" 2>/dev/null
wait "$UNCONFIGURED_PID" 2>/dev/null
UNCONFIGURED_PID=""
rm -f "$LOG.unconfigured"

sleep 2   # let the Worker flush the tail of its request log
say "Worker status codes served"
grep -oE '(GET|POST|PUT|DELETE|PATCH|HEAD) [^ ]+ [0-9]{3}' "$LOG" | awk '{print $3}' | sort | uniq -c | sed 's/^/ /'
if grep -qE ' 5[0-9]{2} ' "$LOG"; then
  echo "  WARNING: the Worker served a 5xx" >&2
  RESULT=1
fi

exit $RESULT
