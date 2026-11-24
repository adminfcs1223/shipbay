# Owner access to the WMS and portal on shipbay-nexus-dev (PREPARED, NOT DEPLOYED)

Prepared 2026-11-24. The goal: Derek can sign in and use the WMS and portal with synthetic data. The apps are connected
only to the isolated development database `gdoaonsasbsperqjuurm`. Nothing below has been done on any hosted service.

## What is ready
- `supabase/dev/owner-build.sh <empty folder>` builds `wms/` and `portal/` against dev with the dev public key. It writes
  each site's own `_redirects` (app only; nothing is proxied) and `_headers` (noindex, no framing, no-store). It stops if
  any built file names the production database or key, or a carrier or store API host.
- Built and checked locally on 2026-11-24. Both sign-in screens render. The only production reference left in the output
  is the WMS's own refusal check.
- These builds do NOT use `wms/netlify.toml` or `portal/netlify.toml`. Those files set the production database and proxy
  `/api/orders`, `/oauth/*` and `/webhooks/*` to production functions. A Netlify build linked to the repository would use
  them, so the dev sites must be uploaded as folders, never built from the repo.

## Why production cannot be reached
- Each build names the dev database only. The script refuses otherwise.
- Dev has no `labels`, sync, `owner`, `integrations` or `wms-login` functions and no `platform_secrets` table. No carrier,
  store or QuickBooks key exists there, so no label can be bought.
- Dev has only the 4 synthetic logins and the 2 synthetic brands.
- The dev bridge talks only to the Nexus staging test floor, and its switches are off.

## Hosted steps (each needs Derek's go-ahead; Derek does the password step himself)
1. **Dev Auth settings:**
   - Turn off new user sign-ups.
   - Set the Site URL to the dev WMS address.
2. **Passwords for the synthetic logins:** Derek runs this in the dev SQL editor, once per login, with a password of his
   choosing. The password is never typed into a chat.
   `update auth.users set encrypted_password = crypt('<password>', gen_salt('bf')) where email = 'test-admin@example.test';`
   - test-admin = ShipBay admin (Derek's own use)
   - test-floor = floor
   - test-client = brand client
3. **Netlify:** create two new sites with no repository link, named `shipbay-wms-dev` and `shipbay-portal-dev`. Upload
   `<out>/wms` and `<out>/portal` by "deploy a folder".
   - Addresses: `https://shipbay-wms-dev.netlify.app` and `https://shipbay-portal-dev.netlify.app`.
   - No custom domain.
   - Turn on visitor password protection if the plan allows it. The data is synthetic and every screen needs a sign-in.
4. **WMS sign-in:** use "Admin sign-in with email". Employee number + PIN needs the `wms-login` function, which is not on dev.

## What the owner can do with steps 1-4 (no hold released)
- **WMS:** Today, Orders, Receive for Synthetic Records or Synthetic Mailers, printable carton labels, carton scan and count.
- **Portal:** sign-in, orders, inventory and the manual order form.
- The portal's CRM, finance, quotes, integrations and admin pages need tables and functions dev does not have. They will
  show errors there.
- **Put-away is blocked, so there is no stock, picking or shipping yet.** Every pallet position on dev (P-01..P-66,
  STG-01, STG-02) is a shared Nexus position. The bridge is off, and the movement hold applies.

## Optional decisions that would complete the loop without Nexus
- **A. ShipBay-only synthetic positions on dev.** Insert, for example, `SB-01`..`SB-06`
  (`kind pallet, shared false, pickable true`). Then build the WMS with `VITE_PALLET_SCREEN=1`, which brings back the pallet
  section removed on 2026-11-21, in the dev build only.
  - Verified locally in a rolled-back transaction: receive, count, assign to SB-01, put away, stock posted (5 on hand), with
    no Nexus call.
  - Wave pick and pack then work from those positions.
- **B. Shipping from the UI.** The portal's manual "mark shipped" goes through the `labels` function, which is not on dev.
  Options:
  - deploy `labels` to dev with no carrier credentials, after a review that it cannot buy without them; or
  - leave shipping out of the owner trial.

## Status 2026-11-24 11:20 ET (limited authorization of 11:06)
- Netlify sites created, empty, on the existing Pro team: `shipbay-wms-dev` (33350b55…) and `shipbay-portal-dev` (25f2d276…).
  The team's visitor access requires a Netlify team login for every project, so only team members can open them.
- Final builds: `OWNER_WMS_URL=https://shipbay-wms-dev.netlify.app supabase/dev/owner-build.sh <out>`.
  - The portal's WMS links now follow the build's WMS (`WmsHub`, `ClientWarehouse`, `WmsAdmin` read `WMS_URL` from
    `WmsWindow`; the production build is unchanged).
  - The build refuses the production WMS address.
  - A fixed development notice lists what does not work.
- Auth: public sign-up was already off (`disable_signup: true`). dev_038 lets Auth's admin path create a login that is
  already confirmed; a sign-up is still refused. The owner's login is created by Derek in the dashboard (Add user, Auto
  Confirm, password typed there). Claude then sets its profile to `shipbay_admin`.
- Isolation, read on dev:
  - The client login sees 0 rows of the other brand.
  - A login with no brand sees nothing.
  - The public key is refused.
- Not published: this workspace cannot reach Netlify and the browser here cannot upload files. Derek uploads the two zips.

## dev_039 applied 2026-11-24 16:37Z (Derek's approval 11:35 ET), shipbay-nexus-dev only
- The file matched commit 2768139 exactly (sha256 26fb4ddf…). Before applying, dev had triggers `dev_no_signup` and
  `on_auth_user_created`, with `dev_no_signup` at md5 5724a296 (the dev_038 version).
- After applying:
  - Triggers: `dev_admin_created_only` (deferred to commit), `dev_no_signup`, `on_auth_user_created`.
  - Function fingerprints match the locally tested ones: `dev_no_signup` 591ace2f, `dev_admin_created_only` c1bf189e.
  - `handle_new_user` and `profiles_guard` are unchanged.
  - Only `supabase_auth_admin` may execute the new check.
  - The 4 logins and their profiles are unchanged (md5 5735979e).
  - Every public table still has row security on.
  - Auth still reports `disable_signup: true`.
  - The client login still sees 0 rows of the other brand.
- Not provable from here: a real Auth insert (the `postgres` role cannot act as `supabase_auth_admin`). Derek's retry is the
  live test; the Auth and Postgres logs are read afterwards.
- 16:37:47Z: an admin created the login xavier.delmonte24@gmail.com in the dashboard. Auth logged it as `user_signedup` by
  `service_role`, which is the live proof that dev_039 works. Its profile was the default (`client_user`, no brand). The WMS
  refused it ("isn't set up for the WMS"), because `WMS_ROLES` and `is_wms_staff()` accept only shipbay_admin, shipbay_staff
  and wms_employee.
- 16:4xZ: one-row update, `profiles.role = 'shipbay_admin'` for id 937a699a-…. Nothing else changed: `org_id` stays null,
  `is_owner` false, `is_sales` false.
  - Read as that login afterwards: `is_wms_staff` true, `is_shipbay` true, owner false; 2 brands, 6 products, 9 pallets;
    `wms_today` and `wms_stock_summary` answer.
  - The four synthetic logins and their profiles are unchanged (md5 5735979e).
- The WMS Derek opened is https://sparkling-tartufo-ab3928.netlify.app. It serves this build (the dev notice shows), but it
  is not one of the team's sites, so it does not require a Netlify team login.
