#!/bin/bash
# The store-sync test and the MVP API test: builds the local database with every candidate, starts the local API (PostgREST behind a small gateway,
# wms/test/corrections-e2e/stack.mjs), and runs supabase/tests/deno/sync.test.ts under Deno as the service login.
# Needs: the local cluster on 127.0.0.1:54317, EXTRACT=<warehouse subset folder>, DENO=<path to deno> (default: deno).
set -e; R=$(cd "$(dirname "$0")" && pwd); ROOT="$R/../../.."; D=${DENO:-deno}
export E2E_OUT=${E2E_OUT:-$(mktemp -d)}
"$R/../hosted/build-local.sh" > /dev/null; "$R/putaway-psku1.sh" > /dev/null; /usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -p 54317 -U postgres -v ON_ERROR_STOP=1 -q -d staging -f "$R/stage-mvp-http.sql" > /dev/null
node "$ROOT/wms/test/corrections-e2e/stack.mjs" > "$E2E_OUT/stack.log" 2>&1 & SP=$!; trap 'kill $SP 2>/dev/null' EXIT
for i in $(seq 1 40); do grep -q READY "$E2E_OUT/stack.log" && break; sleep 1; done
grep -q READY "$E2E_OUT/stack.log" || { cat "$E2E_OUT/stack.log"; exit 1; }
SESSION="$E2E_OUT/session.json" $D test --no-check --allow-env --allow-net=127.0.0.1 --allow-read --no-prompt "$R/sync.test.ts" "$R/mvp-http.test.ts"
