# Hosted bridge on shipbay-nexus-dev: what is ready and the exact steps

Target: Supabase project `gdoaonsasbsperqjuurm` (shipbay-nexus-dev) ONLY. Never `poxlczzkpztmoiixyrth` (production): the function
refuses to run there, and nothing below names it.

## Ready
- Database: schema, candidates through `20261201`, synthetic records, sign-in identities. Regression: 13 checks pass in the hosted database.
- Function: `supabase/functions/nexus-bridge/` (index.ts, core.js, pallets.js, calendar.js, postgrest.js). Type-checks under Deno 2.9.6 and
  runs under Deno against the local database (`supabase/tests/deno/run.sh`).
- The project still has its legacy anon and service keys enabled, which is what the function's database calls use.

## Steps, in order (each needs Derek's go)
1. Deploy function `nexus-bridge` with JWT verification ON, the five files above, no secrets yet.
   Expected: `GET /functions/v1/nexus-bridge/status` answers `connection: "off"`. Every other route answers 503 `bridge_off`.
2. Derek, in the dev project's dashboard (Edge Functions, Secrets), never in chat:
   - `NEXUS_BRIDGE_MODE` = `staging`
   - `NEXUS_STAGING_API_KEY` = the Nexus staging key bound to HILLSBOROUGH-TEST
   - leave `NEXUS_PALLET_MOVES`, `NEXUS_REGISTRY_WRITES`, `NEXUS_CALENDAR_WRITES` unset (all off)
   Expected: status says `staging`, `pallet_moves: false`. Reads work (`/floor`, `/reconcile` as admin, `/registry/sync` as a report).
   `/putaway`, `/move`, `/release` answer 503 `pallet_moves_off`.
3. Derek sets a throwaway password for each test login in the dev SQL editor (see `auth-dev.sql`), and turns OFF
   "Allow new users to sign up" in the dev project's Auth settings (see Blockers).
4. Run `hosted-smoke.sh` from a machine that can reach supabase.co. It asks for the test passwords without echoing them.
5. Only after Nexus issues the movement-capable test-floor key and Derek approves: replace the key, set `NEXUS_PALLET_MOVES` = `on`,
   and run the synthetic rehearsal (put away, lost answer, move, release, off the floor and back, reconcile).

## Blockers and open points
- No movement-capable Nexus key yet (Derek is arranging it). Until then step 5 cannot run.
- Sign-ups: `handle_new_user` takes a new login's role from the sign-up form's own data. If sign-ups are open, anyone holding the
  project's public key could create an admin login. This is production's function, unchanged. On dev: turn sign-ups off before the
  function or any site is exposed. On production: confirm sign-ups are off (not checked here; the setting is not visible to these tools).
- Never run under Supabase's own edge runtime, only under stock Deno. First hosted run is the first proof of the platform's request
  path, JWT check and injected settings.
- `BRIDGE_ALLOWED_ORIGINS` stays empty until a WMS development site exists, so no browser can call the function yet. The smoke script
  does not need it.
- Stock of an off-floor pallet is booked at the holding location `OFF-FLOOR`, and wave picking can pick from there. Picks made there
  are not tied to the pallet, so if it later returns to the shared floor the holding location and the new position can each be off
  by the picked amount (the total stays right). Reopening a wave stop after its pallet moved puts the units back at the old position.
  Both need a decision before real pallets.
