#!/bin/bash
# Fresh load (guarded) -> stack (Nexus candidate + synthetic pallets) -> harness build (admin login) -> browser run -> stop.
set -u; R="$(cd "$(dirname "$0")/../../.." && pwd)"; E=/tmp/nexus-e2e; mkdir -p $E
"$R/supabase/tests/staging/guard.sh" || exit 3
EXTRACT=${EXTRACT:?set EXTRACT} "$R/supabase/tests/staging/load.sh" | tail -1
node "$R/nexus/test/e2e/stack.mjs" > $E/stack.log 2>&1 & SP=$!
for i in $(seq 1 40); do grep -q READY $E/stack.log && break; sleep 1; done; grep -q READY $E/stack.log || { cat $E/stack.log; kill $SP; exit 1; }
k() { node -e "console.log(require('$E/session.json').keys.$1)"; }; u() { node -e "console.log(require('$E/session.json').users.$1)"; }
cd "$R/nexus"; VITE_SUPABASE_URL=http://127.0.0.1:54331 VITE_SUPABASE_KEY="$(k admin)" VITE_ME="{\"id\":\"$(u admin)\",\"role\":\"shipbay_admin\",\"full_name\":\"Test Admin\"}" OUT="$E/builds/admin" \
  npx --offline vite build --config test/e2e/vite.config.js > $E/build.log 2>&1 || { echo "build failed"; tail -5 $E/build.log; kill $SP; exit 1; }
node test/e2e/run.cjs; code=$?
kill $SP; sleep 1; exit $code
