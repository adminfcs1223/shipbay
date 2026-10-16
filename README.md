# shipbay

Everything that runs ShipBay 3PL (shipbay3pl.com), in one repo.

| Folder | What | Deploys to |
|---|---|---|
| `site/` | Marketing site + intake forms (static HTML, no build) | Netlify project **shipbay3pl** → https://www.shipbay3pl.com |
| `portal/` | Client portal + ShipBay ops (React / Vite / supabase-js) | Netlify project **shipbay-portal** → https://shipbay-portal.netlify.app (→ portal.shipbay3pl.com) |
| `supabase/migrations/` | Database schema, RLS, RPCs — one file per applied migration | Supabase project `shipbay` (`poxlczzkpztmoiixyrth`) |
| `supabase/functions/` | Edge functions (Shopify ingest/fulfill, lead emails, HubSpot sync) | same |

## Netlify setup (one time, in the Netlify UI)

Both Netlify projects link to this repo, branch `main`, each with its own base directory:

**shipbay3pl** — Site settings → Build & deploy → Build settings
- Base directory: `site`
- Build command: *(empty)*
- Publish directory: `site`

**shipbay-portal**
- Base directory: `portal`
- Build command: `npm ci && npm run build`
- Publish directory: `portal/dist`
- Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_KEY` (the *publishable* key — see `portal/.env.example`)

After linking, every push to `main` redeploys whichever folder changed.

## Supabase

Schema changes go in a new file under `supabase/migrations/` named `YYYYMMDDHHMMSS_name.sql`, then
`supabase db push` (or apply through the Supabase MCP in Claude). Functions:
`supabase functions deploy <name>` (`--no-verify-jwt` for `shopify-webhook`, `notify-lead`, `hubspot-sync`,
`send-rate-card`, `lead-emails`, which are called by Postgres triggers / Shopify, not by signed-in users).

Edge-function secrets (Dashboard → Edge Functions → Secrets): `WEBHOOK_SECRET` (must equal the
`x-webhook-secret` header the lead triggers send), `RESEND_API_KEY`, `HUBSPOT_TOKEN`. Never commit values.

## Portal — local dev

```
cd portal
cp .env.example .env   # fill in the publishable key
npm ci && npm run dev
```

Roles: `shipbay_admin` / `shipbay_staff` see every client and run the warehouse; `client_admin` / `client_user`
see only their own org (enforced by RLS, not by the UI). Full build notes live in the ShipBay 3PL Claude project
(`claude/portal-build-status.md`).

## Rules
- ShipBay and ShipHL are separate businesses. Nothing `shiphl` lives here.
- shipbay3pl.com never sends cold email. Cold outreach runs on the lookalike domains, outside this repo.
- Cold-outreach leads are never loaded into HubSpot; only website inbound (this repo) syncs.
