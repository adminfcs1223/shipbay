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
3. Each file was applied through the Supabase connector as `dev_001` .. `dev_024`.
4. `fingerprint.sql` returns hashes of tables, columns, constraints, indexes, function bodies, views, triggers, policies,
   sequences and grants. The dev database matched the locally tested build on every measure except default Supabase
   grants to `service_role` on tables the candidates create.

`dev_017` is the `revoke` line now in `20261130_wms_nexus_putaway.sql`. `dev_018` copies production's current
`wms_brands` and `wms_order_brands` (they skip brands that run their own WMS). `dev_019` is `20261201_wms_nexus_departure.sql`.
`dev_020` is `auth-dev.sql`. `dev_021`..`dev_023` are `security-dev.sql` (plus `dev_security_check()`, which lives only in the dev database).
`dev_024` is `20261202_wms_inventory_safeguards.sql`, applied by patching in place and checked against the tested build's fingerprints.

## Synthetic records

`seed.sql` writes them and does nothing on a second run. It refuses to run where any other brand exists. Two brands, four logins at
`example.test`, six products, four private shelves, the Nexus v4 position list (P-01..P-66, STG-01, STG-02), three inbound
shipments and three received pallets (one on HOLD). The hosted database was seeded by hand before this file existed: same records,
different ids for products and shipments.

## Sign-in

`auth-dev.sql` (hosted dev only) adds the identity rows and `dev_set_test_password()`, which only the database owner can run and
only for `test-…@example.test`. No password is set by default.

## Tests

- `regression.sql`: fifteen checks as the synthetic logins; rolls itself back. All fifteen pass locally and on the hosted database (2026-11-23, with candidate 20261203 applied). The hosted database passed the first thirteen before the safeguards and a separate short check of the safeguards after.
- `local-check.sh`: rebuilds the local database, applies every candidate, seeds twice, runs the regression.
- `../tests/deno/run.sh`: type-checks the Edge Function and runs it under Deno against the local database.
- `hosted-smoke-disabled.sh`: the deployed function with everything off; needs no login. Not yet run.
- `../candidates/20261204_wms_pallet_stock_safety.sql` + `../tests/staging/void.test.mjs`, `units.test.mjs`: void and unit-count safety rules, local only.
- `pending/dev_032_pallet_stock_safety.sql` (+ `build.sh`): the combined migration for the dev database. APPLIED to shipbay-nexus-dev 2026-11-23 (its own header still says not applied: the file is kept byte-for-byte as reviewed).
- `../candidates/20261205_wms_open_box_safety.sql` + `../tests/staging/openbox.test.mjs`, `pending/dev_033_open_box_safety.sql`: open-box stock safety. APPLIED to shipbay-nexus-dev 2026-11-23 (the file's own header still says not applied: kept byte-for-byte as reviewed).
- `openbox-check.sql`: fourth rolled-back check (8 checks). 8 of 8 on hosted, 2026-11-23.
- `stock-safety-check.sql`: third rolled-back check, for the void and unit-count rules. 7 of 7 on hosted, 2026-11-23.
- `probe/index.ts`: one-off disabled-mode probe with genuine sessions (gate closed as committed). Run once on 2026-11-23 against bridge version 7; see MOVEMENT-REHEARSAL.md.
- `probe/corrections.ts`: one-off probe of the three correction endpoints with genuine sessions for all four logins (gate closed as committed). Every call names things that do not exist, so none can write. Run once on 2026-11-23, 35 of 35; see MOVEMENT-REHEARSAL.md.
- `manager-correct-check.sql`: fifth rolled-back check, for candidate 20261206 (5 checks). `pending/dev_034_manager_pick_corrections.sql` was applied to dev on 2026-11-23 (the file's header still says NOT APPLIED; it is kept byte for byte).
- `../../wms/test/corrections-e2e/`: the three correction forms in a real browser on a local stack built like this database (`run.sh`, 113 checks; `SEED=manager RUNNER=run-manager.cjs run.sh` for the manager's list, 79 checks). Local only.
- `hosted-smoke.sh`: read-only checks once the connection is on and movement is still off. Not yet run.

- `../tests/hosted/local.test.mjs` (after `../tests/hosted/build-local.sh`): the hosted movement suite on the local database with the real Nexus service code. 306 checks pass (the original 261 plus the planned-stop stage and the test-fault checks).
- `../tests/staging/workflow.test.mjs`: the seven inventory workflow repairs (candidate 20261203) on synthetic data. Six tests pass.
- `workflow-check.sql`: six more rolled-back checks (pick, pack, labels, older pick list, manager correction, totals, authorization). Pass locally and on the hosted database.
- `../tests/deno/run-runner.sh`: the temporary movement runner under Deno against local stand-ins. Passes.

## Movement rehearsal (prepared, not run)

`MOVEMENT-REHEARSAL.md` has the workflow repairs, the plan and the proposed sequence. The bridge in this branch is ahead of the one deployed to dev (test fault, exceptions report): redeploying it is a step in that sequence. Candidate 20261203, `movement-dev.sql` and `seed-movement.sql`
ARE applied to the hosted database (dev_028a to dev_031, 2026-11-23). `runner/` is NOT deployed and its gate is closed as committed.

## Applied to the hosted database but kept only there

`dev_026` (set_order_cutoff search path, also in `security-dev.sql`) and `dev_027` (`dev_repair_check()`, the hosted form of
`../security/repair-check.sql`). The first hosted put-away (PSKU-000001 at P-01, 2026-11-22) used a temporary runner that was
replaced by the inert stub afterwards; its successor is `runner/`.

See `DEPLOY.md` for the deployment steps and `PRODUCTION-DIFFERENCES.md` for the four functions that differ from production.

## Deployed

`nexus-bridge` version 1 is deployed to this project with JWT verification on and NO secrets: connection off, movement off, calendar and registry writes off. See `SECURITY-FINDINGS.md` for the review done before it.

## Not done here

No Nexus credential is installed, and there is no WMS development site.
- `ledger-hardening-check.sql`: sixth rolled-back check, for candidate 20261207 revision 2 (9 checks; check 8 is the demo-brand register). `pending/dev_035_inventory_ledger_hardening.sql` was applied to dev on 2026-11-24 00:22Z (the file's header still says NOT APPLIED; it is kept byte for byte). Rollback: `../candidates/20261207_inventory_ledger_hardening.rollback.sql`.
- `order-integrity-check.sql`: seventh rolled-back check, for candidate 20261208 (8 checks). `pending/dev_036_order_integrity.sql` is NOT applied; local only so far. Rollback: `../candidates/20261208_order_integrity.rollback.sql`.
