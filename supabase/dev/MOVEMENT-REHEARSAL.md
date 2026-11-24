# Hosted movement rehearsal: dev database and bridge ready, screens validated, runner and stages not run

Updated 2026-11-23, 8:15 PM ET (stock-ledger hardening revision 2 tested locally, NOT applied: next section, parts 5 and 6; dev_034 is applied to dev and verified). Step 1 (development database), step 2 (updated bridge) and the stock safety migrations dev_032
dev_033 and the manager pick-correction migration dev_034 are applied and verified on `shipbay-nexus-dev`. The three correction forms have now been run in a browser and the
correction endpoints called over HTTP with real sessions (below). The movement runner is NOT deployed, no switch was set, and
nothing was sent to Nexus. Production and `main` are untouched.

**Hold (Derek, 2026-11-23 2:30 AM):** the hosted rehearsal does not start yet. Souled's P-02 placement is being prepared and
Nexus has a destination-safety deployment pending. PSKU-000001 stays at P-01.

## Stock-ledger hardening (candidate 20261207, pending dev_035): prepared and tested LOCALLY, NOT applied anywhere

Derek's assignment of 2026-11-23 6:43 PM. The P-02 hold is released (Souled's placement succeeded and Nexus confirmed it); the
movement-rehearsal hold is NOT. Nothing here was applied to hosted dev, no screen, runner or bridge was deployed, no switch was
set, nothing was sent to Nexus, production and `main` were not touched. Hosted dev was read twice (catalog and one fingerprint).

### 1. Dependency audit (hosted dev schema, read-only, plus the repository)

Before: `inventory_moves` grants INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER to `anon`, `authenticated`,
`service_role` and `postgres`. Two permissive access rules: `client_read_moves` (read own brand) and `shipbay_all_moves`
(everything, for `is_shipbay()` = admin, staff, sales). No trigger on the table. `skus.org_id`/`orgs` deletes cascade into the
ledger and a location delete blanks `location_id`, so deleting a product, brand or location also removed or defaced history.

| Writer | Rows it writes | Who can call it | Check inside |
|---|---|---|---|
| `_wms_post_stock(pallet)` via the three pallet/carton/unit triggers | receive, adjust (insert) | service login only | internal |
| `_wms_nexus_carry` | transfer (insert); ties older picks to the pallet (update `pallet_id` only) | no login | internal |
| `_wms_open_box_do` | transfer/adjust (insert); finalises rows of the same call (update) | no login | internal |
| `wms_correct_units` | via triggers; rewrites the note of the same call's rows (update) | signed-in | admin/staff, reason |
| `wms_pick_correct` (and `wms_manager_stop_correct` through it) | pick (insert) | signed-in | role, brand, reason |
| `wms_wave_confirm`, `wms_wave_unconfirm` | pick (insert) | signed-in | floor staff, own wave |
| `wms_pick_scan`, `wms_unpick` | pick (insert) | signed-in, service | `is_wms_staff()` |
| `receive_inbound` (older portal receiving) | receive, no position (insert) | signed-in, service | `is_shipbay()` (sales included) |
| `ship_order` (older pack station) | pick, no position (insert) | signed-in, service | `is_shipbay()` (sales included) |
| `wms_demo_reset` | deletes and re-inserts the demo brand's rows | signed-in, service | `is_wms_staff()` |
| `dev_security_check` (dev database only) | tries two forbidden inserts, expects refusal | no login | n/a |

All of them are SECURITY DEFINER, owned by `postgres`, with `search_path = public` (except `dev_security_check`, which runs as
its caller and is closed to logins). None relies on the caller's own table privileges. No portal, WMS or Edge Function code
writes the table directly (the portal only names it in a list of brand-scoped tables; `nexus-bridge` never touches it). Read
access: admin, staff and sales read everything; a client reads its own brand; floor logins read nothing directly (their screens
go through functions); the view `inventory_levels` runs with the reader's rights. Nobody needs a direct write.

**Not verifiable from here (production only):** whether production has other functions, triggers, scheduled jobs or
integrations (Shopify/Veeqo sync, `billing_estimate`, `billing_rates_list`, `billing_rate_save`, imports from the Admin screens)
that insert, edit or delete ledger rows, and whether anything there deletes products, brands or locations that have history.
Read access to the production catalog was refused earlier and was not retried. This candidate is therefore NOT cleared for
production.

### 2. The candidate (`supabase/candidates/20261207_inventory_ledger_hardening.sql`; no DROP; no existing function replaced; no row changed)

1. Revokes INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on the ledger from the public key and signed-in logins. SELECT
   and the two existing access rules are untouched, and so are the service login's privileges.
2. Three restrictive access rules (`ledger_no_direct_insert/update/delete`): refused even if the privileges are granted back.
3. Append-only for everyone, the service login and the owner included (trigger `inventory_moves_append_only`, plus a truncate
   trigger): no delete (except the demo brand's sample rows), no truncate, no edit of a row from an earlier transaction except
   tying an older pick to its pallet once; a row may be finalised (quantity, reason, note) only inside the transaction that
   wrote it; brand, product, position, reference, author and time never change. Consequence: a product, brand or location
   with stock history can no longer be deleted.
4. Insert rules for everyone: the product must be the row's brand's; an adjust, cycle_count, damage or return_restock row must
   have a position, a reference, a reason of 5+ characters and, during a signed-in request, its author; a row written during a
   signed-in request can only name that login.
5. `wms_stock_correct(brand, product, shelf, change, reason)`: the sanctioned correction for stock not on a pallet. Admin or
   staff only (not sales, floor, client), reason required, private shelf only, never below zero or below what a wave being
   picked has planned there; one adjust row and one activity entry (`stock_corrected`). No screen calls it yet.

Pending dev migration: `supabase/dev/pending/dev_035_inventory_ledger_hardening.sql` (generated, NOT applied).
Rollback: `supabase/candidates/20261207_inventory_ledger_hardening.rollback.sql` (no DROP: switches the three triggers off, opens
the three rules, grants the privileges back, closes the new function). Tested locally: after it an admin's direct insert is
accepted again as before; applying dev_035 again closes it. Rows written meanwhile are kept.

### 3. Local results (2026-11-23 evening; all on this machine)

| What | Result |
|---|---|
| New `supabase/dev/ledger-hardening-check.sql` (rolled back) | 8 of 8: 24 direct writes refused (admin, staff, sales, floor, client, public key x insert/edit/delete/empty); refused again with privileges handed back; 22 owner/service deletes and edits refused; insert rules; correction refusals; accepted corrections; older writers; integrity |
| Direct HTTP through the local API (PostgREST), real tokens | 18 of 18 writes refused (admin, staff, floor, client: 403; public key and a forged token: 401); `wms_stock_correct` over HTTP: admin and staff 200, floor and client 400, public key and forged 401 |
| Database built as dev is today + dev_034 + dev_035 | other 158 functions and their grants, the ledger row, other tables' grants, the other 43 access rules and PSKU-000001 byte-for-byte unchanged by the migration |
| Earlier rolled-back checks on that build | regression 15, open box 8, stock safety 7, workflow 6, manager 5: all pass |
| Staging suites with the candidate loaded | void 6, units 5, openbox 5, workflow 6, bridge 16, manager 5, wms-graft 10: all pass |
| Movement rehearsal suite | 331 of 331 checks, 0 failed |
| Runner under Deno / bridge under Deno | 13 passed / 4 passed |
| Signed-in browser suites | corrections 113 passed, manager 79 passed |
| WMS unit tests | 56 passed |

Covered by those: receiving, put-away, void, carton opening, unit correction, pick correction, manager correction, wave picking,
packing hand-off, the stock view. Not covered: sales was tested as a stand-in (the staff login given the sales role inside the
rolled-back check), not as its own signed-in browser session; `activity`, `dock`, `nexus`, `registry` and `waves` staging suites
load older candidate sets and do not include this one; `dev_security_check()` exists only on hosted dev and was not run against
the hardening (its two forbidden inserts are still refused, but for lack of permission rather than by the access rule, so if it
matches on message text it may need a look after applying).

### 4. Risks and decisions

- A correction to a receipt row an hour later is no longer an edit: it must be a new compensating row. All current functions
  already work that way; any production-only code that edits old rows would break.
- Products, brands and locations with stock history cannot be deleted. Admin screens that offer such a delete would now show
  an error for those. Retire (deactivate) instead.
- `wms_demo_reset` keeps its delete, limited to the brand with slug `demo-brand`.
- `receive_inbound` and `ship_order` still accept a sales login and still post rows with no position. Not changed here (they
  are existing workflows); deciding whether sales should post receipts and shipments is Derek's call.
- Put-away receipts still have no author on the ledger row (bridge commits under the service login). The insert rule allows
  that for the service login only. Still an open defect.
- Sales keeps read access to the whole ledger (unchanged). Derek's call whether it should.
- `wms_stock_correct` has no screen; until one exists, a shelf-stock correction needs the function call.

**Safe to apply to isolated shipbay-nexus-dev: yes**, as dev_035, one transaction, with the six rolled-back checks and
`dev_security_check()` run afterwards. **Not cleared for production** until the production-only writers are listed.

### 5. dev_035 approved 2026-11-23 7:02 PM, NOT applied: pre-deployment review found a way around it (STOPPED)

Derek approved applying dev_035 to dev with a stop rule: stop if a security assumption differs from the tested candidate.
Pre-deployment item 8 (trigger exceptions must not be usable by an ordinary login) FAILED on the demo-brand exception:

- The append-only trigger allows deleting ledger rows of the brand whose slug is `demo-brand` (for `wms_demo_reset`).
- Admin, staff and sales can edit `orgs` (rule `shipbay_all_orgs`, no trigger on `orgs`), so they can rename a real brand's
  slug to `demo-brand`. Admin, staff and floor can run `wms_demo_reset()`.
- Reproduced locally on a copy of dev with dev_035 applied (rolled back): a STAFF login renamed Synthetic Records to
  `demo-brand`, ran the demo reset, and the brand's ledger row (PSKU-000001's receipt in that copy) was deleted. The reset also
  deletes that brand's orders, order lines, waves and picks; that part exists today, without dev_035.
