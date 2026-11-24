#!/bin/bash
# Stores PSKU-000001 at P-01 in the LOCAL test database, as on shipbay-nexus-dev (the journal commit is done here as the service
# login, in place of the bridge). Local only; used by run-sync.sh before the local API starts.
/usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -p 54317 -U postgres -v ON_ERROR_STOP=1 -q -d staging -c "do \$\$ declare j jsonb; begin perform set_config('request.jwt.claims', json_build_object('sub','5b000000-0000-4000-8000-000000000002','role','authenticated')::text, true); perform set_config('role','authenticated',true); j := wms_putaway_begin('PSKU-000001','P-01'); perform set_config('role','service_role',true); perform wms_nexus_op_commit((j->>'op')::uuid); end \$\$;"
