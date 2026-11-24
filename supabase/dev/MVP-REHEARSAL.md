# ShipBay MVP hosted rehearsal: one synthetic pallet, receive to ship (RUNNER WRITTEN AND TESTED LOCALLY, NOT RUN)

Prepared 2026-11-24 for Derek. Nothing here has been run. Running it needs every prerequisite in section 1, including Derek's
separate written authorization naming this procedure.

Scope: one new synthetic product and pallet of the brand Synthetic Records on shipbay-nexus-dev (`gdoaonsasbsperqjuurm`),
put away at **P-50** on Nexus staging floor `HILLSBOROUGH-TEST`, three manual orders, wave pick, pack, ship with test tracking,
reconcile to zero, release P-50, switches off. Never P-01, P-02 or P-03; never PSKU-000001 or its product; never PAL-9801;
no carrier label purchase; no production.

## 1. Prerequisites (all required)

1. **P-03 hold released or amended by Derek.** The hold forbids turning on ShipBay's movement switches at all, whatever the
   position, and the switches are not per position. Souled's P-02 → P-03 move should be finished, or Derek states the two
   tests may run at once.
2. **Separate authorization under the standing movement hold** for exactly this procedure. It sends two Nexus mutations (an
   assign to P-50, a release from P-50) and deploys a runner, both forbidden without approval. Approving this does NOT
   approve the nine-stage movement rehearsal.
3. **A runner for these steps, written and reviewed.** No ShipBay screen is connected to dev: the portal and WMS builds point
   at production, the WMS is not deployed, the `labels` function is not on dev, and the synthetic logins have no passwords.
   The existing movement runner (`supabase/dev/runner/`) signs the synthetic logins in through Supabase Auth and calls the
   deployed bridge over HTTPS; an "mvp" stage with the steps of section 3 must be added, tested locally against the local
   API and a local Nexus at a465b55, and reviewed. WRITTEN AND TESTED LOCALLY 2026-11-24 (section 6); review pending.
4. **Destination vacant, re-read within 15 minutes of the start** (read-only): Nexus staging `P-50` on `HILLSBOROUGH-TEST`
   open, capacity 1, 0 pallets (last read 2026-11-24 15:33Z: open, capacity 1, 0 pallets, no move ever). ShipBay dev: no pallet,
   stock or wave stop at P-50. Fallback if taken: P-49 (same read), never P-01..P-03.
5. **Before-state captured** (read-only): dev fingerprints as in `MOVEMENT-REHEARSAL.md` (ledger `afc8960b`, orders
   `940453fc`, lines `0e21eac4`, shipments 0, events `5deb6a8e`, pallets `49a8aabd`, cartons `a025ccd7`, journal `28ef4c90`,
   PSKU-000001 `56e1c5ac`), journal with nothing pending / out of sync, no open wave; Nexus occupancy and move count.
6. **Switches**, set by Derek by hand on dev only, after 1-5: `NEXUS_BRIDGE_MODE=staging`, `NEXUS_PALLET_MOVES=on`.
   `NEXUS_TEST_FAULTS`, `NEXUS_REGISTRY_WRITES`, `NEXUS_CALENDAR_WRITES` stay unset. Read back through the switch probe.
7. Nexus staging's own floor switch for `HILLSBOROUGH-TEST` is ON (Nexus reports it in `GET /v1/map`).

## 2. Fresh identifiers (none exists today)

Product `MVP-RH-1124` "MVP rehearsal product" (barcode `MVP-RH-1124-BC`, Synthetic Records). Receiving key
`mvp-rehearsal-1124`. Pallet: whatever label the database issues (the runner finds it by the receiving key, never by number). Orders `MVP-RH-1`, `MVP-RH-2`,
`MVP-RH-3`. Tracking `TEST-MVP-RH-0001`, `TEST-MVP-RH-0002` (not real carrier numbers; no label is bought).

## 3. Steps (runner stage "mvp"; each step stops the run on any unexpected answer)