- Hosted dev has the same conditions (read-only check 00:1xZ): `orgs` writable by those logins, no trigger on `orgs`,
  `wms_demo_reset` open to signed-in logins. Section 4 above said the exception was "limited to the demo brand"; that was
  wrong as a security statement, because the label is editable.

Checked at the same time and closed: pallets, cartons and units cannot be edited directly by any login (read-only access rules;
an admin's edits and deletes touched 0 rows, ledger unchanged), so the stock triggers cannot be driven from the API.

Pre-deployment items that passed: target is `shipbay-nexus-dev`, 31 migrations ending dev_032 > dev_033 > dev_034; the dev_035
body equals the candidate minus `begin;`/`commit;` plus a 9-line comment header, unchanged since 282cb60; it holds 3 functions,
3 triggers, 3 trigger-enable lines, 3 access rules, 4 revokes, 1 grant, no DROP and no row statement outside the new function.
Before-state on hosted: ledger 1 row `afc8960b`, journal 1 row `28ef4c90`, PSKU-000001 stored at P-01 `56e1c5ac`, pallets 9
`49a8aabd`, cartons 90 `a025ccd7`, orders 1 `940453fc` (the last three use this section's formula, md5 of the rows as JSON).
Nothing was written to hosted dev.

Trial fix (local, rolled back, not a file yet): a trigger on `orgs` refusing a rename to `demo-brand`. With it the staff
rename is refused, the demo reset still runs twice, and the real brand's ledger row survives.

### 6. Revision 2 of the candidate (Derek chose option 1, stronger form, 2026-11-23 7:08 PM): tested LOCALLY, NOT applied

The demo brand is now identified by a register, not by any editable label. Diff from revision 1:
`git diff 282cb60 -- supabase/candidates/20261207_inventory_ledger_hardening.sql` (the pending dev_035 is that file minus
`begin;`/`commit;` under a comment header). What changed, and nothing else:

1. NEW table `wms_demo_brand`: at most one row, the demo brand's id (`org_id` unique, foreign key to `orgs`, delete and update
   restricted). Access rules on, none defined, every privilege revoked from the public key, signed-in logins and the service
   login. Only `wms_demo_reset` writes it.
2. `_inventory_moves_guard`: the delete exception tests `old.org_id` against the register instead of `orgs.slug`; the function
   is now SECURITY DEFINER (fixed search path, executable by nobody) so it can read the register.
3. `wms_demo_reset` REPLACED (the only existing function touched; revision 1 replaced none). The brand lookup is the only
   change: it takes the brand from the register; with an empty register it creates a NEW brand and registers it, and refuses
   if any brand already holds the slug `demo-brand` or client code `DEMO` (any capitals or spaces); it never adopts a brand by
   label. Everything after the lookup is the text on file today (md5 e9a5db94 before, cb93563a after). The service login can
   no longer call it; floor, staff and admin still can (the WMS Orders screen offers it to any WMS user).
4. Rollback file: also restores `wms_demo_reset` to its old text and permissions. The register table stays (no DROP).

Reset's full destructive scope, all keyed on the registered brand id: its waves, picks, orders, order lines (and by cascade
from its orders: shipments, wave-order links, packages), its ledger rows; it revokes that brand's API keys and issues one new
key; it upserts 12 demo products and posts demo stock at shelves A-01..B-04. It never touches pallets, cartons, locations or
another brand's rows. In revision 1 a renamed real brand lost all of the above and had a live API key handed to the caller.

Local results (database built as dev is today + dev_034 + dev_035 r2):

| What | Result |
|---|---|
| Original exploit (staff renames a real brand to `demo-brand`, runs the reset), SQL and over HTTP | Refused; real brand's ledger, orders unchanged |
| `ledger-hardening-check.sql`, now 9 checks | 9 of 9. New check 8: 18 of 18 impersonations refused before a demo exists (admin, staff, sales x slug, capitals, spaces, client code, all labels, new brand with the slug) plus `wms_set_client_code`; genuine demo created by floor, rebuilt identically by staff and admin (12 rows, 541 units); with the demo registered and renamed away, a real brand wearing every demo label (and its product moved into the demo brand) untouched for admin, staff, sales; 30 of 30 register reads and writes refused (admin, staff, floor, client, public key, service login); brand id swap, change, delete, duplicate all fail; client, sales, public key, service login cannot reset; ordinary brand rename by staff works |
| Over the local API with real tokens | rename 200 then reset 400 for staff and admin; genuine reset by floor 200 twice on a separate brand; register 403 for every login, 401 for public key and forged token; real-brand ledger md5 identical before and after |
| Migration effect on a copy of dev | 10 fingerprints identical before and after: the other 157 functions (body, grants, definer flag, settings), ledger row, other tables' grants (787), other access rules (43), other triggers (21), table count, brands, pallets, journal, PSKU-000001 |
| Rollback, then re-apply | After rollback the same 10 fingerprints, old reset text and permissions back, ledger triggers off; after re-apply same state as first apply, check 9 of 9 |
| Earlier checks | regression 15, open box 8, stock safety 7, workflow 6, manager 5 |
| Staging suites | void 6, units 5, openbox 5, workflow 6, bridge 16, manager 5, wms-graft 10 |
| Movement suite / runner / bridge under Deno | 331 of 331 / 13 / 4 |
| Browser suites / WMS unit tests | 113 and 79 / 56 |

Correction to section 3: the "byte-for-byte unchanged" fingerprints reported for revision 1 used `string_agg(... order by 1)`,
which does not sort (it orders by a constant). They happened to agree but proved less than stated. The formula is fixed here
(`/tmp/fp.sql` logic: ordered by the value itself) and the comparison was redone.

Hosted dev re-read after the work (read-only): 31 migrations ending dev_034, no hardening object present, ledger `afc8960b`,
journal `28ef4c90`, PSKU-000001 stored at P-01 `56e1c5ac`, pallets `49a8aabd`, cartons `a025ccd7`, orders `940453fc`: all as
before. Nexus staging occupancy could NOT be re-read (the connector returned Bad Gateway three times); nothing was sent to
Nexus.

Effects and remaining risks:
- Existing brands: none on dev (no demo brand there). A database that already has a demo brand from the old reset is not
  adopted: the reset refuses until the owner registers that brand by hand. Production unknown.
- Brand edits are unrestricted as before; labels simply confer nothing. The registered brand cannot be deleted.
- Admin, staff and sales can still delete or re-home ORDERS directly (existing table access, with or without the reset);
  the ledger rows of those orders survive. Out of scope here; a real-inventory blocker of its own.
- The reset still posts demo stock at real shelves and is still offered to floor logins. Whether it should exist at all in a
  database with real inventory is Derek's decision.
- The reset hands a working API key for the demo brand to the caller (unchanged behaviour).

**Ready for separate hosted-dev approval: yes.** Not cleared for production.

## dev_034 applied to shipbay-nexus-dev and verified (approved by Derek, 2026-11-23 6:25 PM)

Applied as migration `dev_034_manager_pick_corrections` (the 31st). The WMS screen is NOT deployed anywhere; on dev the
functions are reachable by API only. No runner, no switch, nothing sent to Nexus, production and `main` untouched.

Before applying: target confirmed (`gdoaonsasbsperqjuurm`, two synthetic brands, four example.test logins). The file adds three
functions, five revoke/grant lines, nothing else: no DROP, no table, no row, no existing grant. Applied to a local database in
dev's state it gives the same three bodies as the tested candidate.

| Check on the hosted dev database | Result |
|---|---|
| The three function bodies equal the tested candidate (md5 of stored source) | 3 of 3 (`wms_manager_stops` 2afa232b, `wms_manager_stop_correct` a020b2da, `_wms_stop_correct_block` e5ee05ea) |
| The other 159 public functions (body and grants) | One fingerprint, identical before and after |
| Table grants (845) and access rules (43) | Fingerprints identical before and after: no unrelated grant changed |
| Permissions on the new functions | Public key: none. Signed-in logins: the list and the correction (each checks admin or staff itself). Service login: none. The internal check: nobody |
| `manager-correct-check.sql` | 5 of 5, rolled back |
| `workflow-check.sql` | 6 of 6, rolled back |
| `stock-safety-check.sql` | 7 of 7, rolled back |
| `openbox-check.sql` | 8 of 8, rolled back |
| `regression.sql` | 15 of 15, rolled back |
| Real Supabase Auth sessions (one-off probe, 23:31:30Z) | 28 of 28 |
| Pallets, cartons, ledger, journal, orders: fingerprints before the migration and after everything | Identical (9 pallets, 90 cartons, 1 ledger row of 100, 1 journal entry, 1 order) |
| Positions below zero; pallets received twice; correction log rows left behind; open requests; waves; runner runs | 0, 0, 0, 0, 0, 0 |
| PSKU-000001 | Stored at P-01; its row, its one receipt of 100 and its one journal entry (04:26:05Z) have the same md5 as before |

What the hosted manager check showed (as the synthetic logins, rolled back): a stop not picked yet, a stop whose pallet is on
the floor and a pick at the pack station are each refused in words with the ledger untouched; floor and client logins can
neither read the list nor correct; each brand's list holds only its own picks and a stop named under the other brand is
refused; a correction needs a reason and a private shelf; staff's correction posts ONE row (+6 on A-01) naming staff, the stop
and the reason, with an activity entry, and the picker's stop reopens at the shelf; a second correction of the same pick is
refused; the admin's correction for the other brand posts under that brand.

The probe (real sessions): Auth issued a session for each of the four logins with the expected role; floor and client are
refused on the list (both brands) and the correction, and cannot call the internal check; no token, the public key and a
made-up token are refused before anything runs; admin and staff get each brand's list (empty: no wave is open on dev), are
refused with no brand named, and are refused for a stop that is not the brand's; nobody can call the internal check. It also
read the bridge's `/status` once: connection off, pallet moves false, test faults false. It was in the `bridge-smoke` slot for
about 10 seconds; the stub is back (version 20, source read back, sign-in required).

Stated plainly:
- Three of the five checks (stock-safety, open box, regression) were pasted to the database by a helper session from the
  committed files; it reported pasting the blocks unchanged but could not byte-compare. Their pass lines and counts are the
  expected ones.
