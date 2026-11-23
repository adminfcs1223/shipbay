#!/bin/bash
# Rebuilds the LOCAL test database the way shipbay-nexus-dev was built: schema extract, every candidate, the production
# security repair, seed.sql, then the two movement files this suite adds. Local cluster only (127.0.0.1:54317): load.sh's
# guard refuses anything else. Usage: EXTRACT=<warehouse subset folder> supabase/tests/hosted/build-local.sh
set -e; R=$(cd "$(dirname "$0")" && pwd); P="/usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -p 54317 -U postgres -v ON_ERROR_STOP=1 -q -d staging"
"$R/../staging/load.sh" > /dev/null
for f in $(ls "$R"/../../candidates/2026*.sql | grep -vE "[.](disable|enable|rollback)[.]sql$"); do $P -f "$f" > /dev/null 2>&1; done
$P -f "$R/../../security/20261122_production_security_repair.sql" > /dev/null
for f in seed.sql movement-dev.sql seed-movement.sql seed-movement.sql; do $P -f "$R/../../dev/$f" > /dev/null 2>&1; done
$P -Atc "select 'local database ready: ' || (select string_agg(psku || ' ' || status || case when held then ' HOLD' else '' end, ', ' order by psku) from wms_pallets) || '; ledger rows ' || (select count(*) from inventory_moves) || '; orders ' || (select count(*) from orders)"
