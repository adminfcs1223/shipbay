# Hosted movement rehearsal: step 1 done, the rest not run

Updated 2026-11-23, 1 AM ET. Step 1 (development database) is applied and verified on `shipbay-nexus-dev`. The updated bridge and
the runner are NOT deployed, the movement and test-fault switches are off, and nothing was sent to Nexus. Production and `main`
are untouched.

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
| Hosted suite | `supabase/tests/hosted/suite.js`: 8 stages, 306 checks. The earlier 261 are all still in it. Passes locally under Node and through the runner under Deno. |
| Lost answers | Produced by the bridge's own dev-only test fault. The runner no longer holds bridge code or reads the Nexus key. |
| Existing tests | Bridge 16, Edge wrapper 4, waves/receiving/dock/registry/activity unchanged and passing, dev regression 15 checks, WMS unit 56, put-away browser test 31. |

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

1. **Voiding a stored pallet after picks leaves a negative position.** The void takes the full received quantity off the books
   and the picks stay: 100 received, 30 picked, void, and the position shows minus 30 (reproduced). This is older behaviour, not
   caused by Nexus, and it is wrong for real stock.
2. **Voiding while a request is waiting.** Still allowed. On a waiting put-away it ends as an out-of-sync request the admin
   undoes (the suite rehearses this). On a waiting move the stock is written off at once, Nexus completes the move, and ShipBay
   refuses to record it: the pallet shows void at the old position while Nexus holds the new one (reproduced). Recoverable by an
   admin, but it should be refused instead. Fixing it changes how the suite produces its second partial failure.
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
| F2 | `syn-move-2` #1 | 1000 | P-18 | Nexus accepted, ShipBay could not record; admin confirms it is NOT there. |
| G | `syn-move-2` #2 | 1000 | P-19, P-20 | Part-picked, moved, reopened; then its planned stop follows it P-20, P-19, P-20. |

On the hosted database the six new pallets are PSKU-000016 to PSKU-000021. The suite finds them by receipt batch, not by number. P-11 to P-20 were open and empty in Nexus staging on 2026-11-22
(read-only check). Preflight checks again and stops if not.

## Proposed sequence

Each numbered step that changes anything needs its own go. A stage that writes can be started once; it checks its starting
state first and stops at the first failed check. Nothing is retried, repaired or released to clean up.

1. **Dev database. DONE 2026-11-23** (approved by Derek). See "Applied to shipbay-nexus-dev" above.
2. **Bridge (approval).** Redeploy `nexus-bridge` to dev from this branch (adds the dev-only test fault and the exceptions report).
   Switches stay off; repeat the disabled-mode check.
3. **Runner (approval).** `bundle.sh`, set the one-hour gate, deploy into the existing `bridge-smoke` slot in dev.
4. **Switches (Derek, by hand, dev only).** `NEXUS_BRIDGE_MODE` = `staging`, `NEXUS_PALLET_MOVES` = `on`, `NEXUS_TEST_FAULTS` = `on`.
5. **`preflight`** (read-only, 22 checks).
6. **`move`** (41). Nexus: put-away M at P-11 and R1 at P-13, one refused move, move M to P-12.
7. **`release`** (53). Nexus: release R1 from P-13, put R1 back, put-away R2 at P-14, release R2 from P-14.
8. **`lost`** (48). Nexus: put-away L at P-15, move L to P-16, each answer dropped once and recovered.
9. **`partial`** (57). Nexus: put-away F1 at P-17 and F2 at P-18, one corrective release of P-18.
10. **`picks`** (24). Nexus: put-away G at P-19, move G to P-20.
11. **`stops`** (40). Nexus: G moves P-20 to P-19, back to P-20, to P-19, back to P-20; two of those answers dropped and recovered.
12. **`final`** (read-only, 21).
13. **Switches off (Derek).** Delete all three. Disabled-mode verification, the stub goes back into `bridge-smoke`, Nexus staging
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
- Stage duration. The largest stage makes about 50 round trips; preflight's timing decides whether any stage must be split.
