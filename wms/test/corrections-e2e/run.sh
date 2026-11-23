#!/bin/bash
# Fresh local database built the way shipbay-nexus-dev is (guarded) -> PSKU-000001 put away at P-01 as on dev -> stack with the
# four synthetic logins -> the whole WMS app built with the Pallets screen on (this build only) -> browser run -> stop.
# Usage: EXTRACT=<warehouse subset folder> wms/test/corrections-e2e/run.sh        Local only; reaches nothing hosted.
set -u; R="$(cd "$(dirname "$0")/../../.." && pwd)"; E=${E2E_OUT:-/tmp/corrections-e2e}; mkdir -p "$E"; export E2E_OUT="$E"
"$R/supabase/tests/staging/guard.sh" || exit 3
EXTRACT=${EXTRACT:?set EXTRACT} "$R/supabase/tests/hosted/build-local.sh" | tail -1
/usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -p 54317 -U postgres -v ON_ERROR_STOP=1 -q -d staging -c "do \$\$ declare j jsonb; begin perform set_config('request.jwt.claims', json_build_object('sub','5b000000-0000-4000-8000-000000000002','role','authenticated')::text, true); perform set_config('role','authenticated',true); j := wms_putaway_begin('PSKU-000001','P-01'); perform set_config('role','service_role',true); perform wms_nexus_op_commit((j->>'op')::uuid); end \$\$;" || exit 1
node "$R/wms/test/corrections-e2e/stack.mjs" > "$E/stack.log" 2>&1 & SP=$!
for i in $(seq 1 30); do grep -q READY "$E/stack.log" && break; sleep 1; done; grep -q READY "$E/stack.log" || { cat "$E/stack.log"; kill $SP; exit 1; }
cd "$R/wms"; VITE_SUPABASE_URL=http://127.0.0.1:54331 VITE_SUPABASE_KEY="$(node -e "console.log(require('$E/session.json').keys.anon)")" VITE_PALLET_SCREEN=1 OUT="$E/build" \
  npx --offline vite build --config test/corrections-e2e/vite.config.js > "$E/build.log" 2>&1 || { echo "build failed"; tail -5 "$E/build.log"; kill $SP; exit 1; }
node test/corrections-e2e/run.cjs; code=$?
kill $SP; sleep 1; exit $code
