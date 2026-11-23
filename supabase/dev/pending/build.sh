#!/bin/bash
# Regenerates the dev migrations from their candidates and the dev helpers. Writes files; applies nothing.
cd "$(dirname "$0")/../../.." && python3 - <<'PY'
import re
m=open('supabase/dev/movement-dev.sql').read()
strip=lambda t: re.sub(r'(?m)^(begin|commit);\s*$','',t).strip()+'\n'
def fn(t,name):
    a=t.index('create or replace function public.%s('%name); b=t.index('end $$;',a)+len('end $$;'); return t[a:b]
p='supabase/dev/pending/dev_032_pallet_stock_safety.sql'; head=open(p).read().split('-- ===== 1.')[0]
c=open('supabase/candidates/20261204_wms_pallet_stock_safety.sql').read()
open(p,'w').write(head+"-- ===== 1. candidate 20261204 =====\n"+strip(c)+"\n-- ===== 2. dev helpers changed since dev_029 =====\n"+fn(m,'dev_movement_snapshot')+"\n\n"+fn(m,'dev_runner_begin')+"\n")
p='supabase/dev/pending/dev_033_open_box_safety.sql'; head=open(p).read().split('-- ===== candidate')[0]
c=open('supabase/candidates/20261205_wms_open_box_safety.sql').read()
open(p,'w').write(head+"-- ===== candidate 20261205 =====\n"+strip(c))
p='supabase/dev/pending/dev_034_manager_pick_corrections.sql'; head=open(p).read().split('-- ===== candidate')[0]
c=open('supabase/candidates/20261206_wms_manager_pick_corrections.sql').read()
open(p,'w').write(head+"-- ===== candidate 20261206 =====\n"+strip(c))
p='supabase/dev/pending/dev_035_inventory_ledger_hardening.sql'; head=open(p).read().split('-- ===== candidate')[0]
c=open('supabase/candidates/20261207_inventory_ledger_hardening.sql').read()
open(p,'w').write(head+"-- ===== candidate 20261207 =====\n"+strip(c))
PY
