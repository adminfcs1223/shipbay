# Hosted check evidence, shipbay-nexus-dev, 2026-11-24 (dev_036 revision 2 and dev_037 deployment)

Target `gdoaonsasbsperqjuurm`. Files at commit `4f71fed` (identical at `1e02888`). Run between 14:5xZ and 15:05Z, after
both migrations, through the Supabase database tool (`execute_sql`), one call per file, in this order.

## How the text reached the database (the limitation)

The database tool takes SQL as text from the model; it cannot read a file. A helper session read each file whole and passed
its content by copying it. **No tool compared the text sent with the file byte for byte.** What supports the copies:

1. Each file is one `do` block that ends by raising `ROLLBACK-OK n checks passed`. PostgreSQL reports the line of that RAISE
   inside the block. For all eight, the reported line equals the file's RAISE line minus the lines above `do` (table).
   A dropped, added or merged line before the RAISE would move it.
2. Each check asserts its own count of checks and its own preconditions (`FAIL 0`); a copy that lost an assertion would
   still pass only if the lost text were an assertion that would itself have passed.
3. The non-ASCII box name ('Box 8×6×4') came back intact in the MVP check's message.
4. The same files, byte for byte, pass on the local copy of dev by `psql -f` (mechanical, below).

This is strong evidence, not proof. A mechanical hosted run needs a tool that executes a file by its hash (for example a
one-off gated function that fetches the file at a pinned commit, checks its SHA-256 and runs it); that needs a deployment
and Derek's approval, and was not done.

| File | SHA-256 | git blob | checks | RAISE line in block (file line − `do` line + 1) | line reported by hosted | hosted result |
|---|---|---|---|---|---|---|
| `supabase/dev/regression.sql` | `a6783d38652bb06460b43b433f5c10fb4b75b969ce9d7f23c4ded59c7195d80c` | `05b07d4afbe0` | 15 | 267 − 8 + 1 = 260 | 260 | ROLLBACK-OK 15 |
| `supabase/dev/openbox-check.sql` | `4fe1b36b46ee1e93d20d967de2d324ed04a874fafad762b9ffa1f737d083d7b1` | `a43206265c7f` | 8 | 186 − 8 + 1 = 179 | 179 | ROLLBACK-OK 8 |
| `supabase/dev/stock-safety-check.sql` | `17bbaf876dc612cf70cf5526d141b65bf628d89339f14503d7fa48d515b9782a` | `1ed74699613f` | 7 | 167 − 7 + 1 = 161 | 161 | ROLLBACK-OK 7 |
| `supabase/dev/workflow-check.sql` | `fedf6e75b4756f28771bf58a004dc0dcec2776c5603f406577f9c171c8b43cad` | `0e1808fd1339` | 6 | 94 − 7 + 1 = 88 | 88 | ROLLBACK-OK 6 |
| `supabase/dev/manager-correct-check.sql` | `4a9b83c7130db00f5d7d7a859be031d1cceb6200a6bbc4b606ea149b3f77ec97` | `5eb087b2a373` | 5 | 117 − 9 + 1 = 109 | 109 | ROLLBACK-OK 5 |
| `supabase/dev/ledger-hardening-check.sql` | `6d0aa904466cab6e6cea245399832370d0ceea484a2da73fe95648866d8e3741` | `218da81f44dd` | 9 | 256 − 9 + 1 = 248 | 248 | ROLLBACK-OK 9 |
| `supabase/dev/order-integrity-check.sql` | `e5a5348c856329f8ec1768e09068b0617c07c48405737f084f910b4971f3aef3` | `4d2cd424e6eb` | 8 | 198 − 9 + 1 = 190 | 190 | ROLLBACK-OK 8 |
| `supabase/dev/mvp-check.sql` | `dffd46e41893ec6cedbb9a2b3665e9d978003da9a59f05a37239b7c67ffd5657` | `6e7212385223` | 10 | 206 − 10 + 1 = 197 | 197 | ROLLBACK-OK 10 |

All eight returned `ROLLBACK-OK` with the counts above; the full messages are in `MOVEMENT-REHEARSAL.md` (section "dev_036
revision 2 and dev_037 APPLIED") and in this session's record. After the run: every hosted fingerprint equal to the
before-state (ledger `afc8960b`, orders `940453fc`, lines `0e21eac4`, shipments 0, events `5deb6a8e`, pallets `49a8aabd`,
cartons `a025ccd7`, journal `28ef4c90`, PSKU-000001 `56e1c5ac`); sequences advanced (events 121→186, activity 1124→1395,
package 9→14, PSKU 82→100, unit 285→380).

## Reproduce (mechanical, local)

```
# local cluster on 127.0.0.1:54317; EXTRACT=<warehouse subset>
/tmp/build-devcurrent.sh                                  # dev as of dev_033 (see supabase/dev/README.md)
for f in dev_034_manager_pick_corrections dev_035_inventory_ledger_hardening dev_036_order_integrity dev_037_mvp_fulfilment; do
  psql -h 127.0.0.1 -p 54317 -U postgres -d staging -v ON_ERROR_STOP=1 -1 -f supabase/dev/pending/$f.sql; done
for f in regression openbox-check stock-safety-check workflow-check manager-correct-check ledger-hardening-check order-integrity-check mvp-check; do
  psql -h 127.0.0.1 -p 54317 -U postgres -d staging -q -f supabase/dev/$f.sql 2>&1 | grep -o "ROLLBACK-OK [0-9]* checks passed"; done
```
