import os
# Builds a warehouse-only copy of the schema extract: every statement that belongs to a dropped table or function is left out.
# Input: the schema-only extract. Output: ./subset/ with the same file names (so the local test loader can use it), plus a report.
import re, os, sys, json
X='/home/claude/staging/extract'; OUT='/home/claude/devdb/subset'; os.makedirs(OUT, exist_ok=True)
DROP_T = set("""cameras cce_call_plan cce_hs_batches cce_parked_leads fin_pipeline fin_qbo_reports fin_qbo_status fin_qbo_tokens fin_recurring fin_settings
fin_transactions gmail_accounts gmail_messages hs_sequence_enrollments hs_sequences integration_secrets integrations org_integrations platform_secrets oauth_states
job_applications job_postings leads make_blitz_state quotes reps sales_availability sales_call_sessions sales_calls sales_email_sends sales_followups sales_leads
sales_meetings sales_rep_settings sales_scripts sales_sequence_queue sales_sources sales_strategies sales_touches sequence_queue sl_campaign_leads_snapshot
sl_campaign_stats_snapshot sl_fetch_log sl_lead_removals webhook_log team_members rate_cards tickets ticket_messages documents onboarding_tasks invoices invoice_lines
storage_snapshots""".split())
EXTRA_DROP_F = set(sys.argv[1].split(',')) if len(sys.argv) > 1 and sys.argv[1] else set()
rd=lambda f: open(f'{X}/{f}').read()
word=lambda names: re.compile(r'(?<![a-z_0-9.])(?:public\.)?(' + '|'.join(sorted(map(re.escape,names),key=len,reverse=True)) + r')(?![a-z_0-9])') if names else re.compile(r'(?!x)x')
# ---- functions
fsrc=rd('05_functions.sql'); head=fsrc[:fsrc.index('CREATE OR REPLACE FUNCTION public.')]
funcs={}
for p in [q for q in re.split(r'(?=^CREATE OR REPLACE FUNCTION public\.)', fsrc[len(head):], flags=re.M) if q.strip()]:
    funcs[re.match(r'CREATE OR REPLACE FUNCTION public\.([a-z_0-9]+)', p).group(1)] = p
tables=re.findall(r'^CREATE TABLE public\.([a-z_0-9]+)', rd('01_tables.sql'), flags=re.M)
views_src=rd('06_views.sql'); vparts=re.split(r'(?=^CREATE VIEW public\.)', views_src, flags=re.M); vhead=vparts[0]
views={re.match(r'CREATE VIEW public\.([a-z_0-9]+)', v).group(1): v for v in vparts[1:]}
tre=word(DROP_T)
drop_v={n for n,v in views.items() if tre.search(v)}
drop_f={n for n,p in funcs.items() if tre.search(p) or re.search(r'\bnet\.', p)} | EXTRA_DROP_F
changed=True
while changed:   # views over dropped views; functions that only exist to serve dropped things are found by the reports below, not guessed
    changed=False; vre=word(DROP_T|drop_v)
    for n,v in views.items():
        if n not in drop_v and vre.search(v): drop_v.add(n); changed=True
    for n,p in funcs.items():
        if n not in drop_f and word(drop_v).search(p): drop_f.add(n); changed=True
fre=re.compile(r'(?<![a-z_0-9.])(?:public\.)?(' + '|'.join(sorted(drop_f,key=len,reverse=True)) + r')\s*\(')
report={'dropped_tables':sorted(DROP_T),'dropped_views':sorted(drop_v),'dropped_functions':sorted(drop_f),'kept_functions_calling_dropped':{},'flags':[]}
for n,p in funcs.items():
    if n in drop_f: continue
    body=p.split('\n',1)[1]; hit=sorted(set(m.group(1) for m in fre.finditer(body)))
    if hit: report['kept_functions_calling_dropped'][n]=hit
