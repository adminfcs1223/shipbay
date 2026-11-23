#!/bin/bash
# The deployed bridge with everything OFF (no secrets set). Needs no login. Run from a machine that can reach supabase.co.
# Usage: ANON_KEY=<public anon key of the dev project> ./hosted-smoke-disabled.sh
set -u; F="https://gdoaonsasbsperqjuurm.supabase.co/functions/v1/nexus-bridge"; : "${ANON_KEY:?set ANON_KEY to the public anon key of the dev project}"
pass=0; fail=0; ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "ok   $3"; else fail=$((fail+1)); echo "FAIL $3 (got $1, expected $2)"; fi; }
code() { curl -s -o /tmp/smoke.out -w '%{http_code}' "$@"; }; A=(-H "authorization: Bearer $ANON_KEY" -H 'content-type: application/json')
ok "$(code "$F/status")" 401 "no authorization header: refused before the function runs"
ok "$(code "$F/status" "${A[@]}")" 200 "status answers"; grep -q '"connection":"off"' /tmp/smoke.out; ok $? 0 "connection is off"
grep -q '"pallet_moves":false' /tmp/smoke.out && grep -q '"calendar_writes":false' /tmp/smoke.out && grep -q '"registry_writes":false' /tmp/smoke.out; ok $? 0 "movement, calendar and registry writes are off"
for r in putaway move release pending/retry reconcile/record reconcile/undo registry/sync calendar/sync; do
  ok "$(code -X POST "$F/$r" "${A[@]}" -d '{"psku":"PSKU-000001","location":"P-01","reason":"shipped_out","confirmed":true,"apply":true}')" 503 "POST /$r refused"; grep -q bridge_off /tmp/smoke.out; ok $? 0 "  with bridge_off"
done
for r in floor pending reconcile "calendar?from=2026-11-22&to=2026-11-29"; do ok "$(code "$F/$r" "${A[@]}")" 503 "GET /$r refused"; done
# a real sign-up attempt asking for admin: must not produce a login
ok "$(code -X POST "https://gdoaonsasbsperqjuurm.supabase.co/auth/v1/signup" -H "apikey: $ANON_KEY" -H 'content-type: application/json' -d "{\"email\":\"probe-$(date +%s)@example.test\",\"password\":\"$(head -c 18 /dev/urandom | base64)\",\"data\":{\"role\":\"shipbay_admin\"}}" | grep -c '^2')" 0 "sign-up asking for admin is refused"
rm -f /tmp/smoke.out; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
