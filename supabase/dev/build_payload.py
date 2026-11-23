# Turns the warehouse-only subset + the candidate files into ordered migration files for the dev project.
import re, os, collections
S='/home/claude/devdb/subset'; C='/home/claude/wms-cal/supabase/candidates'; P='/home/claude/devdb/payload'; os.makedirs(P, exist_ok=True)
for f in os.listdir(P): os.remove(f'{P}/{f}')
rd=lambda p: open(p).read()
strip=lambda t: '\n'.join(l for l in t.split('\n') if not l.startswith('--')).strip()+'\n'    # whole-line comments at column 0 only (never inside a function body: those are indented or dollar-quoted text we keep)
# --- compact grants: same privileges, grouped
g=rd(f'{S}/09_grants.sql'); schema=[]; revoke=collections.defaultdict(list); grant=collections.defaultdict(list)
for line in g.split('\n'):
    line=line.strip()
    if not line or line.startswith('--'): continue
    m=re.match(r'REVOKE ALL ON (TABLE|SEQUENCE|FUNCTION) (.+) FROM PUBLIC, anon, authenticated, service_role;$', line)
    if m: revoke[m.group(1)].append(m.group(2)); continue
    m=re.match(r'GRANT (.+) ON (TABLE|SEQUENCE|FUNCTION) (.+) TO ([A-Za-z_]+);$', line)
    if m: grant[(m.group(2), m.group(1), m.group(4))].append(m.group(3)); continue
    if ' ON SCHEMA ' in line: schema.append(line); continue
    raise SystemExit('unparsed grant line: '+line)
out=['-- privileges exactly as production has them on these objects, grouped (same result as one statement per object)']+schema
for kind, objs in revoke.items(): out.append(f"REVOKE ALL ON {kind} {', '.join(objs)} FROM PUBLIC, anon, authenticated, service_role;")
for (kind, privs, who), objs in grant.items(): out.append(f"GRANT {privs} ON {kind} {', '.join(objs)} TO {who};")
grants='\n'.join(out)+'\n'
# --- functions split in two at a function boundary
fs=rd(f'{S}/05_functions.sql'); parts=[q for q in re.split(r'(?=^CREATE OR REPLACE FUNCTION public\.)', fs, flags=re.M)]; head, parts = parts[0], parts[1:]
total=sum(map(len,parts)); cuts=[]; acc=0
for i,p in enumerate(parts):
    acc+=len(p)
    if acc>=total*(len(cuts)+1)/3 and len(cuts)<2: cuts.append(i+1)
files=[
 ('001_base_tables_constraints', strip(rd(f'{S}/01_tables.sql'))+strip(rd(f'{S}/02_constraints.sql'))),
 ('002_base_functions_a', 'set check_function_bodies = off;\n'+''.join(parts[:cuts[0]])),
 ('003_base_functions_b', 'set check_function_bodies = off;\n'+''.join(parts[cuts[0]:cuts[1]])),
 ('003_base_functions_c', 'set check_function_bodies = off;\n'+''.join(parts[cuts[1]:])),
 ('004_base_indexes_fkeys_views_triggers_policies', 'set search_path = public, extensions;\n'+''.join(strip(rd(f'{S}/{f}')) for f in ['04_indexes.sql','03_fkeys.sql','06_views.sql','07_triggers.sql','08_policies.sql'])),
 ('005_base_grants', grants),
 ('006_auth_profile_trigger', 'create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();\n'),
]
for i,c in enumerate(['20261123_wms_booking_receiving','20261124_nexus','20261124_nexus_map','20261124_nexus_shared_controls','20261125_wms_activity','20261126_nexus_dock','20261127_wms_waves','20261128_nexus_registry_sync','20261129_wms_calendar_publish','20261130_wms_nexus_putaway']):
    files.append((f'{7+i:03d}_candidate_{c}', rd(f'{C}/{c}.sql')))
for n,t in files: open(f'{P}/{n}.sql','w').write(t)
print('\n'.join(f'{len(t):7d} {n}' for n,t in files)); print(sum(len(t) for n,t in files))
