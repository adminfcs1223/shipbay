#!/bin/bash
# Regenerates dev_032_pallet_stock_safety.sql from the candidate and the dev helpers. Writes a file; applies nothing.
cd "$(dirname "$0")/../../.." && python3 - <<'PY'
import re
c=open('supabase/candidates/20261204_wms_pallet_stock_safety.sql').read(); m=open('supabase/dev/movement-dev.sql').read()
strip=lambda t: re.sub(r'(?m)^(begin|commit);\s*$','',t).strip()+'\n'
def fn(t,name):
    a=t.index('create or replace function public.%s('%name); b=t.index('end $$;',a)+len('end $$;'); return t[a:b]
p='supabase/dev/pending/dev_032_pallet_stock_safety.sql'; head=open(p).read().split('-- ===== 1.')[0]
open(p,'w').write(head+"-- ===== 1. candidate 20261204 =====\n"+strip(c)+"\n-- ===== 2. dev helpers changed since dev_029 =====\n"+fn(m,'dev_movement_snapshot')+"\n\n"+fn(m,'dev_runner_begin')+"\n")
PY
