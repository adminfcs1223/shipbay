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
3. Each file was applied through the Supabase connector as `dev_001` .. `dev_018`.
4. `fingerprint.sql` returns hashes of tables, columns, constraints, indexes, function bodies, views, triggers, policies,
   sequences and grants. The dev database matched the locally tested build on every measure except default Supabase
   grants to `service_role` on tables the candidates create.

`dev_017` is the `revoke` line now in `20261130_wms_nexus_putaway.sql`. `dev_018` copies production's current
`wms_brands` and `wms_order_brands` (they skip brands that run their own WMS).

## Synthetic records

Two brands (Synthetic Records, Synthetic Mailers), four logins at `example.test` with no password, six products,
three inbound shipments `SYN-PO-1001..1003`, three open pallets (one on HOLD), 30 cartons, four private shelves,
and the Nexus v4 registry: P-01..P-66 and STG-01/STG-02. The seed statements were run by hand and are not in this folder yet.

## Regression test

`regression.sql` runs twelve checks as the synthetic logins and rolls itself back. It refuses to run if the database
holds any brand other than the two synthetic ones.

## Not done here

The bridge is not deployed, no Nexus credential is installed, and there is no WMS development site.
