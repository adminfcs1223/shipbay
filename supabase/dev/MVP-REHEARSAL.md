# ShipBay MVP hosted rehearsal: one synthetic pallet, receive to ship (PREPARED, NOT RUN)

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
   API and a local Nexus at a465b55, and reviewed. NOT YET WRITTEN.
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
`mvp-rehearsal-1124`. Pallet: whatever label the database issues (the next is PSKU-000101). Orders `MVP-RH-1`, `MVP-RH-2`,
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
| 11 | admin | cancel MVP-RH-3 (hold / cancel path) | cancelled, written to history |
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
