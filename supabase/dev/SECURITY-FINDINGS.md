# Authentication and permission review, 2026-11-22

Production (`poxlczzkpztmoiixyrth`) was checked READ-ONLY: its public Auth settings page, function text, grants, policies and counts.
Nothing in production was changed. The development database (`gdoaonsasbsperqjuurm`) was fixed; see `security-dev.sql`.

## Production: open as of the check
1. **Anyone can make themselves an admin.** Public sign-up is on (`disable_signup: false`, email provider on, confirmation required).
   `handle_new_user` copies `role` and `org_id` from the sign-up form's own data into the new profile. Register with a real email,
   ask for `shipbay_admin`, confirm, and the login is an admin.
   No sign of use: 14 logins, none ever sent a sign-up confirmation email. One of the 4 elevated logins is not on a company domain; confirm it.
   Fix now: turn off "Allow new users to sign up". Fix properly: the function in `security-dev.sql`, AFTER the Admin → Users code
   is changed to pass role and brand in app metadata (or to set the profile itself), or new staff logins will come out as client_user.
2. **A login with no brand can create a connector key for any brand** whose id it knows (`wms_org_create_key`), and read its key
   list (`wms_org_connector`). 5 production logins have no brand and are not admin. 0 keys were ever created by such a login.
   Brand ids are not readable to an outsider, so on its own this needs an id leak; with finding 1 it needs nothing.
3. **An order insert naming a brand the caller cannot see spins until the timeout** (`set_order_cutoff`): 3 seconds with only the
   public key, 8 with a login. Nothing is written. The public role has insert rights on `orders`, so no login is needed. A cheap way to load the database.
4. Low: the position list (`locations`) is readable with only the public key.

## Development: state after the fixes
- Sign-up setting is still ON in the project (these tools cannot change project Auth settings). Compensated in the database: no login
  can be created except by the database owner. Not exercised by a real sign-up attempt (no tool here can send one).
- `dev_security_check()`: a login created with typed role `shipbay_admin`, a brand and `is_owner` comes out `client_user`, no brand.
  As that login, 50 attempts (role changes, direct table writes, receiving, put-away, move, release, waves, voids, keys, PINs,
  registry, calendar): 45 refused, 5 touched no rows, database fingerprint unchanged. It reads nothing but its own profile and the
  position list. With only the public key: everything refused except reading the position list.
- Every table has row security. Warehouse tables have no write policy at all: writes go only through functions that check the caller.