| # | Who | Call | Expect |
|---|---|---|---|
| 1 | admin | insert product `MVP-RH-1124` | one product |
| 2 | floor | `wms_receive` 2 cartons × 6, key `mvp-rehearsal-1124`; the same call again | one pallet, 2 cartons, no stock yet; repeat makes nothing |
| 3 | floor | `wms_scan_carton` × 2, `wms_complete_count` | pallet counted |
| 4 | floor | bridge `POST /putaway {psku, location: "P-50"}` | 200 from Nexus; ledger +12 at P-50 once; journal row done |
| 5 | floor | the same put-away again | refused by ShipBay (already stored) or a replay; nothing changes |
| 6 | read | Nexus `/v1/occupancy`, bridge `/reconcile` | pallet at P-50 for SHIPBAY; nothing waiting |
| 7 | admin | `create_manual_order` × 3 (6 each) | 3 orders, 18 asked against 12 |
| 8 | floor | `wms_wave_start` | wave holds MVP-RH-1 and -2 (one stop, 12 at P-50); MVP-RH-3 short |
| 9 | floor | `wms_wave_confirm` (barcode), `wms_wave_to_pack`, `wms_wave_pack` × 2 | 12 picked once; both packed |
| 10 | admin | `ship_order` MVP-RH-1 (`manual`, `Box 8×6×4`), the same again, MVP-RH-2 | 2 shipments; repeat returns the first; nothing deducted |
| 11 | admin | first `_order_commitment` must be empty, then the portal's own cancel (`orders.status = cancelled` as admin over REST, row security applies) | cancelled, written to history |
| 12 | admin | `wms_stock_summary` | received 12, picked 12, shipped 12, on hand 0, reconciled |
| 13 | floor | bridge `POST /release {psku, location: "P-50", confirmed: true, reason: "emptied_and_removed"}` | 200 from Nexus; pallet departed; P-50 free; no stock change |
| 14 | Derek | delete the two switches; probe reads all off; stub back in `bridge-smoke` | bridge answers off |

## 4. Afterwards (read-only)

Nexus: P-50 empty; SHIPBAY moves +2 (assign, release); PSKU-000001 at P-01 and PAL-9801 where Souled left it, unchanged.
Dev: PSKU-000001, its receipt and the earlier journal row unchanged; the journal has two more rows, both done; nothing
pending or out of sync; product `MVP-RH-1124` on hand 0, reconciled. These rehearsal records stay on dev (they are not
rolled back): 1 product, 1 pallet, 2 cartons, ledger rows, 3 orders, 2 shipments, packages, a wave, status history.

## 5. Stop rules

Any Nexus refusal: stop; do not retry with a new key; act as the handoff table says (`location_full` and the other 409s:
leave the pallet, report). No answer: only `POST /pending/retry` (same key), never a new put-away. Out of sync: stop and
report; nothing is released automatically. Any check that does not match: stop, switches off (step 14), report.

## 6. The runner (written 2026-11-24; local only)

- `supabase/tests/hosted/mvp.js` — the steps of section 3 as code, no imports, used unchanged locally and in the runner.
  Before any request leaves it: the position must be P-50 or P-49 (P-01, P-02, P-03 and everything else are refused with 0
  writes); every bridge body may name only this run's pallet (found by the receiving key) and this position; nothing naming
  PSKU-000001 or P-01..P-03 is sent. Preflight (no writes): switches exactly `staging` / moves on / registry, calendar and
  test faults off; PSKU-000001 stored at P-01; nothing pending or out of sync; the destination empty in Nexus. It captures
  PSKU-000001, ShipBay's pallets at P-01..P-03, every other journal row and Nexus at P-01..P-03 at the start and requires
  them identical at the end. It stops at the first unexpected answer; a no-answer from Nexus is resent only through
  `POST /pending/retry` (same key, at most 3 times); nothing is released or corrected to clean up. Every step first looks at
  what is already done, so after a stop the same run can be started again and finishes without doubling anything.
- `supabase/dev/runner/runner.js` — new stage: `GET ?t=<token>&stage=mvp[&position=P-49][&until=preflight|receive|putaway]`.
  Synchronous (answers when done). It does not use `dev_runner_begin` / `dev_runner_finish` (they accept only the nine
  movement stages; no schema change is needed). Two table steps go over REST as the signed-in admin: product lookup/insert
  (`skus`) and the cancel (`orders`, PATCH, must change exactly one row). Lost-answer faults are never requested.
- **It cannot set, clear or check-and-restore any switch.** It reads them from `GET /status` at the start, at the end and
  when it stops, and says in its result that Derek must delete `NEXUS_BRIDGE_MODE` and `NEXUS_PALLET_MOVES` now.

