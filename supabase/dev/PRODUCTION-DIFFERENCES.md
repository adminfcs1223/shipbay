# Functions that differ between production and the development build

Checked 2026-11-22, read-only, against production's function catalog (names and text of functions only; no rows).
Of the functions the two databases share, 111 are identical and four differ. Three of the four differ only in comments.

| Function | What differs | Matters? |
|---|---|---|
| `wms_receive_booking` | Dev has two trailing comments and two comment-only lines that production's copy lacks. Every statement is the same. | No. Production's copy was applied with comments stripped. |
| `_wms_track` | Dev has a trailing comment on the `exception when others then null;` line. Every statement is the same. | No. |
| `nexus_client_create` | Dev has a trailing comment on the `return` line. Every statement is the same. | No. |
| `_nexus_api_client` | **Real difference.** Dev (from `20261124_nexus.sql`) looks the key up in `nexus_clients` itself. Production's is one line that hands the key to `_nexus_api_auth`, part of the later Nexus build that lives only in production. | **Yes, see below.** |

## What to do before any production migration

1. **Do not re-apply `20261124_nexus.sql`, `20261124_nexus_map.sql` or `20261124_nexus_shared_controls.sql` to production.**
   Production already holds a newer form of that work. Re-applying `20261124_nexus.sql` would put the old `_nexus_api_client` back and
   route key checks around `_nexus_api_auth`. The bridge does not use these functions.
2. Production also has 39 `nexus_*` functions the development database does not (the Nexus build inside ShipBay's database). The
   development database cannot tell us whether a candidate collides with them. Any candidate that touches a `nexus_*` name needs a
   check against production's text first.
3. `20261201_wms_nexus_departure.sql` replaces `_wms_post_stock`. On the day of this check production's `_wms_post_stock` was
   identical to the text that file starts from, so the replacement is production's function plus one guard line. Re-check the
   hash on the day it is applied: if production's has changed, rebuild the replacement from production's text.
4. Not compared with production: tables, columns, triggers, policies and grants. Compare those before a production migration too.

How this was measured: an md5 of every non-blank line of each function in production, compared in the development database;
then the differing lines were read.
