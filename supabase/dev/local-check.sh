#!/bin/bash
# Rebuilds the LOCAL test database from a schema extract, applies every candidate, seeds it, seeds it again (must do nothing),
# and runs the regression test. Local cluster only (127.0.0.1:54317); load.sh's guard refuses anything else.
# Usage: EXTRACT=<folder with the warehouse subset> supabase/dev/local-check.sh
set -e; R=$(cd "$(dirname "$0")" && pwd); P="/usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -p 54317 -U postgres -v ON_ERROR_STOP=1 -q -d staging"
"$R/../tests/staging/load.sh" > /dev/null
for f in $(ls "$R"/../candidates/2026*.sql | grep -vE "[.](disable|enable|rollback)[.]sql$"); do $P -f "$f" > /dev/null; done
# the production security repair goes on first, as it would in production: the seed and every check below run on top of it
$P -f "$R/../security/20261122_production_security_repair.sql" > /dev/null
$P -f "$R/seed.sql" 2>&1 | grep -E "NOTICE.*Synthetic|ERROR" || true
$P -f "$R/seed.sql" 2>&1 | grep -E "NOTICE.*Synthetic|ERROR" || true
$P -Atc "select 'seeded: ' || (select count(*) from orgs) || ' brands, ' || (select count(*) from profiles) || ' logins, ' || (select count(*) from skus) || ' products, ' || (select count(*) from locations where shared) || ' shared positions, ' || (select count(*) from inbound_shipments) || ' shipments, ' || (select string_agg(psku || ' ' || status || case when held then ' HOLD' else '' end, ', ' order by psku) from wms_pallets) || ', ' || (select count(*) from wms_cartons) || ' cartons'"
chk=$(/usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -p 54317 -U postgres -q -d staging -f "$R/../security/repair-check.sql" 2>&1 || true); echo "$chk" | grep -E "ROLLBACK-OK|^[A-E] |FAIL|ERROR" | cut -c1-260; echo "$chk" | grep -q "ROLLBACK-OK"
out=$(/usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -p 54317 -U postgres -q -d staging -f "$R/regression.sql" 2>&1 || true)
echo "$out" | grep -oE "ROLLBACK-OK [0-9]+ checks passed|FAIL [0-9]+[^|]*|ERROR:[^|]{0,300}" | head -3
echo "$out" | grep -q "ROLLBACK-OK" 
