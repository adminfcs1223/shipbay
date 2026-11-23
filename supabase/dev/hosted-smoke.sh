#!/bin/bash
# Read-only smoke test of the hosted bridge on shipbay-nexus-dev with pallet movement OFF. NOT YET RUN: the build sandbox cannot
# reach supabase.co. Run it from a machine that can. Passwords are asked for without echo and are not stored.
# Usage: ANON_KEY=<the dev project's public anon key> ./hosted-smoke.sh
set -u; REF=gdoaonsasbsperqjuurm; BASE="https://$REF.supabase.co"; F="$BASE/functions/v1/nexus-bridge"; : "${ANON_KEY:?set ANON_KEY to the dev project's public anon key}"
pass=0; fail=0; ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "ok   $3"; else fail=$((fail+1)); echo "FAIL $3 (got $1, expected $2)"; fi; }
code() { curl -s -o /tmp/smoke.out -w '%{http_code}' "$@"; }
token() { read -r -s -p "Password for $1: " pw; echo >&2
  curl -s "$BASE/auth/v1/token?grant_type=password" -H "apikey: $ANON_KEY" -H 'content-type: application/json' --data-binary @<(printf '{"email":"%s","password":"%s"}' "$1" "$pw") | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'; unset pw; }
ok "$(code "$F/status" -H "authorization: Bearer $ANON_KEY")" 200 "status answers"; grep -q '"connection":"staging"' /tmp/smoke.out && echo "     connection: staging" || echo "     connection is not staging: $(cat /tmp/smoke.out)"
grep -q '"pallet_moves":false' /tmp/smoke.out; ok $? 0 "pallet movement is off"
FLOOR=$(token test-floor@example.test); ADMIN=$(token test-admin@example.test); CLIENT=$(token test-client@example.test)
[ -n "$FLOOR" ] && [ -n "$ADMIN" ] && [ -n "$CLIENT" ]; ok $? 0 "the three test logins sign in"
ok "$(code -X POST "$F/putaway" -H "authorization: Bearer $CLIENT" -H 'content-type: application/json' -d '{"psku":"PSKU-000001","location":"P-01"}')" 403 "a client login is refused"
ok "$(code -X POST "$F/putaway" -H "authorization: Bearer $FLOOR" -H 'content-type: application/json' -d '{"psku":"PSKU-000001","location":"P-01"}')" 503 "put-away is refused while movement is off"
grep -q pallet_moves_off /tmp/smoke.out; ok $? 0 "and says movement is off"
ok "$(code "$F/floor" -H "authorization: Bearer $FLOOR")" 200 "the floor reads from Nexus"; grep -q '"warehouse":"HILLSBOROUGH-TEST"' /tmp/smoke.out; ok $? 0 "and it is the test floor"
ok "$(code "$F/reconcile" -H "authorization: Bearer $FLOOR")" 403 "floor staff cannot reconcile"
ok "$(code "$F/reconcile" -H "authorization: Bearer $ADMIN")" 200 "an admin can"
ok "$(code -X POST "$F/registry/sync" -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{"apply":true}')" 200 "registry sync answers"; grep -q '"applied":false' /tmp/smoke.out; ok $? 0 "and only reports while registry writes are off"
rm -f /tmp/smoke.out; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
