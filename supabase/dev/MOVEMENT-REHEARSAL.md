# Hosted movement rehearsal: prepared, not run

Prepared 2026-11-22 after the first hosted put-away (PSKU-000001 at P-01 on HILLSBOROUGH-TEST). Code and tests only.
Nothing here has been applied to `shipbay-nexus-dev`, deployed, or sent to Nexus. The movement switches are off.

## What was built

| File | What it is |
|---|---|
| `supabase/tests/hosted/suite.js` | The rehearsal itself: seven stages, 261 checks. No imports; the same file runs locally and in the runner. |
| `supabase/tests/hosted/local.test.mjs` | Runs the suite on this machine: local database, the bridge in-process, the real Nexus service code. |
| `supabase/dev/runner/runner.js`, `index.ts` | The temporary dev-only runner that would run the suite against the deployed bridge. Gate closed as committed. |
| `supabase/tests/deno/runner.test.ts` | Runs that runner under Deno exactly as it would be deployed, against local stand-ins. |
| `supabase/dev/movement-dev.sql` | Dev-only helpers: read-only snapshot, the runner's run-once record, one fault injection. |
| `supabase/dev/seed-movement.sql` | Six more synthetic pallets and one synthetic order. Touches no existing pallet. |
| `supabase/dev/runner/bundle.sh`, `stub.ts` | Lays the runner out for deployment (deploys nothing); the inert stub that goes back afterwards. |

Local result: suite 261/261 under Node, the same 261 through the runner under Deno (11 tests), existing bridge tests unchanged (14 + 4).

## The pallets and positions

PSKU-000001 at P-01 is never named in any request. The suite refuses to send one that does, and checks ShipBay's row, its one
receipt, its one journal entry and Nexus's own answer for P-01 before and after every stage.

| Part | Pallet | Units | Positions | What happens |
|---|---|---|---|---|
| KEEP | PSKU-000001 | 100 | P-01 | Nothing. Left for Souled's cross-company conflict test. |
| M | PSKU-000002 | 100 | P-11, then P-12 | Put away, moved. |
| HELD | PSKU-000003 | 50 | none | On HOLD since receiving: refused by ShipBay, never reaches Nexus. |
| R1 | new, batch `syn-move-1` #1 | 200 | P-13 | Released off the shared floor (still in custody), then put back. |
| R2 | `syn-move-1` #2 | 200 | P-14 | Released as shipped out; the answer to the release is lost and re-sent. |
| L | `syn-move-1` #3 | 200 | P-15, then P-16 | Both Nexus answers lost: one finished by re-scan, one by the retry run. |
| F1 | `syn-move-1` #4 | 200 | P-17 | Nexus accepted, ShipBay could not record; admin confirms it IS there. |
| F2 | `syn-move-2` #1 | 1000 | P-18 | Nexus accepted, ShipBay could not record; admin confirms it is NOT there. |
| G | `syn-move-2` #2 | 1000 | P-19, then P-20 | Part-picked, moved, the pick reopened. |

The new pallets are found by receipt batch, not by number: their PSKU numbers are whatever the hosted sequence gives.
P-11 to P-20 were open and empty in Nexus staging when this was written (read-only check). Preflight checks again and stops if not.

## Proposed sequence

Each numbered step that changes anything needs its own go. A stage that writes can be started once; it checks its starting
state first and stops at the first failed check. Nothing is retried, repaired or released to clean up.

1. **Dev database (approval needed).** Apply `movement-dev.sql`, then `seed-movement.sql`, to `shipbay-nexus-dev`.
   Adds 6 pallets, 1 order, 1 table, 6 functions. No stock posted, no Nexus contact. Verify PSKU-000001/2/3 unchanged, ledger still one row of 100.
2. **Runner (approval needed).** `bundle.sh`, set the one-hour gate, deploy into the existing `bridge-smoke` slot in dev, JWT check off.
   Compare the three bridge files with the deployed `nexus-bridge` before use.
3. **Switches (Derek, by hand).** `NEXUS_BRIDGE_MODE` = `staging`, `NEXUS_PALLET_MOVES` = `on`.
4. **`preflight`** (read-only, 21 checks). Switches, sign-ins, refusals without a login, starting state, map version and checksum,
   Nexus holds exactly PSKU-000001, P-11 to P-20 empty, nothing pending, reconcile in sync. Also gives the real per-call time.
