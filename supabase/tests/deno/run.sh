#!/bin/bash
# Type-checks the Edge Function and runs it under Deno against the LOCAL test database (rebuilt and seeded first).
# Needs: the local cluster on 127.0.0.1:54317, EXTRACT=<warehouse subset folder>, DENO=<path to deno> (default: deno).
set -e; R=$(cd "$(dirname "$0")" && pwd); D=${DENO:-deno}; P="/usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -p 54317 -U postgres -v ON_ERROR_STOP=1 -q -d staging"
"$R/../staging/load.sh" > /dev/null
for f in $(ls "$R"/../../candidates/2026*.sql | grep -vE "[.](disable|enable|rollback)[.]sql$"); do $P -f "$f" > /dev/null 2>&1; done
$P -f "$R/../../dev/seed.sql" > /dev/null 2>&1
$D check "$R/../../functions/nexus-bridge/index.ts"
$D test --allow-env --allow-net=127.0.0.1 --allow-run --allow-read --allow-sys --no-prompt "$R/wrapper.test.ts"
