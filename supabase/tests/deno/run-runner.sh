#!/bin/bash
# Type-checks the temporary movement runner and runs it under Deno against the LOCAL test database (rebuilt first) and the
# real Nexus service code. Needs: the local cluster on 127.0.0.1:54317, EXTRACT=<warehouse subset folder>,
# NEXUS_NEUTRAL=<extracted neutral/ folder of the nexus-neutral branch>, DENO=<path to deno> (default: deno).
set -e; R=$(cd "$(dirname "$0")" && pwd); D=${DENO:-deno}
"$R/../hosted/build-local.sh"
$D check "$R/../../dev/runner/index.ts"
$D test --allow-env --allow-net=127.0.0.1 --allow-read --allow-sys --no-prompt "$R/runner.test.ts"
