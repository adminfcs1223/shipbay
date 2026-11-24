# ShipBay core MVP — frozen (development only)

Accepted by Derek on 2026-11-24 at 17:55 ET: **SHIPBAY CORE MVP — BROWSER VERIFIED**, for the synthetic development
environment only. The core described here is frozen. Nothing else in this file is authorized: no further core
development, and no change to production. The next phase (individual feature improvements, controlled Nexus integration)
starts from this baseline. Nexus movement switches stay off until Derek approves them separately.

Git tag: `core-mvp-dev-2026-11-24` (branch `wms-nexus-bridge`, github.com/adminfcs1223/shipbay).

## 1. What is frozen

| Part | Frozen at | Where it runs |
|---|---|---|
| Portal | commit **2c3a62c** (code), built by `supabase/dev/owner-build.sh`; `version.json` `local-1795541770981`; ZIP sha256 `2577f4ff…3e3ac7` | https://gentle-queijadas-2bc8a5.netlify.app (Derek's Netlify, uploaded by Derek) |
| WMS | commit **19730f7** (no WMS change after it); ZIP sha256 `d85b2268…08efd` | https://sparkling-tartufo-ab3928.netlify.app (Derek's Netlify, uploaded by Derek) |
| Database | Supabase **gdoaonsasbsperqjuurm** (shipbay-nexus-dev), state of 2026-11-24 22:50Z | dev only |
| Edge functions on dev | `nexus-bridge` v7 (2026-11-22, `ezbr` 2e05a7ab…), `bridge-smoke` v24; the time-limited movement cutoff (423e863) is **not deployed** | dev only |
| Production | **unchanged**: Supabase poxlczzkpztmoiixyrth, branch `main`, wmsshipbay.netlify.app, labels function | — |

Build flags of the dev builds: WMS `VITE_NEXUS_BRIDGE=on`, `VITE_ALLOW_UNBOOKED=1`, `VITE_PALLET_SCREEN=1`; portal
`VITE_SHIP_DIRECT=1`; both point only at the dev project with its publishable key, carry the development notice, and the
build refuses output that names production, the production key, the production WMS or carrier/store hosts.

Rebuild either app exactly:
`git checkout core-mvp-dev-2026-11-24 && OWNER_WMS_URL=https://sparkling-tartufo-ab3928.netlify.app OWNER_PORTAL_URL=https://gentle-queijadas-2bc8a5.netlify.app supabase/dev/owner-build.sh /tmp/owner-build`
then zip `/tmp/owner-build/portal` (or `/wms`) and upload it to the matching Netlify site.

## 2. Database changes on dev (supabase/dev/pending)

| File | sha256 (first 12) | State on dev | Rollback |
|---|---|---|---|
| dev_035_inventory_ledger_hardening.sql | 54b168773497 | applied (earlier sessions) | no separate file; see its header |
| dev_036_order_integrity.sql | a3399f512b11 | applied (earlier sessions) | no separate file; see its header |
| dev_037_mvp_fulfilment.sql (ship_order, idempotent repeat) | ed9ebc431505 | applied | no separate file; restore the previous ship_order from the migration history |
| dev_038_admin_created_logins.sql | b5ecf8da7b8d | applied, then superseded by dev_039 | dev_039 rollback restores the dev_038 behaviour |
| dev_039_admin_created_logins_fix.sql | 26fb4ddfadb6 | applied 16:37Z, verified | dev_039_admin_created_logins_fix.rollback.sql (b37a3ac1488a), tested locally |
| dev_040_synthetic_positions.sql (SB-01..SB-06, position rule, registry exclusion) | c97f8dbb9344 | applied, verified | dev_040_synthetic_positions.rollback.sql (394b6247c0e6), tested locally; refuses while anything is still stored at an SB position |

Data changes made by hand on dev (each one row, recorded): owner login `xavier.delmonte24@gmail.com` → `shipbay_admin`;
test client `xavier.delmonte24+sb-mailers@gmail.com` → `client_user` / Synthetic Mailers.

Function fingerprints at freeze (left 8 of `md5(pg_get_functiondef(oid))`): dev_admin_created_only 4d35d465,
dev_no_signup bb8e5db0, dev_synthetic_positions_only dc8641c6, nexus_registry_apply efcc3eab, ship_order c49d1b77,
wms_stock_summary f588617d.

## 3. Test evidence

Full record: `OWNER-DEV-DEPLOY.md`, section "2026-11-24 browser acceptance". Summary:

