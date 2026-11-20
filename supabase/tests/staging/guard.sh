#!/bin/bash
# Dedicated-instance guard. load.sh DROPS and recreates the "staging" database and the Supabase roles, so it must only
# ever run on the throwaway local cluster made for it. All three must hold, or nothing runs:
#   1. cluster_name = shipbay-local-staging            (set on the pg_ctl command line when the cluster is started)
#   2. the server answers on 127.0.0.1:54317             (inet_server_addr; a remote server behind a tunnel reports its own)
#   3. the data directory holds the file SHIPBAY_LOCAL_STAGING starting "shipbay-local-staging"
#      (read with pg_read_file: needs superuser on that server, so a hosted database fails this check)
# Start the cluster as:  pg_ctl -D <dir> -o '-p 54317 -c listen_addresses=127.0.0.1 -c cluster_name=shipbay-local-staging' start
# and create the marker: echo "shipbay-local-staging $(date -u +%FT%TZ)" > <dir>/SHIPBAY_LOCAL_STAGING
PSQL=${PSQL:-/usr/lib/postgresql/16/bin/psql}
got=$($PSQL "host=127.0.0.1 port=54317 user=postgres dbname=postgres connect_timeout=3" -tAX -v ON_ERROR_STOP=1 -c \
  "select current_setting('cluster_name') || '|' || host(inet_server_addr()) || '|' || split_part(pg_read_file('SHIPBAY_LOCAL_STAGING'), ' ', 1)" 2>/dev/null)
if [ "$got" != "shipbay-local-staging|127.0.0.1|shipbay-local-staging" ]; then
  echo "REFUSED: 127.0.0.1:54317 is not the dedicated local staging cluster (got: ${got:-no answer}). Nothing was changed." >&2; exit 3
fi