# ---- write filtered files
def stmts(text):   # one statement per ';' at end of line (these files have no function bodies)
    out=[]; cur=[]
    for line in text.split('\n'):
        cur.append(line)
        if line.rstrip().endswith(';'): out.append('\n'.join(cur)); cur=[]
    return out, '\n'.join(cur)
def filt(name, keep):
    s, tail = stmts(rd(name)); kept=[x for x in s if keep(x)]
    open(f'{OUT}/{name}','w').write('\n'.join(kept)+'\n'); return len(s), len(kept)
allre=word(DROP_T|drop_v); counts={}
def on_table(x):
    m=re.search(r'(?:CREATE TABLE|ALTER TABLE(?: ONLY)?|ON(?: TABLE)?|CREATE SEQUENCE IF NOT EXISTS) (?:public\.)?([a-z_0-9]+)', x); return m.group(1) if m else None
counts['01_tables']=filt('01_tables.sql', lambda x: not allre.search(x) and 'hs_sequence_enrollments_id_seq' not in x)
def keep_generic(x):
    if allre.search(x): return False
    if fre.search(x): report['flags'].append('references dropped function: '+' '.join(x.split())[:160]); return False
    return True
for f in ['02_constraints.sql','03_fkeys.sql','04_indexes.sql','08_policies.sql']: counts[f]=filt(f, keep_generic)
def keep_trig(x):
    if not x.strip().startswith(('CREATE TRIGGER','ALTER TABLE')): return True
    m=re.search(r'EXECUTE FUNCTION ([a-z_0-9]+)', x)
    if allre.search(x) or (m and m.group(1) in drop_f): 
        t=re.search(r' ON ([a-z_0-9]+) ', x)
        if t and t.group(1) not in DROP_T: report['flags'].append('trigger on kept table dropped: '+' '.join(x.split())[:170])
        return False
    return True
counts['07_triggers.sql']=filt('07_triggers.sql', keep_trig)
open(f'{OUT}/06_views.sql','w').write(vhead+''.join(v for n,v in views.items() if n not in drop_v))
open(f'{OUT}/05_functions.sql','w').write(head+''.join(p for n,p in funcs.items() if n not in drop_f))
gre=re.compile(r'(?:TABLE|SEQUENCE|FUNCTION) public\.([a-z_0-9]+)')
def keep_grant(x):
    m=gre.search(x)
    n=m.group(1) if m else ''
    seq_of_dropped = 'SEQUENCE' in x and any(n.startswith(t + '_') for t in DROP_T)
    return not (m and (n in DROP_T or n in drop_v or n in drop_f or seq_of_dropped))
counts['09_grants.sql']=filt('09_grants.sql', keep_grant)
report['counts']={k:{'before':a,'after':b} for k,(a,b) in counts.items()}
report['kept_tables']=[t for t in tables if t not in DROP_T]; report['kept_views']=[v for v in views if v not in drop_v]; report['kept_function_count']=len(funcs)-len(drop_f)
json.dump(report, open('/home/claude/devdb/subset-report.json','w'), indent=1)
print('tables kept', len(report['kept_tables']), 'views kept', report['kept_views'], 'functions kept', report['kept_function_count'], 'dropped', len(drop_f))
print('DROPPED FUNCS:', ' '.join(sorted(drop_f)))
print('KEPT CALLING DROPPED:', json.dumps(report['kept_functions_calling_dropped']))
print('FLAGS:'); [print(' ', f) for f in report['flags']]
print({k:v for k,v in counts.items()}); print('bytes', {f: os.path.getsize(f'{OUT}/{f}') for f in sorted(os.listdir(OUT))})
# personal contact details in column defaults are replaced with synthetic values (production staff names, phones and e-mails stay out of dev)
p=f'{OUT}/01_tables.sql'; t=open(p).read()
for a,b in [tuple(l.rstrip('\n').split('\t')) for l in open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'scrub.local.tsv')) if '\t' in l]:   # real value<TAB>synthetic value, one pair per line; the file is not committed
    assert a in t, a; t=t.replace(a,b)
open(p,'w').write(t)
