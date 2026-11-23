# Development database: shipbay-nexus-dev

Isolated Supabase project `gdoaonsasbsperqjuurm`. It is not production (`poxlczzkpztmoiixyrth`) and holds no production data.

## What is in it

A warehouse-only subset of the ShipBay schema, plus the candidate files in `supabase/candidates/` in date order.

Left out on purpose, because they reach production services or hold secrets or staff details: sales, finance, Gmail and HubSpot tables;
the secret and token tables; every function that calls an Edge Function URL or HubSpot through `pg_net`; the three `orgs` triggers
that feed billing, account linking and onboarding. No `pg_net`, `pg_cron`, `http` or `dblink` extension is installed.

## How it was built

1. `subset.py` cuts the warehouse subset out of a schema extract and replaces staff names, phones and emails in column defaults.
   The real-to-synthetic pairs live in `scrub.local.tsv`, which is not committed.
2. `build_payload.py` splits the subset and the candidates into migration-sized files.
3. Each file was applied through the Supabase connector as `dev_001` .. `dev_020`.
4. `fingerprint.sql` returns hashes of tables, columns, constraints, indexes, function bodies, views, triggers, policies,
   sequences and grants. The dev database matched the locally tested build on every measure except default Supabase
   grants to `service_role` on tables the candidates create.

`dev_017` is the `revoke` line now in `20261130_wms_nexus_putaway.sql`. `dev_018` copies production's current
`wms_brands` and `wms_order_brands` (they skip brands that run their own WMS). `dev_019` is `20261201_wms_nexus_departure.sql`.
`dev_020` is `auth-dev.sql`.

## Synthetic records

`seed.sql` writes them and does nothing on a second run. It refuses to run where any other brand exists. Two brands, four logins at
`example.test`, six products, four private shelves, the Nexus v4 position list (P-01..P-66, STG-01, STG-02), three inbound
shipments and three received pallets (one on HOLD). The hosted database was seeded by hand before this file existed: same records,
different ids for products and shipments.

## Sign-in

`auth-dev.sql` (hosted dev only) adds the identity rows and `dev_set_test_password()`, which only the database owner can run and
only for `test-…@example.test`. No password is set by default.

## Tests

- `regression.sql`: thirteen checks as the synthetic logins; rolls itself back. Passed in the hosted database.
- `local-check.sh`: rebuilds the local database, applies every candidate, seeds twice, runs the regression.
- `../tests/deno/run.sh`: type-checks the Edge Function and runs it under Deno against the local database.
- `hosted-smoke.sh`: read-only checks of the deployed function with movement off. Not yet run.

See `DEPLOY.md` for the deployment steps and `PRODUCTION-DIFFERENCES.md` for the four functions that differ from production.

## Not done here

The bridge is not deployed, no Nexus credential is installed, and there is no WMS development site.