Local results (fresh database each time, real Nexus code at a465b55, bridge in-process / under Deno):
`supabase/tests/hosted/mvp.test.mjs` 11/11, three repeated runs: positions refused (P-01, p-02, " P-03 ", loc-p-01, P-30,
P-51, empty), wrong switches refused (5 cases, 0 writes, nothing created), occupied destination refused before anything is
created, stop after receiving + rerun (same pallet, 2 cartons), put-away with the answer lost then recovered by
`/pending/retry` (same request, attempts 2), failure inside packing + rerun (finishes; release with Nexus unreachable once,
recovered by retry), result 12 received / -12 picked / 12 shipped / 0 on hand / P-50 empty / 2 shipments / third cancelled,
finished run rerun (0 Nexus writes, ledger identical), protected records identical (PSKU-000001, seeded pallets, other
orders, Nexus P-01..P-03 incl. another company's pallet at P-02), two runs started at once (one finishes; the other stops on
a database refusal with 0 Nexus writes; a third run completes; nothing doubled). `supabase/tests/deno/runner.test.ts`
14/14 (MVP through the runner: 43 checks, 2 Nexus writes, 8 bridge calls, 26 database calls; refused with test faults on;
no key or token in the result; nothing stored in `dev_runner_runs`). Movement suite `local.test.mjs` 11/11 unchanged.

## 7. Hosted execution gate (for Derek's separate authorization; nothing here is approved yet)

1. **Project**: shipbay-nexus-dev `gdoaonsasbsperqjuurm` + Nexus staging `ankoqruedjujyefhrmtw` floor `HILLSBOROUGH-TEST`.
   Never `poxlczzkpztmoiixyrth` (the runner refuses any other database).
2. **Code**: branch `wms-nexus-bridge` at the commit named in Derek's authorization; bundle from `bundle.sh` with the
   SHA-256 of each file listed in the authorization; deployed bridge unchanged (version 7).
3. **Operations**: Nexus writes exactly two — assign `<new PSKU>` → P-50, release from P-50 (reason `emptied_and_removed`).
   ShipBay dev: product `MVP-RH-1124`, receipt key `mvp-rehearsal-1124` (1 pallet, 2 cartons × 6), orders `MVP-RH-1..3` (6
   each), wave, packs, shipments `TEST-MVP-RH-0001/0002` (label source manual → other, no label bought), cancel of MVP-RH-3.
4. **Location**: re-read within 15 minutes of the start (read-only): P-50 open, capacity 1, empty, ShipBay has nothing at
   P-50. Last read 2026-11-24 15:48Z: P-49 and P-50 open, capacity 1, empty, no move ever; P-01 SHIPBAY PSKU-000001;
   P-02 SOULED PAL-9801; P-03 empty; 14 moves; floor moves enabled.
5. **Before-state** (read-only, recorded in the authorization): dev fingerprints as section 1.5 plus: no MVP-RH product,
   pallet, order or shipment; no open order of Synthetic Records; no open wave; journal 1 row, nothing waiting; 9 pallets,
   1 ledger row, 1 order. Nexus: the occupancy above and the move count.
6. **Other movement-capable traffic**: on ShipBay's side only the runner can reach the bridge (no portal or WMS build points
   at dev; the synthetic logins have no passwords; Derek runs nothing else during the window). On Nexus's side ShipBay
   cannot block other companies: the Nexus team is asked not to place at P-49/P-50 during the window; a late occupant only
   makes the put-away refuse (`location_full`), which stops the run with nothing to undo.
7. **Switches**: Derek sets `NEXUS_BRIDGE_MODE=staging`, `NEXUS_PALLET_MOVES=on` on dev only; the other three stay unset.
   The runner refuses to start otherwise.
8. **Run**: deploy the bundle to `bridge-smoke` (verify_jwt off, token gate, 15-minute expiry); `?stage=mvp&until=preflight`
   (no writes); then `?stage=mvp`. A stop: read the result; if it stopped after a Nexus write and that write is waiting, only
   `/pending/retry` or a rerun of `stage=mvp`; out of sync → `/reconcile` and report, nothing released automatically.
9. **Restore and verify, in this order, whatever the outcome**: Derek deletes both switches; `GET /status` reads
   connection off; the inert 410 stub back in `bridge-smoke` with verify_jwt on, read back; section 4 read-only checks.
10. **Permissions needed**: release or amendment of the P-03 hold for this procedure; authorization under the movement hold
    for the two Nexus writes, the runner deploy to `bridge-smoke` and the dev records listed in 3; Derek at the keyboard to set
    and delete the switches.

**Limitation (unresolved): switch restoration cannot be guaranteed by the runner.** It cannot change secrets. If the run
stops, the platform kills it, or the connection drops, both switches stay ON until Derek deletes them. What limits the
exposure: no caller but the runner exists on dev (step 6); the runner slot goes back to the stub; Nexus's floor switch and
revoking ShipBay's Nexus key are further stops on the Nexus side. A guaranteed off would need a code change (for example the
bridge refusing writes after a deploy-time expiry) and a bridge redeploy, which is outside this task and not done.
