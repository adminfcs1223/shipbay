# Production security repair (prepared 2026-11-22, NOT APPLIED)

Target: ShipBay production `poxlczzkpztmoiixyrth`. Nothing here has been run there. It needs Derek's approval.

## Files
- `20261122_production_security_repair.sql`: the migration. Four functions and one permission, in one transaction.
- `20261122_production_security_repair.rollback.sql`: puts back exactly what production has today. Re-opens the weaknesses.
- `repair-check.sql`: the test. Synthetic databases only; refuses to start anywhere else.

## What it changes
| | Today | After |
|---|---|---|
| `handle_new_user` | Role and brand copied from the sign-up form's own data | Never. A new login is `client_user` with no brand unless the service role set a known role in app data |
| `wms_org_create_key` | A login with no brand passes the "is this your brand" check | Refused unless it is the caller's own brand, or the caller is an admin |
| `wms_org_connector` | Same flaw, for reading a brand's key list | Refused unless own brand, or admin/staff |
| `set_order_cutoff` | An order for a brand the caller cannot see loops until the timeout | Returns at once; the write is then refused as before |
| `orders` table | The not-signed-in role holds insert/update/delete/truncate rights (no policy ever let one succeed) | Those rights are removed |

No table is altered. No row is read or written. No existing login, password, role, PIN or brand link is touched.

## Why Admin -> Users keeps working
The three deployed functions that create logins were read on 2026-11-22 (production copies, not just the repository):
`admin-users` v3, `wms-employees` v1, `portal-access` v2. Each creates the login and then writes the profile itself with the
service role (role, brand, sales flag, employee number). The trigger's copy of the role was never what gave the login its role
in those flows; it only got there first. After the repair the trigger writes a no-access profile and the function's own write
sets the real role a moment later, exactly as it does today.

## Expected impact
- **Existing logins**: none. The trigger only runs when a login is created.
- **New staff, sales, setter, client logins (Admin -> Users)**, **new floor employees (WMS employees)**, **client portal access**: unchanged result.
- **A login created by hand in the Supabase dashboard**: starts with no access until its role is set in Admin -> Users. (Today it also starts as a client login unless someone types a role into its data.)
- **If a login-creating function's profile write ever failed**: today the login would still get the requested role from the trigger; after, it is left with no access. Safer, and visible at once.
- **Receiving, pallets, inventory, put-away**: not touched.
- **Orders**: Shopify sync, the connector API, staff entry and client edits are unchanged; ship-by cut-off is computed the same way (tested: before the hour, after it, weekend).
- **Connector keys**: clients managing their own brand's keys, and the admin key screen (a different function): unchanged.
  Behaviour that goes away: a login with no brand that is not an admin (sales, setter, floor, non-admin staff) could create a key for
  any brand through the client function, and sales, setter and floor could read any brand's key list. No key was ever created that way.

## Tests
- Apply, re-apply (refused by its own check), rollback, on a bare copy of production's warehouse schema: pass; rollback restores the exact original text.
- Local, full build with the repair applied first: `repair-check.sql` passes (A sign-up data grants nothing; B the admin screens' way of creating
  staff, sales, client and floor logins still gives the right role, brand, sales flag, employee number and PIN; C keys; D orders; E receiving),
  and the 14-check warehouse regression passes on top of it.
- Negative control: with the repair rolled back, `repair-check.sql` fails at A.
- Hosted `shipbay-nexus-dev`: its four functions are byte-identical to the repair's (checked by fingerprint, dev_025), the permission change is applied,
  `repair-check.sql` passes, and the 50-attempt untrusted-login check passes.
- Not tested: the real Admin -> Users screen against a repaired database (dev has no portal and none of those edge functions). The database half of
  that flow is what B tests. First real proof is creating one login in production after the repair.

## Procedure
1. Confirm sign-up is still off in the project (it is, as of 2026-11-22 22:20 ET: `disable_signup: true`).
2. Apply `20261122_production_security_repair.sql` as one migration. If any of the four functions is not the text it was written against, it stops and changes nothing.
3. Verify, read-only:
   `select proname, md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('handle_new_user','wms_org_create_key','wms_org_connector','set_order_cutoff');`
   expect `ecc05dbe…`, `b20b5f55…`, `adbc0800…`, `422df316…`; and `select has_table_privilege('anon','public.orders','insert');` expect `false`.
4. Derek, in the portal: Admin -> Users, create a throwaway staff login, confirm it lists as staff, switch it off. About two minutes.
5. If step 4 fails: apply the rollback file (sign-up stays off), and report.

## Not in this repair
- Do not apply `20261124_nexus*.sql` to production (see `supabase/dev/PRODUCTION-DIFFERENCES.md`).
- The position list is readable with only the public key (low).
- `is_shipbay()` counts the sales role, so a sales login can write operational tables through row policies, and it does not look at the
  `active` flag (switching a login off relies on the sign-in ban, which stops new sessions; a session already open lasts up to its expiry). Owner decision.
