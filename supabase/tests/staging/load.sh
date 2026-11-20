#!/bin/bash
# DESTRUCTIVE to the local "staging" database and the anon/authenticated/service_role/authenticator roles of the
# target cluster. guard.sh refuses unless the target is the dedicated local cluster (see guard.sh).
"$(cd "$(dirname "$0")" && pwd)/guard.sh" || exit 3
# Rebuild the isolated staging DB from the schema-only extract. Local only: 127.0.0.1:54317.
set -e; P="/usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -p 54317 -U postgres -v ON_ERROR_STOP=1 -q"; X=${EXTRACT:?set EXTRACT to the schema-only extract folder}; R=$(cd "$(dirname "$0")" && pwd)
$P -d postgres -c "drop database if exists staging" -c "create database staging"
$P -d postgres -c "drop role if exists anon, authenticated, service_role, authenticator, supabase_admin" 2>/dev/null || true
for f in $R/supabase-shim.sql $X/01_tables.sql $X/02_constraints.sql; do echo "== $f"; $P -d staging -f $f; done
echo "== functions"; PGOPTIONS='-c check_function_bodies=off' $P -d staging -f $X/05_functions.sql
for f in $X/04_indexes.sql $X/03_fkeys.sql $X/06_views.sql $X/07_triggers.sql $X/08_policies.sql $X/09_grants.sql; do echo "== $f"; $P -d staging -f $f; done
$P -d staging -c "create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user()"
echo LOADED
