#!/bin/bash
# Lays the temporary runner out the way an Edge Function is deployed: one flat folder, imports rewritten to ./x.js.
# It deploys nothing. Usage: supabase/dev/runner/bundle.sh <empty output folder>   (DENO=<path to deno> to type-check it)
# The three bridge files are copied unchanged; the script stops if a copy differs from the repository file.
set -e; R=$(cd "$(dirname "$0")" && pwd); O=${1:?give an empty output folder}; mkdir -p "$O"; [ -z "$(ls -A "$O")" ] || { echo "REFUSED: $O is not empty"; exit 1; }
B="$R/../../functions/nexus-bridge"
cp "$B/core.js" "$B/pallets.js" "$B/postgrest.js" "$R/../../tests/hosted/suite.js" "$R/index.ts" "$O/"
sed -e "s#'\.\./\.\./functions/nexus-bridge/#'./#" -e "s#'\.\./\.\./tests/hosted/#'./#" "$R/runner.js" > "$O/runner.js"
if grep -n "from '\.\./" "$O"/*.js "$O"/*.ts; then echo "REFUSED: an import still points outside the folder"; exit 1; fi
for f in core.js pallets.js postgrest.js; do cmp -s "$B/$f" "$O/$f" || { echo "REFUSED: $f differs from the bridge's file"; exit 1; }; done
grep -q "sha256: 'CLOSED', notAfter: 0" "$O/index.ts" && echo "gate: CLOSED (set GATE in $O/index.ts at deploy; never commit an open gate)"
if [ -n "$DENO" ]; then "$DENO" check "$O/index.ts"; fi
(cd "$O" && sha256sum core.js pallets.js postgrest.js suite.js runner.js index.ts)
