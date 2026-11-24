#!/bin/bash
# Builds the WMS and the portal for the PRIVATE DEVELOPMENT deployment: connected to shipbay-nexus-dev only. It deploys nothing.
# Usage: supabase/dev/owner-build.sh <empty output folder>        -> <out>/wms and <out>/portal, each a ready-to-upload site
#
# Why a script and not a Netlify build: wms/netlify.toml and portal/netlify.toml set the PRODUCTION database address and proxy
# /api/orders, /oauth/*, /webhooks/* to production functions. A Netlify build from either file would point at production. These
# folders are built here and uploaded as they are (Netlify "deploy a folder"): no netlify.toml goes with them.
# Each folder gets its own _redirects (the app only, nothing proxied anywhere) and _headers (not indexed, not framed).
# The script stops if any built file names the production database, a ShipBay production host or a production key.
set -euo pipefail
R=$(cd "$(dirname "$0")/../.." && pwd); O=${1:?give an empty output folder}; mkdir -p "$O"; [ -z "$(ls -A "$O")" ] || { echo "REFUSED: $O is not empty"; exit 1; }
DEV_URL=https://gdoaonsasbsperqjuurm.supabase.co
DEV_KEY=sb_publishable_GuZFEVYCexPQuxwS1mb3VA_g21gstod     # the dev project's public browser key (row security protects the data)
PROD=poxlczzkpztmoiixyrth
for app in wms portal; do
  W=$(mktemp -d); cp -r "$R/$app/." "$W/"; rm -rf "$W/dist" "$W/netlify.toml"
  ( cd "$W" && [ -d node_modules ] || npm ci --silent )
  # the WMS: put-away through the dev bridge (it answers "switched off" until a movement window is authorized),
  # receiving without a booked inbound shipment (synthetic data has none), no Nexus calendar.
  ( cd "$W" && env -i PATH="$PATH" HOME="$HOME" VITE_SUPABASE_URL=$DEV_URL VITE_SUPABASE_KEY=$DEV_KEY \
      VITE_NEXUS_BRIDGE=$([ $app = wms ] && echo on || echo '') VITE_ALLOW_UNBOOKED=$([ $app = wms ] && echo 1 || echo '') \
      VITE_PALLET_SCREEN=$([ $app = wms ] && echo 1 || echo '') VITE_SHIP_DIRECT=$([ $app = portal ] && echo 1 || echo '') \
      VITE_WMS_URL=${OWNER_WMS_URL:-} npx vite build --logLevel error --outDir "$O/$app" )
  # a fixed notice on every screen: what this is, and what does not work here (nothing is presented as working that is not)
  python3 - "$O/$app/index.html" <<'PY'
import sys; p = sys.argv[1]; s = open(p, encoding='utf8').read()
bar = ('<div id="dev-notice" style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;background:#0F1B2A;color:#fff;'
       'font:600 12px/1.4 Archivo,system-ui,sans-serif;padding:7px 14px;text-align:center">DEVELOPMENT COPY &middot; synthetic test data only &middot; '
       'not connected to production. Put-away: development positions SB-01 to SB-06 only (shared P/STG positions need Nexus and are off). '
       'Shipping: test tracking only, no label is bought, nothing is sent to a carrier or store. Not available: finance, CRM, store and QuickBooks connections.</div>'
       '<style>body{padding-bottom:34px}</style>')
assert '</body>' in s; open(p, 'w', encoding='utf8').write(s.replace('</body>', bar + '</body>', 1))
PY
  printf '/*  /index.html  200\n' > "$O/$app/_redirects"
  printf '/*\n  X-Robots-Tag: noindex, nofollow\n  X-Frame-Options: DENY\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Cache-Control: no-store\n' > "$O/$app/_headers"
  rm -rf "$W"
done
# the production reference may appear only inside the WMS's own refusal check (includes(`<ref>`)); a carrier or store API host never
if grep -rIoh ".\{0,10\}$PROD" "$O" | grep -v "includes(\`$PROD" | grep -q .; then echo "REFUSED: a built file names the production database. Do not upload."; exit 1; fi
if grep -rIl "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBveGxj\|shipbay3pl\.com/api\|wmsshipbay\.netlify\.app\|api\.veeqo\.com\|api\.easypost\.com\|api\.goshippo\.com\|api\.shipengine\.com\|myshopify\.com/admin" "$O"; then echo "REFUSED: a built file names a production key or a carrier/store API (above). Do not upload."; exit 1; fi
grep -rIl "gdoaonsasbsperqjuurm" "$O/wms" > /dev/null && grep -rIl "gdoaonsasbsperqjuurm" "$O/portal" > /dev/null || { echo "REFUSED: a build does not name the dev database"; exit 1; }
echo "built for shipbay-nexus-dev only:"; (cd "$O" && find . -name index.html -exec sha256sum {} \;)