- With real sessions, every call named a stop that does not exist, so the reason rule and a successful correction were NOT
  exercised through Supabase Auth. They were exercised on hosted in the rolled-back check (as each login's identity) and in
  the local browser and HTTP runs.
- The screen is local-only. Nothing a production user can open has changed.
- The rolled-back checks consumed pallet, carton and package label numbers.

### Movement rehearsal against Nexus's deployed destination-safety code (local)

Correction to earlier notes here: the local tests built their Nexus database from files 001 to 003 of the copy fetched at
commit `b4d3053`. That copy predates the idempotency change of 2026-11-22 23:43 (a key matches only the identical request,
positions included) and everything after it, although staging already ran some of that when the earlier runs were reported.

Now: branch `nexus-neutral` at `9826ba3`. Staging runs migrations 001 to 005 and 007 (006, 008, 009 are not there). A local
database built from those six has the same 34 functions as staging; 31 have identical bodies, including everything on the
movement path (`place`, `api_place`, `_auth`, `api_occupancy`, `api_map`, `api_moves`, `api_changes`, `_occupancy_guard`,
`_map_checksum`). The three that differ (`_baseline_problems`, `floor_stop`, `integration_create`) are baseline and
administration functions the bridge never calls; staging has an older text of them. Map version 4 and the checksum the suite
pins are unchanged on staging. The tests now load those six files.

| Against that code, locally | Result |
|---|---|
| Movement suite, nine stages | 331 of 331 |
| Runner under Deno | 13 of 13; most bridge calls in one stage still 22 |
| Bridge | 16 of 16 |
| Manager, void, unit count, open box, workflow | 5, 6, 5, 5, 6 |

Not verified: the three functions that differ were not compared line by line, and the service's HTTP wrapper on staging
(`service/supabase`) was not read; the tests drive `service/handler.mjs`, which is unchanged from the copy used before.

Seen while reading Nexus staging at 23:35Z (read-only): Souled's PAL-9801 now stands at P-02 (14 moves on record). ShipBay
still has exactly one movement (04:26:05Z) and PSKU-000001 at P-01. The suite never names P-01 or P-02.

### Security follow-up, to be fixed before real inventory (NOT changed here)

Admin, staff and sales logins can still insert, change and delete ledger rows directly through the API (`shipbay_all_moves`
on `inventory_moves`), with no reason recorded, bypassing every correction function. Floor and client logins cannot. Table
grants and access rules were fingerprinted before and after dev_034 and are unchanged. The requirement is written out under
"Later hardening" below.

## Manager access to pick corrections (candidate 20261206): what was built (on dev as dev_034 since 2026-11-23 evening; screen local-only)

Derek's assignment, 2026-11-23 12:20 PM. The gap was defect 2 below: a floor picker whose pallet left after the pick is told to
ask a manager, and a manager who signed in saw only their own wave.

### What was built

`supabase/candidates/20261206_wms_manager_pick_corrections.sql`: three NEW functions. Nothing existing is replaced; no table,
row or existing grant is touched. `wms_pick_correct` is unchanged and still does the posting.

- `wms_manager_stops(brand)`: ShipBay admin or staff. For one brand: every pick, on any picker's open wave, taken from a
  pallet that has since left the shared floor: wave, picker, item, units picked and planned, position, pallet, order, and
  either "can be corrected" or the reason it cannot.
- `wms_manager_stop_correct(brand, stop, shelf, reason)`: ShipBay admin or staff. The stop must belong to the brand named
  (another brand's stop and a stop that does not exist get the same answer). Reason of at least five letters. Then every
  unsupported state is refused in words; only then does it call `wms_pick_correct`.
- `_wms_stop_correct_block(stop)`: internal, callable by no login. The one place that says why a stop cannot be corrected.

On the Orders screen (`wms/src/Orders.jsx`, `wms.css`): a manager who opens a brand sees "Picks waiting for a manager", one row
per pick, with "Return to a shelf" (shelf and reason) or the refusal. A manager in the middle of their own wave gets a notice
above it with "Show", and "Go back to your wave" afterwards. The floor picker's message now says where the manager finds it
(brand and wave number). The list call is tolerant of a database that does not have the function yet (no list, no error), so
the screen and the migration can go out in either order.

### What each state does

| State of the stop | Result |
|---|---|
| Picked in full, wave still being picked, pallet departed or off the shared floor | Corrected: the units picked go onto the private shelf named, ONE ledger row naming the manager, the stop and the reason; an activity entry; the picker's stop reopens at that shelf |
| Picked short (4 of 6), same conditions | Corrected for exactly the 4 picked. The stop reopens for the order's 6 with 4 on the shelf; the picker can confirm no more than 4; a second order is not planned against those 4 (reported short) |
| Not picked yet | Refused: "has not been picked yet. There is nothing to return." |
| Confirmed with 0 | Refused: "Nothing was picked at that stop." |
| Pallet still on the floor | Refused: "... is still on the floor at P-nn. The picker reopens this stop on their own screen." |
| Picked from a shelf | Refused: the picker reopens it |
| A Nexus request waiting or out of sync on the pallet | Refused until it is settled; listed once it is |
| Wave at the pack station | Listed, with the reason, no button; refused: "... is at the pack station. A pick cannot be returned to a shelf from there; nothing was changed." |
| Order packed | Refused: "Order ... is packed. Packed stock is not rewritten by a pick correction." |
| Order shipped | Refused: "Order ... has shipped. Shipped stock is not rewritten by a pick correction." |
| Order closed or cancelled; wave finished or cancelled | Refused, each in words |

Unsupported and still open (item 4 under "Assessed, not fixed"): nothing returns picked units to stock once a wave is at the
pack station. This work refuses it explicitly; it does not solve it.

### "Company isolation": what is enforced, and what the roles are

ShipBay admin and staff are ShipBay's own logins and work every ShipBay brand; there is no manager role scoped to one brand,
and Souled has no login in ShipBay's database. What is enforced and tested: every call names its brand; a brand's list holds
only that brand's picks; a stop cannot be corrected under another brand's name; a client login (tested in each of two brands,
against its own brand and the other) can read no list, correct nothing, and cannot open a wave or the order summary; the
ledger row of a correction belongs to the stop's brand. If a brand-scoped manager is ever wanted, that is a new role, not part
of this.

### Tests (all local, synthetic)

| Test | Result |
|---|---|
| `supabase/tests/staging/manager.test.mjs` (real Nexus service code, bridge in-process) | 5 of 5: find and correct; authorization (floor, two clients, sales, public key, internal function); brand isolation; every refused state incl. a lost Nexus answer, pack station, packed, shipped, cancelled; short pick and reservations; ledger afterwards |
| Browser, whole WMS app, real token checking: `SEED=manager RUNNER=run-manager.cjs wms/test/corrections-e2e/run.sh` | 79 of 79: floor message and no manager controls; admin list, form refusals, correction; second brand's own list; staff mid-wave notice, short pick, back to own wave; the picker's screen afterwards; HTTP as floor, both clients, no token, public key, forged token; a floor login trying to change its own role or create a manager profile (403, "Only the owner can change roles and access."); cross-brand over HTTP; ledger, reservations, PSKU-000001 |
| Browser, the earlier corrections run (`run.sh`) | 113 of 113 (its "manager cannot reach the stop" record is now a check that the stop IS listed) |
| Stock and workflow suites with 20261206 loaded | void 6, units 5, open box 5, workflow 6, bridge 16 |
| Other database suites | activity 3, dock 1, nexus 7, registry 1, waves 1, receiving graft 10 |
| Movement suite, nine stages, real Nexus service code | 331 of 331 |
| Runner under Deno; Edge wrapper | 13 of 13; 4 of 4 |
| WMS unit tests; normal WMS build | 56 of 56; builds |
| `dev_034` on a local database in dev's state (through dev_033, PSKU-000001 stored at P-01) | Functions and grants then equal a full build (one fingerprint over 158); `manager-correct-check.sql` 5 of 5, open-box 8, stock-safety 7, regression 15, workflow 6, all rolled back; pallets, ledger (1 row of 100) and journal unchanged. Without dev_034 the new check refuses to run |

"Genuine authentication" here means tokens checked by real PostgREST on the local stack, in a browser and over HTTP. Sessions
issued by Supabase Auth cannot reach these functions until they exist on dev.

### Not covered, stated plainly

- Nothing is on hosted dev: no migration applied, no screen deployed. Not run with Supabase Auth sessions.
- The correction returns units to ONE shelf per pick, typed by the manager; there is no shelf picker and no scan.
- The manager finds picks per brand. There is no count on the brand list, so a manager has to open the brand the picker names
  (the floor message names brand and wave).
- A pallet off the shared floor but still in ShipBay's custody (`off_floor`) is treated like one that left the building: the
  picked units go to a shelf, not back to the pallet. Tested for both in the database test; the browser run used `departed`.
- Phone width was not run.
- Seen while testing, not changed: the existing "Needs a manager" table on the same screen is wider than its panel at 1320 px
  and its last column ("Back to the pick list") is cut off.

### Proposed development deployment (each step needs its own approval)

1. **Migration.** `supabase/dev/pending/dev_034_manager_pick_corrections.sql` to `shipbay-nexus-dev`, one transaction: three
   new functions, their revokes, two grants. Verify the three bodies by md5 and every other function unchanged.
2. **Hosted checks, rolled back.** `manager-correct-check.sql` (5), then open-box (8), stock-safety (7), regression (15),
   workflow (6). Fingerprints of pallets, ledger and journal before and after; PSKU-000001. The new check uses P-60 to P-62 on
   ShipBay's side only and sends nothing to Nexus.
3. **Real sessions.** One-off probe as before (15-minute gate, stub restored): the two functions as admin, staff, floor and
   client, with stops that do not exist, so nothing can be written.
4. **Screen.** There is no hosted WMS build on dev. The screen reaches users only with a WMS deploy from `main`, which is a
   production step and not proposed here. Until then the function is usable on dev by API only.
5. **Rehearsal.** Unaffected: the suite calls none of the three functions, and 331 of 331 pass with them loaded. The pre-run
   check then expects 31 migrations and three more functions on dev.

## Later hardening: direct ledger writes by ShipBay logins (the requirement; now answered by candidate 20261207 above, still NOT applied)

Today the ledger table `inventory_moves` has two access rules: a client reads its own brand's rows, and
`shipbay_all_moves` lets any login for which `is_shipbay()` is true read, insert, update and delete any row. `is_shipbay()` is
true for `shipbay_admin`, `shipbay_staff` and also `shipbay_sales`. So those logins can post, change or remove a stock row
through the API with no reason, no pallet, no position check and no check for a waiting Nexus request, and nothing records why.
Every correction function built this week (count, open box, pick, void) can be bypassed that way. Floor and client logins
cannot (checked locally and on hosted dev).

Nothing in the portal, WMS or Edge Function source in the repository writes the table directly (the portal's `lib.js` only
names it among brand-scoped tables). Production-only code was not read.

Requirement for a later task, with its own approval and tests:

1. Find every direct writer first: production functions and screens not in the repository, imports, and any manual practice
   (Admin corrections typed into the table). Until that list exists, removing the write access can break something unseen.
2. Give stock corrections one function with a required reason, the acting login, a position, and the same guards as the
   others (no shared position without its pallet, no waiting Nexus request, never below zero or below planned picks). This is
   also the missing cycle-count transaction (item 3 under "Assessed, not fixed").
3. Then narrow the table rule: ShipBay logins read; insert, update and delete only through functions. Decide separately
   whether `shipbay_sales` should read the ledger at all.
4. Make rows append-only (no update or delete for any login), so a correction is always a new row.

Not done in this task by instruction: no ledger grant or rule was altered.

## Screens and HTTP: validated 2026-11-23 (Derek's assignment of 2:30 AM)

### In a browser (local stack, the whole WMS app)

`wms/test/corrections-e2e/` (`run.sh`): a local database built the way dev is (every candidate through 20261205, the dev seed,
PSKU-000001 put away at P-01), real PostgREST checking every token, the four synthetic logins, and the whole WMS app built with
the Pallets screen switched on for that build only (the deployed build keeps it off). Chromium drives the real screens; every
request that is not to 127.0.0.1 is blocked (none was). **113 checks, 113 passed**, after one defect was fixed (below).

| Form | What was shown |
|---|---|
| Open box, reason field | Floor: a different count with no reason is stopped on the screen and nothing is sent; with a reason the database refuses ("Only ShipBay admin or staff...") and the screen shows it; the carton's own count opens normally (one transfer pair, 10 off P-60, 10 onto OB-01). Admin and staff: a reason under four letters is stopped on the screen; a short carton (8 of 10) posts the transfer pair and ONE adjustment of -2 at the position; a carton holding more (12 of 10) posts ONE adjustment of +2 on the shelf; each names the login, the pallet and the reason, with an activity entry. A carton opened twice is refused in plain words. |
| Pallet count correction | Floor: no reason is stopped on the screen; with a reason the database refuses. Admin: a three-letter reason is stopped; a real one saves ("Saved. Stock updated at this position."), the page shows the new count, the ledger has ONE adjustment (-10 at P-61) naming admin, pallet and reason, with an activity entry; the same count again posts nothing. Staff: the same, +9 for nine unopened cartons, the opened carton's loose units untouched. |
| Pick correction | Floor (own wave, pallet then left the building): "Go back to the last stop" is refused, the screen says to ask a manager, no form is offered, nothing sent. Admin and staff (own waves): the form appears; the button is locked with no shelf, or a reason under five letters; a shared position as the shelf is refused ("P-65 is a shared Nexus position..."), a shelf not on file is refused, nothing posted; a ShipBay shelf is accepted: ONE row, +6 on the shelf, naming the manager and the reason, with an activity entry; the stop reopens at the shelf and is picked again (with the barcode scan). |
| Refusals | With a Nexus request waiting on the pallet, both the count correction and the open box are refused and explained on the screen; nothing posted. |
| Client login | Turned away by the app ("This login isn't set up for the WMS"); no function called. |

Every function call from a browser carried the token of the login that browser was signed in as.

### Over HTTP (local stack, real PostgREST)

Floor and client: the three corrections refused (400, role message), the internal `_wms_open_box_do` not callable (also not by
admin or staff), a direct ledger insert refused, a direct update of a carton or pallet row changes nothing. No token, the public
key alone, and a token signed with the wrong secret: refused before any function runs (401). Admin and staff pass the role check
and are then held to the reason rule. After all of it the ledger, unit labels, activity log and carton counts were identical.

### Over HTTP on shipbay-nexus-dev (real Supabase Auth sessions)

A one-off probe (`supabase/dev/probe/corrections.ts`; not the movement runner) sat in the `bridge-smoke` slot for about 15 seconds
behind a 15-minute token gate at 07:45:33Z, then the inert stub went back (version 16, sign-in required, checked). It signed the
four synthetic logins in through Supabase Auth and called the hosted database's API. Every call named a pallet, carton and stop
that do not exist, so none could change a row. **35 checks, 35 passed:**

- Auth issued and confirmed a session for each of the four logins, and each login's profile role is the one expected (4).
- Floor and client: count correction, open-box correction and pick correction refused; the internal function not callable;
  a direct ledger write refused by the access rule; a direct carton update touches no row (12).
- No token, the public key, a made-up token: refused before anything runs (3).
- Admin and staff: each of the three corrections passes the role check, asks for the reason, and with a reason gets as far
  as "not on file"; the internal function is not callable even by them (14).
- The bridge's `/status`, read once as the admin login: connection off (`bridge_off`), pallet moves, registry writes, calendar
  writes and test faults all false (2). This is a direct reading of the three switches at 07:45:33Z.

Not done on hosted, on purpose: a correction that succeeds. A successful correction writes to the dev ledger, and the rehearsal's
preflight expects that ledger exactly as it is (one row of 100). Successful corrections were made in the browser on the local
stack, and at the hosted database in the rolled-back checks of the dev_033 verification.

Hosted dev before and after the probe: pallets, cartons, ledger and journal fingerprints identical (9 pallets, 90 cartons, 1
ledger row of 100, 1 journal entry), 0 unit labels, 0 waves, 0 open requests, 0 runner runs, 30 migrations, PSKU-000001 stored
at P-01. Nexus staging (read-only, 07:47:56Z): the only pallet standing anywhere is PSKU-000001 at P-01; ShipBay's movement key
was last used at 04:26:05Z, so the probe's status read did not reach Nexus.

### Inventory integrity after the browser and HTTP run (local)

One ledger: 600 received (six pallets, one receipt of 100 each, none twice), -3 corrected, -6 picked net = 591 on the books,
and the stock view agrees. Four opened cartons = four transfer pairs, each netting to zero. Five adjustments, each by admin or
staff with its reason and its pallet. Three returned picks, +6 each onto a private shelf, each naming the manager, the stop and
the reason, none tied to the pallet that left. Picks from pallets name their pallet and position. No position below zero. 37
unit labels for 37 loose units. No request left open. PSKU-000001: its row, its receipt, its journal entry and its cartons
byte-for-byte unchanged.

### Defects found

1. **FIXED in the source (not deployed anywhere): the Units box locked itself.** After "Say why the count is being corrected."
   the Save button stayed on "Saving..." and locked until the page was reloaded. The reason is now checked before the button is
   locked (`wms/src/Pallets.jsx`). Only matters once the Pallets screen is switched back on.
2. **FIXED locally in candidate 20261206 (not on dev, not deployed; see the section above): a manager cannot reach a floor picker's stop.** The pick-correction form appears only on the wave of the login that
   picked it. The floor picker is told "ask a manager: they return them to a shelf from this screen", but a manager who signs
   in sees only their own wave (the floor picker's is listed as "Wave 1: Test Floor (picking)" with nothing to open). The
   function itself corrects that stop when an admin calls it (checked over HTTP; the floor screen then sends the picker to the
   shelf). It needs a way in for the manager; not built, because it is a new screen path and needs Derek's say.
3. **OPEN, minor: the put-away receipt carries no person on the ledger row.** The bridge commits a put-away under the service
   login after Nexus accepts, and the stock function stamps the row with the caller, which is nobody. Hosted PSKU-000001's
   receipt has an empty `created_by`; so do the six put-aways of a local suite run. Who scanned is on the journal entry and on
   the pallet, so nothing is lost, but the ledger row alone does not say. Moves, picks, corrections and open boxes do carry the
   person. A fix is a small change to a function the rehearsal exercises, so it needs its own approval and re-verification.
4. **Known, unchanged:** admin and staff logins can still write a ledger row directly (the table's own access rule), with no
   reason and no check. The floor and client logins cannot (checked local and hosted). See "Assessed, not fixed" item 3.
5. **Known, unchanged:** the Billing activity page shows `open_box_corrected`, `pallet_units_corrected` and `pick_corrected`
   under their raw names.

### Not covered, stated plainly

- The browser run is on the local stack, not on a hosted site: there is no hosted WMS build with the Pallets screen on, and the
  cloud browser cannot hold a dev session. Tokens there are signed locally and checked by real PostgREST; sessions issued by
  Supabase Auth were exercised on hosted by the probe, at the API only.
- Mixed pallets (more than one product), NCC pallets and the older pick list's order-line correction were not driven through a
  screen; their functions are covered by the database tests (`units`, `openbox`, `workflow`).
- Phone width was not run for these forms.

## Rehearsal readiness (prepared, NOT executed)

### 1. The runner and the dev database

| Check | Result |
|---|---|
| Dev migrations | 30, the last two `dev_032_pallet_stock_safety` and `dev_033_open_box_safety` |
| Warehouse functions on dev against a full local build of every candidate | 149 compared by body: 147 identical; `wms_brands` and `wms_order_brands` differ as documented (dev_018 copies production's) |
| The five dev helpers the runner calls (`dev_runner_begin`, `dev_runner_finish`, `dev_runner_read`, `dev_movement_snapshot`, `dev_fault_hold`) | Body on dev = body in the repository, 5 of 5 |
| `dev_movement_snapshot().rules` on dev | `void_safety` true, `unit_safety` true (preflight and the `undo` stage refuse to go on without them) |
| dev_033 | Not reported by the snapshot (the suite opens no box). Confirmed from the migration list and the three function bodies; to be confirmed again in the pre-run check |
| The suite on a local database built with dev_032 and dev_033, real Nexus service code | 331 of 331, nine stages |
| The runner under Deno, same database | 13 of 13; most bridge calls in one stage: 22 (limit observed 30, test fails above 25) |
| Other suites, same build | void 6, units 5, open box 5, workflow 6, bridge 16, WMS unit 56: all pass |
| Runner bundle (`bundle.sh`) | Builds and type-checks; gate closed as committed; holds no bridge code, no Nexus key, no Nexus address |

### 2. The nine stages and what Nexus will see

Unchanged from "Proposed sequence" below: `preflight` (23, read-only), `move` (41), `release` (53), `lost` (48), `partial` (39),
`undo` (42), `picks` (24), `stops` (40), `final` (21, read-only). From ShipBay Nexus sees 8 put-aways, 7 moves and 3 releases,
plus one refused move on record; the three releases free positions the suite itself took (P-13, P-14, P-18). End state: ShipBay
holds P-01, P-12, P-13, P-16, P-17 and P-20.

### 3. Floor, preflight, stop, idempotency, reconciliation

- **Floor.** Every request goes to `HILLSBOROUGH-TEST` (synthetic; the bridge accepts no other address than Nexus staging, and
  ShipBay's movement key is scoped to that floor). Positions P-11 to P-20 only. The live floor `HILLSBOROUGH` is not
  initialized and has moves off (read 07:47:56Z). P-01 is never named in a request.
- **Preflight** (sends nothing): status is staging / test floor / moves on / calendar and position-list writes off; the three
  refusals for no sign-in, public key and client; Nexus reports the test floor, map version 4, the agreed checksum, moves
  enabled; P-11 to P-20 empty for every company; PSKU-000001 as it is in ShipBay and in Nexus; both stock rules present.
- **Stopping.** A stage checks its starting state and stops at the first failed check; nothing is retried, repaired or released
  to tidy up. A writing stage can be started once. Between stages nothing runs. To stop for good: Derek deletes
  `NEXUS_PALLET_MOVES` (the bridge then answers 503 before asking Nexus) and the stub goes back into `bridge-smoke`. There is
  no way to interrupt a stage half-way from outside other than those two; a stage makes at most 22 bridge calls. How long a
  stage takes on hosted is not known until `move` has run.
- **Idempotency.** Each ShipBay request carries one key, kept on its journal row; a repeat (re-scan, retry run, lost answer) sends
  the same key and Nexus answers from its record of the first. Proven locally in the `release`, `lost` and `stops` stages
  (answers dropped by the test fault, then recovered by re-scan or the retry run). Not yet seen on hosted.
- **Reconciliation.** "Nexus accepted, ShipBay did not record" is produced by the HOLD fault in `partial` and `undo`; the admin
  records it (pallet is there) or undoes it (pallet is not, with one corrective release); the position is never released
  automatically. While a request is unsettled the void, the count change and the open box are refused.

### 4. Deployment and rollback sequence (each numbered step needs its own go)

1. **Pre-run check, read-only (me).** Dev: migrations, function bodies, fingerprints, 0 open requests, 0 runner runs, PSKU-000001.
   Nexus staging: occupancy, P-11 to P-20 empty, map version and function fingerprint, ShipBay key state. Stop if anything
   differs from this note.
2. **Runner (me, on approval).** `bundle.sh` into an empty folder; set a one-hour gate (hash of a fresh token); deploy into
   `bridge-smoke` with sign-in off. Read the deployed files back.
3. **Switches (Derek, by hand, dev only).** `NEXUS_BRIDGE_MODE` = `staging`, `NEXUS_PALLET_MOVES` = `on`, `NEXUS_TEST_FAULTS` = `on`.
4. **`preflight`.** Read-only. Report. Derek's go for each writing stage after that, one at a time, with the result and the
   Nexus-side read-only check between stages.
5. **After `final`, or at any stop:** Derek deletes the three switches; the stub goes back; a signed-in status read confirms
   off; dev and Nexus staging are read and reported.

Rollback, by what has happened:

| Stopped at | State | What is done |
|---|---|---|
| Before step 3 | Runner deployed, bridge off | Stub back. Nothing else to undo. |
| After `preflight` | Nothing written | Switches off, stub back. |
| A writing stage finished and passed | Dev and Nexus agree; synthetic pallets stand at test positions | Switches off, stub back. Nothing is released to tidy up: the pallets stay as the record of the stage. A later run starts from the next stage. |
| A writing stage stopped at a failed check | Possibly a request waiting or out of sync | Switches stay as they are until it is read: `/pending` and `/reconcile` (read-only) show every open request; each is settled by the bridge's own retry, record or undo, with Derek's go per action. Then switches off, stub back. The dev database is not reset. |
| The bridge itself misbehaves | | Switches off first. The previous bridge version's files are in git (commit 2656215 is the one deployed); redeploying an older version is a separate approval. |

Never part of a rollback: touching P-01 or PSKU-000001, releasing a position the suite did not take, editing Nexus rows, or
resetting the dev database.

### 5. What must be read fresh immediately before execution

1. **Nexus's code. RETESTED 2026-11-23 evening against what staging runs now** (see "dev_034 applied" at the top): the
   destinations-only rule (007) is on staging, and the suite, the runner and the bridge tests pass against it locally.
   Staging's function fingerprint to compare before execution: 34 functions, `e4d5a270...` (names, arguments and bodies,
   C order). A different value means "retest first".
2. **Occupancy.** P-11 to P-20 empty for every company (they were at 07:47:56Z). Souled's P-02 placement does not touch them and
   the suite never names P-02, but preflight only protects the moment it runs: Souled must stay off P-11 to P-20 for the whole
   window, or a stage will meet `location_full` half-way and stop.
3. **PSKU-000001 at P-01** in both systems, and whether Souled's P-02 test expects anything of P-01 during the window.
4. **Switches**: read off before step 3, on after it, off again at the end, each by a signed-in status call.
5. **ShipBay's movement key**: active, scoped to the test floor, no error on record (last used 04:26:05Z).
6. **The call limit**: 30 calls from one function to another were observed; whether that is per request or per minute is not
   known. `move` (17 calls) is the first real test; stages should not be started back to back within a minute until that is seen.
7. **Dev database**: one ledger row of 100, 0 open requests, 0 waves, 0 runner runs; the six seeded pallets open. Any dev check
   run between now and then must be a rolled-back one.

## Production-only billing functions: NOT verified

They exist only in production (applied 2026-11-20). Their SQL is not in the repository (`supabase/candidates/20261125_billing_rates.md`
is a two-line note) and they are not on dev. Production was not read for this: one read-only look at its function list was
refused by the session's access rules earlier today and was not retried or worked around.

| Object | Called from | What is known | What is not |
|---|---|---|---|
| `billing_estimate(p_org, p_month)` | Portal, Billing page | Returns one row per billing setting: code, label, source, qty, rate, unit, note | How `qty` is counted for each source |
| `billing_rates_list(p_org)` | Portal, Billing settings | Lists a brand's rates | Body |
| `billing_rate_save(...)` | Portal, Billing settings (admin) | Saves a rate with a source | Body; which sources it accepts |
| `billing_rates` (table) | The three above | Vinyl Moon has the 12 rates of its signed agreement | Columns, rules, policies |
| Anything else in production that is not in the repository's migrations | | | Not listed, not checked |

The sources a rate can count from, as the portal lists them: by hand, pallets received, stored pallets x 53 cu ft, shipments,
units picked, units pack-checked, carton scans, pallet labels printed, pallets put away, cycle-count scans. Four specific
questions the function's text has to answer before these repairs reach production:

1. **Units picked.** A pick correction puts the units back as a ledger row with reason `pick` and a POSITIVE quantity, and logs
   `pick_corrected`. If the estimate adds up pick rows by size, or counts pick events, a corrected-and-repicked stop bills twice
   (6 + 6) or three times; if it adds signed quantities it bills once. Not known which.
2. **Stored pallets.** Pallets can now be `off_floor` or `departed`. If the estimate counts pallets "not void" rather than
   "stored", a pallet that left keeps being billed for storage; if it counts `stored` only, an off-floor pallet still in
   ShipBay's custody stops being billed. Not known which.
3. **Ledger reasons.** Opening a box on a put-away pallet now writes `transfer` rows where it wrote `adjust` and `receive`
   rows. If any charge counts `receive` rows (as "units received") or `adjust` rows, its numbers change. Not known.
4. **Pallets put away.** A pallet taken off the shared floor and put back is put away twice (the rehearsal does exactly this
   with one pallet). If the charge counts put-away events, that is two charges for one pallet. Not known.

To close this: Derek (or a session he authorizes for a read-only look at production) pastes or exports the text of
`billing_estimate`; the four questions are answered by reading it. Nothing in production billing is changed either way.

## dev_033 applied to shipbay-nexus-dev and verified

Applied as migration `dev_033_open_box_safety` (the 30th). Reviewed before applying: it replaces `wms_open_box`, adds
`wms_open_box_correct` and the internal `_wms_open_box_do`, one revoke for each new function and one grant; no DROP and no
statement that touches a row. (The function itself rewrites the two ledger rows it has just created in the same call; it never
touches a row that existed before the call.)

| Check on the hosted dev database | Result |
|---|---|
| The three function bodies equal the committed file (md5 of the stored source) | 3 of 3 |
| The other 156 functions in the public schema | One fingerprint, identical before and after |
| Permissions | Public key: none of the three. Signed-in logins: `wms_open_box` and `wms_open_box_correct` (each checks the role itself). `_wms_open_box_do`: no login and not the service login |
| `openbox-check.sql` | 8 of 8, rolled back: the six prepared checks plus two added for this verification (a wave pick and pack with boxes opened around it; admin, shipbay_staff, floor and client) |
| `stock-safety-check.sql` | 7 of 7, rolled back |
| `regression.sql` | 15 of 15, rolled back |
| `workflow-check.sql` (wave pick, pack station, packing, older pick list, correction) | 6 of 6, rolled back |
| Pallets, cartons, unit labels, ledger, journal: fingerprints before the migration, after it, and after the four checks | Identical each time (9 pallets, 90 cartons, 0 unit labels, 1 ledger row of 100, 1 journal entry) |
| Positions below zero; a pallet received twice at one place; correction log rows left behind; open requests | 0, 0, 0, 0 |
| PSKU-000001 | Stored at P-01, one receipt of 100, one journal entry (04:26:05Z), no carton opened |
| Nexus staging (read-only) | ShipBay holds P-01 with PSKU-000001 and nothing else; one ShipBay move on record; movement key last used 04:26:05Z, no key error |
| Functions deployed | `nexus-bridge` version 7 and `bridge-smoke` version 14 (inert stub), both unchanged; 0 runner runs |

What the hosted open-box check showed: a short box found before put-away posts nothing and put-away then receives 90 and 7 once
each; on a put-away pallet a count other than the carton's is refused for the floor and the carton's own 10 move as one transfer
pair netting to zero; an admin correction (8 in a carton of 10) is one transfer pair plus one adjustment with reason, person and
an activity entry; with everything picked a further carton is refused; no box is opened under a waiting or out-of-sync Nexus
request or on a departed pallet; with a wave planning 85 at a position holding 100, one carton can be opened and a second
cannot, the stop is picked, the wave goes to the pack station and the order is packed, stock down by exactly 85;
`shipbay_staff` and admin can each correct with a reason of substance and are named on the ledger row and the activity entry,
the floor and client logins cannot, and the floor login cannot reach the internal function.

### Who reads the ledger reasons and the activity kinds

Checked on the dev database (every function and view outside the system schemas) and in the repository (portal, WMS, site,
Nexus screens, Edge Functions, production migrations):

- **Stock on hand** (`inventory_levels` view, `wms_stock`, the client portal's warehouse page, the wave planner, the Nexus brand
  counts and first-in-first-out helpers): they add up quantities and never look at the reason. A transfer pair nets to zero, so
  totals are the same as before.
- **No function or view on dev tests for `receive`, `adjust` or `transfer`** except the writers themselves and the dev test
  snapshot. The production migrations in the repository that read the ledger (`ship_order`, `receive_inbound`,
  `finalize_inbound`, `wms_pick`, `wms_unpick`, `wms_stock`, `inventory_levels`) do not test the reason either.
- **Activity log** (`wms_activity_summary`, `wms_activity_recent`, the portal's Billing page): they list every kind with its
  count. Two things follow. The existing `carton_open_box` entry is unchanged (one per opened carton, quantity = units found).
  The new kinds `open_box_corrected` and `pallet_units_corrected` (and `pick_corrected` from 20261203) will appear on the
  Billing activity table and its CSV under their raw names, because that page has no label for them. They are counts only.
- **Could not be checked: `billing_estimate`, `billing_rates_list`, `billing_rate_save` and the `billing_rates` table.** They
  exist only in production (applied 2026-11-20; their SQL is not in the repository) and are not on dev. The portal lists the
  sources a charge can count from (pallets received, stored pallets, shipments, units picked, pack checks, carton scans, label
  prints, put-aways, cycle-count scans, by hand); none is a ledger reason or an open-box kind by name, but the function body was
  not read, so it is NOT assumed compatible. One read-only look at production's function list was attempted to name any other
  production-only reader and was refused by the session's access rules; nothing in production was read or changed. Any
  production function or view that is not in the repository's migrations is therefore unlisted and unchecked.
- QuickBooks and HubSpot code in the repository does not read the stock ledger.

Stated plainly:
- The switches were not read again for this step (that needs a signed-in call, and no probe was approved for it). Last direct
  reading: off, at 06:49:35Z. Since then no function has been deployed or changed, nothing in this session set a switch, and
  Nexus shows no ShipBay request and no key error.
- Not run in a browser: the reason field on the open-box dialog, the count-correction form, the pick-correction form.
- The roles were exercised at the database with each synthetic login's identity (the same check the API applies), not through a
  signed-in HTTP session.
- The rolled-back checks consumed pallet, carton, unit and package label numbers; no row was left behind.

## Open-box stock safety (candidate 20261205): the repair

Reproduced first on the database without the fix, with `wms_open_box` as a floor login on put-away pallets of 10 x 10:

| Case | Result before the fix |
|---|---|
| Carton of 10 opened as 25 | 15 units created. Ledger: one `adjust` -10, one `receive` +1 and twenty-four `adjust` +1 |
| Carton of 10 opened as 4 | 6 units lost, no reason on record |
| No-carton-count (NCC) carton opened | Its 10 stay at the position and 10 more appear on the shelf |
| 95 picked, then a carton opened | Position at minus 5 |
| Wave has 95 planned, then a carton opened | 90 left at the position under a 95-unit stop |
| Box opened under a waiting Nexus move | Accepted |
| Box opened on a departed pallet | 10 unit labels made, the carton marked opened, ledger unchanged: they disagree |

The repair (`supabase/candidates/20261205_wms_open_box_safety.sql`), with the existing function keeping its name and arguments:

- `wms_open_box` (any floor login, as today). Before put-away it does exactly what it did: the count found in the box is entered
  and nothing is posted until put-away. On a put-away pallet the number must equal the carton's count on file, and it is
  recorded as one transfer pair that nets to zero, naming the carton and both places.
- `wms_open_box_correct(carton, units, shelf, reason)` (new; ShipBay admin or staff; reason required): a put-away carton that
  really holds a different number. The units found move as a transfer pair; the difference is one `adjust` row carrying the
  reason and who, with an activity-log entry (`open_box_corrected`: carton, on file, found, difference, position, shelf, reason).
- Both refuse, with nothing changed: an NCC carton; a pallet with a Nexus request waiting or out of sync; a pallet off the
  shared floor or departed; a shared Nexus position as the shelf; and any result that would leave the position below what waves
  have planned there (so never below zero) or the pallet holding less than was picked from it plus what is planned.
- The function checks its own posting: if the stock function posted anything other than "the carton's count off the position,
  the units found onto the shelf", it raises and everything is taken back.

One change to the ledger's wording, for Derek to know: opening a box on a put-away pallet used to appear as `adjust` and
`receive` rows; it now appears as `transfer` rows. Quantities per place are the same as before for an exact count. Nothing in
the warehouse functions, the WMS source or the portal source reads those reasons. Billing and reporting functions that live only in
the production database are outside the extract used here and were not searched: say so if one depends on them.

Tests: `supabase/tests/staging/openbox.test.mjs`, 5 tests (receiving before put-away, exact opening, moved pallet, second shelf,
corrected count both ways, authorization and reason, heavy picks, unpick, planned wave, packed order, waiting and out-of-sync
requests and reconciliation, departed, off-floor, NCC, void afterwards). "One receipt" is stated precisely there: a pallet opened
before put-away is received in two places by design (cartons at the position, loose units on the shelf), so the rule checked is
no second receive row for the same pallet, product and place.

Applied to dev 2026-11-23 (see above): `supabase/dev/pending/dev_033_open_box_safety.sql` (three functions, one revoke pair, one grant; no
DROP, no data) and a fourth rolled-back check `supabase/dev/openbox-check.sql` (6 checks). Tested locally on a database built the
way dev is now (through dev_032, PSKU-000001 stored at P-01): after dev_033 every public function matches a full build (one
fingerprint over 155), and the open-box check (6), stock-safety check (7), regression (15) and workflow check (6) pass with
PSKU-000001, its receipt and the ledger byte-for-byte unchanged. Without dev_033 the open-box check refuses to run.

The count-correction field on the Pallets screen's open-box dialog compiles; it was not run in a browser (that screen is
switched off in the build).

## dev_032 applied to shipbay-nexus-dev (approved by Derek, 2026-11-23 1:36 AM)

Applied as migration `dev_032_pallet_stock_safety` (the 29th), the file reviewed before applying: five `create or replace
function`, one revoke, one grant, nothing else.

| Check on the hosted dev database | Result |
|---|---|
| Body of each of the five functions equals the committed file (md5 of the stored source) | 5 of 5 |
| The other 152 functions in the public schema | One fingerprint, identical before and after |
| Permissions: none of the five open to the public key; void, count entry and count correction for signed-in logins; the two dev helpers for the service login only | As intended |
| `regression.sql` (receiving, put-away, HOLD, wave pick, move, release, out of sync, void, privileges, calendar, ledger) | 15 of 15, rolled back |
| `workflow-check.sql` (labels, wave pick, pack station, packing, older pick list, correction, totals, authorization) | 6 of 6, rolled back |
| `stock-safety-check.sql` (new; below) | 7 of 7, rolled back |
| Pallets, cartons, ledger, journal: fingerprints before the migration, after it, and after the three checks | Identical each time (9 pallets, 90 cartons, 1 ledger row of 100, 1 journal entry) |
| Positions below zero, pallets with two receipts, count-correction log rows left behind | 0, 0, 0 |
| PSKU-000001 | Stored at P-01, one receipt of 100, one journal entry (04:26:05Z) |
| Nexus staging (read-only) | P-01 holds PSKU-000001 for ShipBay and nothing else of ShipBay's; one ShipBay move on record; movement key last used 04:26:05Z; the real floor not initialized, moves off |
| Functions deployed | `nexus-bridge` version 7 and `bridge-smoke` version 12 (inert stub), both unchanged |

`supabase/dev/stock-safety-check.sql` runs as the synthetic logins on pallets it receives itself (P-56 to P-59), sends nothing
to Nexus, and rolls everything back. What it showed on hosted:

1. Void after a partial pick (100 received, 30 picked): refused for admin and floor; ledger, pallet, the 70 at the position
   and the pick unchanged.
2. Unsafe count changes: floor and client refused, below-picked and zero refused, missing reason refused; cartons, ledger and
   activity log unchanged.
3. A legitimate correction (admin, reason): exactly the difference posted once; the ledger row carries the reason, position
   and who; the activity log has old count, new count, change, position and reason; the same value again posts nothing; the
   receipt untouched.
4. Planned wave stop: void refused; the count cannot go below picked plus the 12 planned.
5. Unsettled Nexus movement (waiting put-away, waiting move, out of sync): void and count change refused each time.
6. Departed pallet: void and count change refused; its 100 units stay on the books.
7. Afterwards: nothing below zero, no double receipt, transfers net to zero, the stock view equals the ledger, and everything
   on file before the check is byte-for-byte unchanged.

Stated plainly:
- The switches cannot be read from here without a signed-in call, and none was made (no probe was deployed for this step).
  They were read as off by the probe at 1:01 AM; nothing in this session has set one since; the bridge function is unchanged
  and Nexus shows no ShipBay request since 04:26:05Z.
- The rolled-back checks consume label numbers: the pallet, carton and package counters do not roll back, so the next real
  synthetic pallet will have a higher PSKU number than the last one on file. No row was left behind.
- The count-correction form on the Pallets screen was not run in a browser.

## Pallet stock safety (candidate 20261204): void and unit count (on dev as dev_032)

One candidate, `supabase/candidates/20261204_wms_pallet_stock_safety.sql`. The void part was accepted by Derek as locally tested
(commit f08a83f), including the rule for departed pallets.

### Void

It replaces `wms_void_pallet`. Before: a void set the status, and the stock
trigger then took everything the pallet had posted off the books, whatever had been picked and whatever Nexus was doing.
Now a void is refused, with nothing changed, when:

- a Nexus request for the pallet is not settled (waiting for an answer, or accepted by Nexus and not recorded by ShipBay);
- a wave still has a pick planned from it;
- units have been picked from it and not put back ("30 of PSKU-...'s units have been picked ... undo those picks first");
- taking its units off would leave any position below zero (older picks that name no pallet);
- it has left the building (status departed): a void there would write the departed units off with the generic adjust reason.
  Kept by Derek's decision, 2026-11-23 1:26 AM.

A void that passes posts exactly what it posted before. Reconciliation is unchanged: record and undo for an out-of-sync
request work as before, and the pallet can be voided once the request is settled. The void takes the same row lock every
Nexus request takes first, so a void and a scan for the same pallet cannot pass each other.

Tests: `supabase/tests/staging/void.test.mjs`, 6 tests, all fail without the candidate and pass with it (real Nexus service code,
local). They cover the 100/30 case, a wave stop planned and picked, a pick that travelled with a moved pallet, an older pick with
no pallet, a void during a waiting put-away and a waiting move, both out-of-sync resolutions, a correction whose own answer was
lost, departed and off-floor pallets, totals, one receipt per pallet, and no position below zero.

### Unit count

Reproduced first on the database without the fix, with `wms_set_units` as any floor login:

| Case | Result before the fix |
|---|---|
| 100 received, 30 picked, count set to 2 per carton | P-02 at minus 10 |
| Wave has 12 planned, count set to 0 | Position empty, stop still planned for 12; the picker is told "Only 0 on file" |
| Move waiting on Nexus, count set to 5 per carton | Accepted: 50 written off under an unsettled move (it ended consistent at the new position, by luck of ordering) |
| Departed pallet, count set to 1 per carton | Cartons say 10, ledger says 100: they disagree from then on |

Now there are two functions:

- `wms_set_units` (same name and arguments, any floor login): entering the count before the pallet holds stock, and the first
  count of a put-away pallet that never had one. Refused for a put-away pallet that already has a count, while a Nexus request
  is not settled, and for a pallet off the shared floor or departed.
- `wms_correct_units(pallet, item, units, reason)` (new; ShipBay admin or staff; reason required): changing the count of a
  put-away pallet. Refused while a Nexus request is not settled. It posts the same difference the old function posted, then
  takes everything back if the pallet would hold less than what was picked from it plus what waves still plan to pick from it,
  or if any position would end below what waves have planned there (so never below zero). The reason goes on the ledger row
  and into the activity log (`pallet_units_corrected`) with the old count, the new count, the change and who did it.

The Pallets screen asks for the reason and calls the new function for a put-away, counted pallet. That form compiles; it was
not run in a browser (the Pallets screen is switched off in the build).

Tests: `supabase/tests/staging/units.test.mjs`, 5 tests: clean changes before and after put-away, authorization and reason,
partial pick, unpick, a moved pallet, a planned wave stop, a packed order, an older pick with no pallet, a waiting put-away and
move, an out-of-sync request and its reconciliation, departed and off-floor pallets, one receipt per pallet, no position below
zero.

### The rehearsal

It no longer uses a void to produce its second partial failure: the only `wms_void_pallet` calls left in the suite are two that
must be refused and one made after the request is settled. Both partial failures use the HOLD fault. The second is its own
stage, `undo`, and also checks that a void and a count change are refused while the request is waiting and while it is out of
sync. Preflight, and the `undo` stage before it sends anything, refuse to go on unless the database has both rules (read from
the snapshot). The suite is 9 stages, 331 checks.

### Combined development migration (applied to dev 2026-11-23; see above)

`supabase/dev/pending/dev_032_pallet_stock_safety.sql`, generated by `build.sh` next to it: the candidate (three functions
replaced or added) and the two dev helpers that changed since dev_029 (`dev_movement_snapshot` reports the rules,
`dev_runner_begin` knows the `undo` stage). No table, row, pallet, stock entry or journal entry is touched, and there is no DROP.
Tested locally: a database built the way dev is today (candidates to 20261203, helpers as of dev_029), then dev_032 in one
transaction. Every function in the public schema then has the same body and grants as a full build (one fingerprint over 153
functions), and the dev regression (15), the workflow check (6) and the whole suite (331) pass on it. On a database without
dev_032 preflight fails and `undo` stops at its start check.

## Bridge deployed to shipbay-nexus-dev (step 2)

`nexus-bridge` version 7 (was 6), from commit 2656215, sign-in required at the gateway, bundle hash `2e05a7ab...0dfe1092`. The five
deployed files were read back and match the committed source by reading; no byte hash of the deployed copy can be computed
with the tools used here. No switch was set.

Disabled-mode check with genuine sessions: a one-off probe (`supabase/dev/probe/index.ts`, not the movement runner, no suite, no
database writes) sat in the `bridge-smoke` slot for about two minutes behind a 15-minute token gate, then the inert stub went
back (version 12, sign-in required). It signed the floor, admin and client logins in through Supabase Auth and called the
deployed bridge. 97 checks, 96 passed:

- No authorization header, or a made-up token: 401 on status, put-away, move and release (8 of 8).
- Status, as floor, admin, client and the public key: 200, connection off, reason `bridge_off`, pallet moves, registry writes,
  calendar writes and test faults all false (16 of 16).
- Put-away, move, release, pending retry, reconcile record and undo, registry sync, calendar sync, floor, pending, reconcile
  and calendar: 503 `bridge_off` for all four callers (48 of 48).
- The lost-answer header on put-away, move and release as floor, admin and client: 503 `bridge_off`, no fault produced; status
  still reports test faults false (10 of 10).
- Database, same sessions: `is_wms_staff` true for floor and admin, false for client; the exceptions report refused for the
  client and the public key (5 of 5).
- The one failure was the probe's own expectation: it expected the floor login to read the exceptions report. The report is
  for ShipBay admin and staff and refuses `wms_employee` by design (the local test asserts that refusal). The committed probe
  is corrected; the corrected line and "admin can read it" were not rerun on hosted.

Not observable while the bridge is off: the 403 `not_staff` answer. Every route but status answers `bridge_off` before it looks
at the login, so the client login gets 503, not 403. The staff check itself is proven locally (bridge tests) and, on hosted,
at the database (`is_wms_staff`). It gets its hosted proof in the suite's stages once the bridge is on.

The first probe attempt stopped at 45 checks, all passing, on Supabase's limit of about 30 calls from one function to another
per request; the probe was split into three parts and rerun in full.

**Blocker for step 3 found here.** The limit that stopped the first probe applies to the movement runner too: the 31st call
from the probe to the bridge inside one request was refused by the platform ("Rate limit exceeded for trace", retry after 59
seconds); 30 went through. A writing stage can be started only once, so a stage cut off part-way would leave some Nexus writes
done and others not. Correction to the first version of this note: "about 50" counted database calls too. Counted properly,
only the `partial` stage reached the limit (30 calls to the bridge). It is now two stages (`partial` 19, `undo` 17); the largest
is `release` with 22, and the runner's test fails if any stage exceeds 25. The exact limit is observed, not documented here
(30 passed, the 31st failed; whether it is per request or per minute is not known), so the first hosted stage after preflight
is still the real test of it.

After the probe: `workflow-check.sql` 6 of 6 on hosted (run after the deploy). Dev database: PSKU-000001 stored at P-01, ledger one
row of 100, one journal entry (04:26:05Z), 9 pallets, 0 waves, 0 runner runs, 28 migrations. Nexus staging: occupancy is
PSKU-000001 at P-01 only, 12 moves in total, one of them ShipBay's, last move and the movement key's last use both 04:26:05Z,
no audit or change entries since the deploy.

## Applied to shipbay-nexus-dev (step 1)

| Migration | What |
|---|---|
| `dev_028a_candidate_20261203_workflow_existing_functions` | Three helpers, and the eleven existing functions with the candidate's edits. |
| `dev_028b_candidate_20261203_workflow_report_and_correction` | The exceptions report and the manager's pick correction. No close-out action. |
| `dev_029_movement_rehearsal_helpers` | Read-only snapshot, the runner's run-once record, one fault helper. Service login only. |
| `dev_030_movement_seed_six_pallets_one_order` | PSKU-000016 to PSKU-000021 (60 cartons) and order SYN-ORD-1. No stock posted. |
| `dev_031_repair_check_counts_only_its_own_orders` | The dev repair check counted every order with a cut-off; the seeded order made it fail. It now counts its own four. |

All sixteen changed or new functions on the hosted database have the same body fingerprint as the committed candidate.
Hosted results: `regression.sql` 15 of 15, `workflow-check.sql` 6 of 6 (pick, pack, labels, older pick list, manager correction,
totals, authorization), `dev_repair_check()` pass, `dev_security_check()` pass. All four roll themselves back. PSKU-000001 is
stored at P-01 with its one journal entry and its one 100-unit receipt, byte-for-byte as before; the ledger is still one row of 100.

## State

| | |
|---|---|
| Workflow repairs | `supabase/candidates/20261203_wms_inventory_workflow.sql`. Applied to the dev database only. |
| Regression tests for the repairs | `supabase/tests/staging/workflow.test.mjs`, 6 tests, all pass locally (real Nexus service code). |
| Hosted suite | `supabase/tests/hosted/suite.js`: 9 stages, 331 checks. Passes locally under Node and through the runner under Deno. |
| Lost answers | Produced by the bridge's own dev-only test fault. The runner no longer holds bridge code or reads the Nexus key. |
| Void and unit-count safety | `supabase/candidates/20261204_wms_pallet_stock_safety.sql`, `void.test.mjs` (6 tests), `units.test.mjs` (5 tests). On the dev database as `dev_032` (`supabase/dev/pending/dev_032_pallet_stock_safety.sql`); not in production. |
| Open-box safety | `supabase/candidates/20261205_wms_open_box_safety.sql`, `openbox.test.mjs` (5 tests). On the dev database as `dev_033`; not in production. Hosted check: `supabase/dev/openbox-check.sql` (8 checks). |
| Existing tests | Bridge 16, Edge wrapper 4, waves/receiving/dock/registry/activity unchanged and passing, dev regression 15 checks, WMS unit 56, put-away browser test 29. |

## What the repairs change (20261203)

1. **Planned wave stops follow the pallet.** When Nexus confirms a move, every stop planned from that pallet and not yet picked is
   re-pointed to the confirmed position. Confirming a stop also checks where the pallet stands. A pallet with a planned stop cannot
   be released (an admin's forced correction still can; the stop then takes 0 and goes to a manager).
2. **Older pick list.** A pick now records its pallet and travels with it. Undo puts the units where the pallet stands now and is
   refused if the pallet has left the floor. Older picks with no pallet are tied to the pallet when it moves from a one-pallet
   position (the pallet reference only; no quantity is touched).
3. **Pallets screen.** No pallet in any state can be given a shared position outside the Nexus journal: the screen's function
   refuses and a table rule refuses every other path. The map shows a shared position as "Nexus", never "Free" or taken, unless a
   pallet Nexus accepted is stored there.
4. **Receiving.** Completing a carton count never suggests a shared position. A pallet bound for the shared floor has no position
   until Nexus accepts the scan under Put away.
5. **Pending movements.** While Nexus has not settled a pallet's request (waiting, or accepted and not recorded): its stock is not
   offered to the wave planner or the older pick list, its planned stop cannot be confirmed, a pick from it cannot be reopened or
   undone, it cannot be reserved, and a second movement is refused (as before).
6. **Exceptions report.** `wms_nexus_exceptions()` (admin or staff; shown on the Put away screen and returned by the bridge's
   reconcile route): departed pallets with units still on the books, pallets off the floor, positions held in ShipBay only, planned
   stops whose pallet is not where the stop says, older picks at shared positions that name no pallet. It is a report only: by
   Derek's decision there is no close-out or deduction action, and a departed pallet's units stay on the books until the release
   is connected to ShipBay's normal confirmed outbound transaction.
7. **Manager correction.** `wms_pick_correct('wave_stop' | 'order_line', id, shelf, reason)`: admin or staff, reason required. The
   picked units go back onto a private, pickable ShipBay location, never a shared position, and the stop or line reopens there.
   Offered on the pick screen where the normal reopen is refused.

Unchanged: receiving, labels, carton counting, HOLD, packing, wave routing and allocation order, one receipt per pallet, a
release never deducts stock, and every quantity an existing function posts. The existing wave pick-and-pack test passes with the
new candidate loaded.

## Decisions for Derek

- **Departed stock and the outbound transaction (decided 2026-11-23).** No deduction with the generic adjust reason. The report
  stays; the close-out waits for integration with the confirmed outbound transaction. Today that transaction is `ship_order`,
  which posts by order and product with no position and no pallet. Connecting it to a departed pallet is design work not started.
- **Applying 20261203 to production is part of the cut-over**, with 20261202: after it the old Pallets screen cannot place a
  pallet on P-01..P-66 or STG-01/02 at all.

## Not covered, stated plainly

- The manager correction form on the pick screen compiles and its function is tested; the form itself was not run in a browser
  (the orders browser test needs the full local stack, which was not rebuilt).
- At the two multi-pallet staging areas, an older pick with no pallet cannot be tied to one automatically. It is reported.
- No existing record is back-filled or changed by applying the candidate. Older cases appear in the report.

## Assessed, not fixed: before real inventory

Reproduced on the local database, or read from the code where stated. None of these blocks the synthetic rehearsal.

1. **Voiding a stored pallet after picks left a negative position.** FIXED in candidate 20261204 (on dev, not production): refused.
2. **Voiding while a request is waiting.** FIXED in candidate 20261204 (on dev, not production): refused until the request is settled.
6. **Changing a stored pallet's unit count had the same gaps.** FIXED in candidate 20261204 (on dev, not production).
7. **Opening a carton on a put-away pallet had none of these checks.** Reproduced, and FIXED in candidate 20261205 (on dev, not
   in production).
8. **Loose units on the open-box shelf have no pallet on their picks** (from the code): a pick from OB-01 is a shelf pick. The
   void and count rules protect the shelf through the "never below zero" check, not through the pallet. Not changed.
3. **There is no cycle-count transaction.** No function posts a count. Stock corrections today are direct ledger entries by
   ShipBay logins (the table's own access rule allows them), with no pallet, at any position including shared ones, and with no
   check for a waiting movement. A correction at a shared position does not travel with the pallet when it moves (from the code).
4. **Packing stage.** Once a wave is at the pack station nothing returns picked units to stock: reopening is refused and the
   manager correction only works while the wave is still being picked (from the code). This is independent of Nexus. Extending the
   correction to an unpacked order at the pack station needs a rule for what happens to the order.
5. **`ship_order` and portal receiving post stock with no position** (from the code). They predate positions and were not changed.

## The pallets and positions

PSKU-000001 at P-01 is never named in any request. The suite refuses to send one that does, and checks ShipBay's row, its one
receipt, its one journal entry and Nexus's own answer for P-01 before and after every stage.

| Part | Pallet | Units | Positions | What happens |
|---|---|---|---|---|
| KEEP | PSKU-000001 | 100 | P-01 | Nothing. Left for Souled's cross-company conflict test. |
| M | PSKU-000002 | 100 | P-11, then P-12 | Put away, moved. |
| HELD | PSKU-000003 | 50 | none | On HOLD since receiving: refused by ShipBay, never reaches Nexus. |
| R1 | PSKU-000016, batch `syn-move-1` #1 | 200 | P-13 | Released off the shared floor (still in custody), then put back. |
| R2 | `syn-move-1` #2 | 200 | P-14 | Released as shipped out; the answer to the release is lost and re-sent. |
| L | `syn-move-1` #3 | 200 | P-15, then P-16 | Both Nexus answers lost: one finished by re-scan, one by the retry run. |
| F1 | `syn-move-1` #4 | 200 | P-17 | Nexus accepted, ShipBay could not record; admin confirms it IS there. |
| F2 | `syn-move-2` #1 | 1000 | P-18 | Stage `undo`. Nexus accepted, ShipBay could not record; admin confirms it is NOT there; then voided. |
| G | `syn-move-2` #2 | 1000 | P-19, P-20 | Part-picked, moved, reopened; then its planned stop follows it P-20, P-19, P-20. |

On the hosted database the six new pallets are PSKU-000016 to PSKU-000021. The suite finds them by receipt batch, not by number. P-11 to P-20 were open and empty in Nexus staging on 2026-11-22
(read-only check). Preflight checks again and stops if not.

## Proposed sequence

Each numbered step that changes anything needs its own go. A stage that writes can be started once; it checks its starting
state first and stops at the first failed check. Nothing is retried, repaired or released to clean up.

1. **Dev database. DONE 2026-11-23** (approved by Derek). See "Applied to shipbay-nexus-dev" above.
2. **Bridge. DONE 2026-11-23** (approved by Derek). See "Bridge deployed to shipbay-nexus-dev" above.
3. **Dev database again: DONE 2026-11-23** (dev_032, approved by Derek). **Then the runner (approval).** `bundle.sh`, set the one-hour gate, deploy the runner into the existing `bridge-smoke` slot in dev. The stages now fit the
   call limit observed in step 2.
4. **Switches (Derek, by hand, dev only).** `NEXUS_BRIDGE_MODE` = `staging`, `NEXUS_PALLET_MOVES` = `on`, `NEXUS_TEST_FAULTS` = `on`.
5. **`preflight`** (read-only, 23 checks).
6. **`move`** (41). Nexus: put-away M at P-11 and R1 at P-13, one refused move, move M to P-12.
7. **`release`** (53). Nexus: release R1 from P-13, put R1 back, put-away R2 at P-14, release R2 from P-14.
8. **`lost`** (48). Nexus: put-away L at P-15, move L to P-16, each answer dropped once and recovered.
9. **`partial`** (39). Nexus: put-away F1 at P-17; the admin records it.
10. **`undo`** (42). Nexus: put-away F2 at P-18, one corrective release of P-18. Voids refused while unsettled, accepted after.
11. **`picks`** (24). Nexus: put-away G at P-19, move G to P-20.
12. **`stops`** (40). Nexus: G moves P-20 to P-19, back to P-20, to P-19, back to P-20; two of those answers dropped and recovered.
13. **`final`** (read-only, 21).
14. **Switches off (Derek).** Delete all three. Disabled-mode verification, the stub goes back into `bridge-smoke`, Nexus staging
    and production checked read-only.

Across the writing stages Nexus sees 8 put-aways, 7 moves and 3 releases from ShipBay, plus one refused move on record. The
three releases free positions the suite itself took (P-13, P-14, P-18). End state: ShipBay holds P-01, P-12, P-13, P-16, P-17
and P-20; P-11, P-14, P-15, P-18 and P-19 are free. The dev database is not reset afterwards.

## The test fault

`NEXUS_TEST_FAULTS=on` does something only when the bridge's own database address is exactly `shipbay-nexus-dev`. Then a
signed-in staff request carrying `x-nexus-test-fault: lose-answer` has Nexus's answer to its one write dropped after Nexus
applied it, and the bridge says so in its reply. Everywhere else a request carrying the header is refused before anything runs
(tested: switch unset, another database, a look-alike address, production, no sign-in, client login, unknown fault). The header
is not in the bridge's CORS allow-list, so a browser on the WMS site cannot send it. `/status` reports whether it is on.

## Sign-in and authorization

The runner signs the synthetic floor, admin and client logins in through Supabase Auth and asks Auth to confirm each token before
use. The service login is never sent to the bridge as a person; under test it ran only the bridge's own three steps and the dev
helpers. The runner holds no bridge code and no Nexus address, and never reads the Nexus key (checked by a test and by `bundle.sh`).

## What only the hosted run can prove

- The real Auth endpoints, the platform's token check in front of the bridge, and real network time.
- Background execution in the Edge runtime (`&wait=1` runs a stage in the foreground if it is not available).
- Stage duration, and the platform's limit on calls from one function to another (30 observed; the largest stage makes 22).