5. **`move`** (41 checks). Nexus: put-away M at P-11 and R1 at P-13, one refused move (P-13 is ShipBay's own), move M to P-12.
6. **`release`** (53 checks). Nexus: release R1 from P-13, put R1 back at P-13, put-away R2 at P-14, release R2 from P-14.
7. **`lost`** (44 checks). Nexus: put-away L at P-15, move L to P-16. Each answer is thrown away once, then recovered.
8. **`partial`** (57 checks). Nexus: put-away F1 at P-17 and F2 at P-18, then one corrective release of P-18.
9. **`picks`** (24 checks). Nexus: put-away G at P-19, move G to P-20. A 40-unit pick is made and reopened in ShipBay.
10. **`final`** (read-only, 21 checks). End state in both systems, reconcile in sync, nothing pending.
11. **Switches off (Derek).** Delete both. Then the same disabled-mode verification as after the first placement, the stub goes
    back into `bridge-smoke`, and Nexus staging and production are checked read-only.

Across stages 5 to 9 Nexus sees 8 put-aways, 3 moves and 3 releases from ShipBay, plus one refused move on record. The three
releases free positions the suite itself took (P-13, P-14, P-18). P-01 is not touched.

End state if everything passes: ShipBay holds P-01, P-12, P-13, P-16, P-17 and P-20 on the test floor; P-11, P-14, P-15, P-18
and P-19 are free again. The dev database is not reset afterwards.

## Inventory checks in every writing stage

- No pallet has more than one receipt, and each receipt is the pallet's own quantity.
- No adjustment row exists anywhere in the ledger.
- Every pallet's transfers net to zero; a move or an off-floor release writes exactly one transfer pair and changes no quantity.
- A release as shipped out writes nothing to the ledger; units still on the books are reported, not deducted.
- A pallet returning from off the floor comes back by transfer: still one receipt.
- A lost answer followed by a re-scan or the retry run posts stock once; a third scan is refused.
- A request Nexus accepted and ShipBay could not record posts nothing until an admin records it; an undone one never posts.
- Every refusal (no login, client login, wrong position, no confirmation, floor forcing a correction) is followed by a check that nothing was written.

## Sign-in and authorization

The runner signs the synthetic floor, admin and client logins in through Supabase Auth (admin magic link, then the normal
verify call) and asks Auth to confirm each token before use. The service login is never sent to the bridge as a person. Under
test it ran only the bridge's own three steps and the dev helpers. Role checks are exercised, not bypassed: no sign-in (401),
public key only (refused), client login (403), floor login on admin routes (403 or refused by the database).

## What the hosted run needs that the local runs could not prove

- The real Auth endpoints, the platform's JWT check in front of the bridge, and real network time. Stand-ins were used locally.
- Background execution in the Edge runtime. If it is not available, `&wait=1` runs a stage in the foreground.
- Stage duration. The largest stage makes about 50 round trips. Preflight's timing decides whether any stage must be split
  to stay inside the platform's time limit. A stage cut off mid-way leaves a consistent but unfinished state to inspect by hand.

## Decision needed: the lost answer

The deployed bridge cannot be made to lose an answer. For the five steps that need one, the runner runs the same bridge files
inside itself, with the same settings and the same Nexus key, and discards Nexus's answer after Nexus has applied the request.
Everything after that (re-scan, retry run, reconciliation) goes through the deployed bridge. This means the temporary runner
reads the Nexus key from the function's settings for those steps. It never returns, stores or logs it, and the result is
searched for every key and token before it leaves. If that is not acceptable, stages `lost` and `partial` and the lost release
in `release` stay local-only, where they pass against the real Nexus service code.

## Remaining issues (reproduced locally, not fixed)

1. **A planned wave stop goes stale when its pallet moves.** The stop keeps pointing at the old position; confirming it fails
   with "Only 0 on file at P-xx". Only a reopened stop is re-pointed. A planned stop needs to follow the pallet, or the move
   needs to be refused while a stop is open.
2. **Reopening a stop after the pallet left the shared floor is refused with "A manager must correct it", and there is no manager
   function to do it.** The code gives the same answer for a wave that has gone to packing.
3. **The older pick list does not tie picks to a pallet.** Pick 30 from a pallet at a shared position, then move the pallet:
   the old position shows minus 30 and the new one shows the full quantity. The total is right; both positions are wrong.
4. **The older unpick restores units to the position recorded at pick time**, whether or not the pallet still stands there.
   It does not use the current position and does not refuse when the pallet has departed.
5. **The old Pallets screen (still on this branch) can reserve a shared position in ShipBay only.** `wms_assign_location` sets
   a shared position on a counted pallet without asking Nexus. The final scan is then refused by the safeguard, so no pallet is
   stored that way, but ShipBay's map shows the position as taken while Nexus shows it free. `nexus_putaway` is refused outright.
6. **Receiving still suggests shared positions for counted pallets without asking Nexus** (unchanged from the last report).
7. **Units left on the books by a shipped-out release are flagged only on the request and in the release answer.** No screen or
   list surfaces them afterwards, and they keep showing as stock at the vacated position until someone posts the outbound.
8. **A pick planned or made while a move is waiting for Nexus's answer** uses ShipBay's position (the old one) although Nexus
   already has the new one. The stock total stays right and the move carries what is left once it is recorded. Reasoned from the code, not tested.

Stage `picks` proves the wave path for one case (pick, move, reopen at the new position). Items 1 to 5 were reproduced in a
rolled-back transaction on the local database. None of them is in the hosted suite, because the suite would fail on them.