- **Flow in the browser:** receive MVP-A 30 → PSKU-000105 at SB-01 → orders ACC-1/2/3 (12 each) → wave ACC-1 + ACC-2,
  ACC-3 left short → pick 24 → pack → ship ACC-1 (USPS, TEST-ACC-0001) and ACC-2 (UPS, TEST-ACC-0002); no label bought.
- **Balances:** MVP-A received 30, shipped 24, on hand 6 at SB-01; open demand 12 (ACC-3), so available −6 is unfilled
  demand; no position below zero. MVP-B 20 at SB-06.
- **Repeat shipment:** browser double-click sent one request; a reused tracking number was refused; `ship_order` repeated
  for ACC-1 with the same tracking as the owner login (database, committed, 17:36:03Z) returned the original shipment,
  shipments 2→2, stock moves 2→2, SB-01 6→6.
- **Tenant isolation, real client:** the Mailers client sees only Mailers orders, products, stock and pallets in the
  browser; as that login the database returns 0 Records rows across orders, order lines, shipments, products, stock,
  stock moves, pallets, picks, brands and logins, and the stock, connector, picklist and orders-summary functions refuse
  Records.
- **Admin "View as client":** fail-closed guard (`portal/src/viewGuard.js`, 8 unit tests in `portal/test/`); both
  brands' previews show only that brand, including page totals.
- **Unchanged:** Nexus journal is still the single PSKU-000001 → P-01 row from 2026-11-23; P-01 holds PSKU-000001,
  P-02 and P-03 are empty; no hosted pallet movement; production untouched.

## 4. Known limitations (development environment)

- Shipping is test tracking only (`VITE_SHIP_DIRECT`); no labels, carriers or store sync.
- SB-01..SB-06 are development positions only; shared P/STG positions need Nexus and are off.
- Dev has no `labels`, `owner`, `integrations`, `wms-login` or `password-reset` functions: no employee-number sign-in, and
  the portal's own "Forgot password" does not work on dev (recovery is sent from the Supabase dashboard).
- Supabase's built-in email sends dev invitations and links; it is rate-limited and not for production use.
- The bridge's time-limited movement cutoff exists in code (423e863) but is not deployed.
- The P-03 hold and the movement hold are standing instructions from Derek, not database rows.

## 5. Production-readiness items (recorded, not started)

1. **Portal password recovery.** The portal's "Forgot password" depends on the `password-reset` edge function and its
   email sending. Needed: a working, tested recovery path in the target environment, and the invite landing
   (`type=invite`) taking the client to "Choose a password" rather than straight into the dashboard.
2. **Store-connector shipped/open status mismatch.** `_wms_order_json` reports a shipped order as `open` to the
   brand's connector (it only knows open / picked / closed). Needs a decision on the connector contract (for example a
   `shipped` status, with tracking) before any store connector goes live.
3. **Repeat-shipment verification through the HTTP interface.** Idempotency was proven in the database and by one
   browser double-click; a deliberate repeated `POST /rest/v1/rpc/ship_order` with the same order and tracking, as an
   authorized user over HTTP, still has to be run and recorded (expected: the same shipment id, no new shipment, no
   stock change).

## 6. Rollback

Each step is dev only and independent.

- **Portal guard and Warehouse status (2c3a62c):** rebuild the portal at 19730f7 with `owner-build.sh` and upload it to
  gentle-queijadas-2bc8a5. No database change is involved. Note this brings back the "View as client" leak.
- **Test client login:** set its profile back with
  `update profiles set org_id = null where id = 'e3e17b30-4aa0-4f33-b085-1b532a285ecb';` (or remove the login in the
  Supabase dashboard). Nothing else depends on it.
- **SB positions (dev_040):** release or ship everything at SB-01..SB-06, then run
  `dev_040_synthetic_positions.rollback.sql`; it refuses while stock remains.
- **Login creation fix (dev_039):** run `dev_039_admin_created_logins_fix.rollback.sql`.
- **Test data (ACC-*, MVP-B-*, PSKU-000104/000105):** synthetic; leave in place as evidence unless Derek asks for a reset.

## 7. Nexus

Movement switches (`NEXUS_BRIDGE_MODE`, `NEXUS_PALLET_MOVES`, `NEXUS_REGISTRY_WRITES`, `NEXUS_CALENDAR_WRITES`,
`NEXUS_TEST_FAULTS`) were last read **off** by the read-only probe (`supabase/dev/probe/switches.ts`, 2026-11-23, see
`MOVEMENT-REHEARSAL.md`) and have not been touched since. They stay off until Derek approves them separately. The
P-03 hold and the movement hold remain in force.
