# Hosted movement rehearsal: dev database and bridge ready, runner and stages not run

Updated 2026-11-23, 2:40 AM ET. Step 1 (development database), step 2 (updated bridge) and the stock safety migration dev_032
are applied and verified on `shipbay-nexus-dev`. The movement runner is NOT deployed, no switch was set, and nothing was sent to
Nexus. Production and `main` are untouched.

**P-01 HOLD in force (Derek, 2026-11-23 1:48 AM), until he releases it explicitly:** PSKU-000001 is not moved or released, no
movement switch is enabled, the hosted suite is not started, and nothing is sent to Nexus, so that Souled can make one
conflicting assignment attempt at occupied P-01. Read directly at 06:49:35Z by a one-off signed-in probe (bridge-smoke version
13, 15-minute gate, about 20 seconds live, then the inert stub back as version 14 with sign-in required): connection off,
reason `bridge_off`, pallet moves false, test faults false, registry and calendar writes false; put-away, move, release and a
move with the lost-answer header all 503 `bridge_off`. PSKU-000001 stored at P-01, one receipt of 100, one journal entry; no
open requests, 0 runner runs; Nexus shows it at P-01 since 04:26:05Z with no ShipBay request after that.

**Blocker before real-inventory testing (Derek, 2026-11-23):** `wms_open_box` (see "Assessed, not fixed", item 7). The dev_032
verification below does not resolve it.

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

## Pallet stock safety (candidate 20261204): void and unit count, tested locally, applied nowhere

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
7. **Opening a carton is a second way to change a put-away pallet's stock, and it has none of these checks** (from the code,
   not reproduced): `wms_open_box` takes the carton's units off the pallet's position and puts a freely entered number (1 to
   500) on the open-box shelf. Any floor login, no reason, no check for picks, planned stops or a waiting Nexus request. On a
   heavily picked pallet it can leave the position below zero, and the number entered need not match the carton's count. Not
   changed here: the request was the unit-count function. It needs the same rules before real inventory.
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
