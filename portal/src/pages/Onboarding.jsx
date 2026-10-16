import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib';

const DOC_KIND = { intake_form: 'intake_form', w9: 'w9', formation_cert: 'formation_cert', rate_card: 'rate_card', agreement: 'agreement', sla: 'sla' };
const BILLING = [
  ['ach', 'ACH / bank debit', 'We pull each invoice from the client’s bank account on the due date.'],
  ['card', 'Credit card on file', 'Card charged on the due date (processing fee may apply).'],
  ['wire', 'Wire transfer', 'Client wires each invoice; we send remittance details.'],
  ['check', 'Check', 'Mailed to 115 Stryker Ln, Hillsborough NJ 08844.'],
  ['net_terms', 'Net terms (invoice)', 'Invoice sent monthly; client pays by the due date.'],
];

const PHASES = [
  { key: 'paperwork', label: 'Paperwork', icon: 'paperwork' },
  { key: 'systems', label: 'Systems', icon: 'systems' },
  { key: 'inventory', label: 'Inventory', icon: 'inventory' },
  { key: 'go_live', label: 'Go-live / Test', icon: 'golive' },
];
const GO_LIVE_STATUS = [
  ['on_time', 'On time', 'ok'],
  ['at_risk', 'At risk', 'warn'],
  ['delayed', 'Delayed', 'bad'],
  ['on_hold', 'On hold', 'muted'],
  ['complete', 'Complete', 'navy'],
];
const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null);

/* Phase icons — shipbay theme: navy tile, orange accent, 2px strokes */
const PhaseIcon = ({ kind }) => {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', viewBox: '0 0 24 24' };
  switch (kind) {
    case 'paperwork': return <svg {...common}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h6" className="accent" /></svg>;
    case 'systems': return <svg {...common}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /><path d="M7 10h3l2-3 2 6 2-3h1" className="accent" /></svg>;
    case 'inventory': return <svg {...common}><path d="M21 8l-9-5-9 5v8l9 5 9-5z" /><path d="M3 8l9 5 9-5" /><path d="M12 13v8" className="accent" /></svg>;
    case 'golive': return <svg {...common}><path d="M3 17l3-3h4l5-5a3 3 0 0 1 4-4l1 1a3 3 0 0 1-4 4l-5 5v4l-3 3" /><path d="M3 21l4-4" className="accent" /><path d="M14 3l7 7" className="accent" /></svg>;
    default: return null;
  }
};

export default function Onboarding({ me }) {
  const [accounts, setAccounts] = useState(null);
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    const { data } = await supabase.from('v_onboarding_progress').select('*').in('status', ['onboarding', 'active']).order('created_at', { ascending: false });
    setAccounts(data || []);
    setSelected((s) => s ?? data?.[0]?.org_id ?? null);
  };
  useEffect(() => { load(); }, []);

  const onboarding = (accounts || []).filter((a) => a.status === 'onboarding');
  const current = (accounts || []).find((a) => a.org_id === selected);

  return (
    <>
      <div className="pagehead">
        <div><h1>Onboarding<span className="dot">.</span></h1></div>
        <button className="btn-sm primary" onClick={() => setAdding(true)}>+ Start onboarding</button>
      </div>

      <div className="onb">
        <div className="card">
          <div className="cardhead"><h3>Accounts</h3><div className="spacer" /><span className="tag">{onboarding.length} in progress</span></div>
          {accounts === null ? <div className="empty">Loading…</div> : accounts.length === 0 ? <div className="empty">No accounts yet. Start one from a website lead or by name.</div> : (
            <ul className="acctlist">
              {accounts.map((a) => (
                <li key={a.org_id}>
                  <button className={`acct ${a.org_id === selected ? 'active' : ''}`} onClick={() => setSelected(a.org_id)}>
                    <div className="nm">{a.name}{a.founding_account && <span className="tag founding">founding</span>}{a.status === 'active' && <span className="tag live">live</span>}</div>
                    <div className="meta">{a.contact_name || a.contact_email || '—'} · {a.done}/{a.total} done{a.go_live_date ? ` · est. ${fmt(a.go_live_date)}` : ''}</div>
                    <div className="bar"><i style={{ width: `${a.total ? (100 * a.done) / a.total : 0}%` }} /></div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {current ? <AccountDetail key={current.org_id} account={current} me={me} onChange={load} /> : <div className="card"><div className="empty">Pick an account.</div></div>}
      </div>

      {adding && <StartOnboarding onClose={() => setAdding(false)} onCreated={(id) => { setAdding(false); setSelected(id); load(); }} />}
    </>
  );
}

function AccountDetail({ account, me, onChange }) {
  const [org, setOrg] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [docs, setDocs] = useState([]);
  const [openPhase, setOpenPhase] = useState(null);
  const [editing, setEditing] = useState(null);
  const [billingOpen, setBillingOpen] = useState(false);

  const load = async () => {
    const [{ data: o }, { data: t }, { data: d }] = await Promise.all([
      supabase.from('orgs').select('*').eq('id', account.org_id).single(),
      supabase.from('onboarding_tasks').select('*').eq('org_id', account.org_id).order('sort'),
      supabase.from('documents').select('*').eq('org_id', account.org_id).not('task_key', 'is', null).order('created_at', { ascending: false }),
    ]);
    setOrg(o); setTasks(t || []); setDocs(d || []);
  };
  useEffect(() => { load(); }, [account.org_id]);

  const patchOrg = async (patch) => { await supabase.from('orgs').update(patch).eq('id', org.id); load(); onChange(); };
  const toggle = async (t) => {
    const done = !t.done;
    await supabase.from('onboarding_tasks').update({ done, done_at: done ? new Date().toISOString() : null, done_by: done ? me.id : null }).eq('id', t.id);
    load(); onChange();
  };
  const upload = async (t, file) => {
    if (!file) return;
    if (file.type !== 'application/pdf') return alert('Please upload a PDF.');
    const path = `${org.id}/${t.key}/${crypto.randomUUID()}-${file.name.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
    const { error: upErr } = await supabase.storage.from('client-docs').upload(path, file, { contentType: 'application/pdf', upsert: false });
    if (upErr) return alert(upErr.message);
    const { error } = await supabase.from('documents').insert({ org_id: org.id, kind: DOC_KIND[t.key] || 'other', title: `${t.label} — ${org.name}`, storage_path: path, mime: 'application/pdf', size_bytes: file.size, task_key: t.key, status: 'pending', uploaded_by: me.id });
    if (error) return alert(error.message);
    load(); onChange();
  };
  const viewDoc = async (d) => {
    const { data, error } = await supabase.storage.from('client-docs').createSignedUrl(d.storage_path, 600);
    if (error) return alert(error.message);
    window.open(data.signedUrl, '_blank', 'noopener');
  };
  const saveNote = async (t, note) => { await supabase.from('onboarding_tasks').update({ note: note.trim() || null }).eq('id', t.id); setEditing(null); load(); };
  const markLive = async () => {
    if (!confirm(`Mark ${org.name} as live? This moves them out of onboarding.`)) return;
    await patchOrg({ status: 'active', go_live_status: 'complete' });
  };

  if (!org || !tasks) return <div className="card"><div className="empty">Loading…</div></div>;
  const done = tasks.filter((t) => t.done).length;
  const pct = tasks.length ? Math.round((100 * done) / tasks.length) : 0;
  const next = tasks.find((t) => !t.done);
  const status = GO_LIVE_STATUS.find((s) => s[0] === org.go_live_status) || GO_LIVE_STATUS[0];

  return (
    <div className="card detail">
      <div className="cardhead headline">
        <h2>{org.name}</h2>
        <div className="progress">
          <div className="bar big"><i style={{ width: `${pct}%` }} /></div>
          <div className="next">{next ? <><span className="pct">{pct}%</span> · next: <b>{next.label}</b></> : <><span className="pct">100%</span> · <b>all steps complete</b></>}</div>
        </div>
        {org.status === 'onboarding' && done === tasks.length && <button className="btn-sm primary" onClick={markLive}>Mark live</button>}
      </div>

      <div className="facts">
        <div><small>Contact</small><span>{org.contact_name || '—'}</span><div className="sub2">{org.contact_email}{org.contact_phone ? ` · ${org.contact_phone}` : ''}</div></div>
        <div><small>Status</small><span>{org.status === 'active' ? 'Live' : 'Onboarding'}</span>{org.founding_account && <span className="tag founding solid">Founding account</span>}</div>
        <div>
          <small>Est. go-live date</small>
          <input type="date" className="inlinedate" value={org.go_live_date || ''} onChange={(e) => patchOrg({ go_live_date: e.target.value || null })} />
          <select className={`statusselect ${status[2]}`} value={org.go_live_status} onChange={(e) => patchOrg({ go_live_status: e.target.value })}>
            {GO_LIVE_STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div><small>Sales rep</small><span>{org.sales_rep}</span></div>
      </div>

      <div className="phases">
        {PHASES.map((p) => {
          const list = tasks.filter((t) => t.phase === p.key);
          const d = list.filter((t) => t.done).length;
          const ppct = list.length ? (100 * d) / list.length : 0;
          const complete = list.length > 0 && d === list.length;
          return (
            <button key={p.key} className={`phasetile ${openPhase === p.key ? 'open' : ''} ${complete ? 'complete' : ''}`} onClick={() => setOpenPhase(openPhase === p.key ? null : p.key)}>
              <div className="tile"><PhaseIcon kind={p.icon} /></div>
              <div className="plabel">{p.label}</div>
              <div className="pcount">{d}/{list.length}</div>
              <div className="bar"><i style={{ width: `${ppct}%` }} /></div>
            </button>
          );
        })}
      </div>

      {openPhase && (
        <div className="phase open">
          {tasks.filter((t) => t.phase === openPhase).map((t) => {
            const latest = docs.find((d) => d.task_key === t.key);
            const state = t.done ? 'done' : t.kind === 'document' && latest ? 'pending' : t.kind === 'billing' && org.billing_method ? 'done' : 'open';
            return (
              <div key={t.id} className={`task ${state}`}>
                {t.kind === 'manual'
                  ? <input type="checkbox" checked={t.done} onChange={() => toggle(t)} />
                  : <span className={`circle ${state}`} title={state === 'done' ? 'Approved' : state === 'pending' ? 'Uploaded — awaiting review' : 'Not started'}>{state === 'done' ? '✓' : state === 'pending' ? '–' : ''}</span>}
                <div>
                  <div className="lbl">{t.label}
                    {t.kind === 'document' && <UploadButton onFile={(f) => upload(t, f)} label={latest ? 'Replace PDF' : 'Upload PDF'} />}
                    {t.kind === 'billing' && <button className="btn-xs" onClick={() => setBillingOpen(true)}>{org.billing_method ? 'Change billing method' : 'Add billing method'}</button>}
                  </div>
                  {t.kind === 'document' && latest && <div className="note">{latest.status === 'approved' ? 'Approved' : latest.status === 'rejected' ? 'Rejected — upload a corrected copy' : 'Uploaded, awaiting review'} · {fmt(latest.created_at)}{latest.review_note ? ` · ${latest.review_note}` : ''}</div>}
                  {t.kind === 'billing' && org.billing_method && <div className="note">{BILLING.find((b) => b[0] === org.billing_method)?.[1]}{org.billing_details?.summary ? ` · ${org.billing_details.summary}` : ''}</div>}
                  {t.kind === 'manual' && (editing === t.id ? (
                    <input className="noteedit" autoFocus defaultValue={t.note || ''} placeholder="Add a note — who, what, when" onBlur={(e) => saveNote(t, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveNote(t, e.target.value); if (e.key === 'Escape') setEditing(null); }} />
                  ) : (
                    <div className="note">{t.note || <button className="edit" onClick={() => setEditing(t.id)}>+ note</button>}{t.note && <> · <button className="edit" onClick={() => setEditing(t.id)}>edit</button></>}</div>
                  ))}
                </div>
                <div className="when">
                  {t.kind === 'document' && latest ? <button className="viewdoc" onClick={() => viewDoc(latest)}>View document</button> : (t.done && t.done_at ? fmt(t.done_at) : '')}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {billingOpen && <BillingModal org={org} onClose={() => setBillingOpen(false)} onSaved={() => { setBillingOpen(false); load(); onChange(); }} />}
    </div>
  );
}

function UploadButton({ onFile, label }) {
  const ref = useRef(null);
  return (
    <>
      <button className="btn-xs" onClick={() => ref.current?.click()}>{label}</button>
      <input ref={ref} type="file" accept="application/pdf" style={{ display: 'none' }} onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
    </>
  );
}

function BillingModal({ org, onClose, onSaved }) {
  const [method, setMethod] = useState(org.billing_method || 'ach');
  const [summary, setSummary] = useState(org.billing_details?.summary || '');
  const [err, setErr] = useState(null);
  const save = async () => {
    const { error } = await supabase.from('orgs').update({ billing_method: method, billing_details: { summary: summary.trim() || null, set_at: new Date().toISOString() } }).eq('id', org.id);
    if (error) setErr(error.message); else onSaved();
  };
  const hint = { ach: 'e.g. Chase ·· 4821 — authorization form on file', card: 'e.g. Visa ·· 6411, exp 09/28', wire: 'e.g. remittance details sent to AP', check: 'e.g. AP contact / mailing cadence', net_terms: 'e.g. Net 15, invoice to ap@brand.com' }[method];
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>Billing method<span className="dot">.</span></h3>
        <p className="lead">How {org.name} pays their monthly statement.</p>
        <div className="options">
          {BILLING.map(([v, l, d]) => (
            <label key={v} className={`option ${method === v ? 'on' : ''}`}>
              <input type="radio" name="billing" value={v} checked={method === v} onChange={() => setMethod(v)} />
              <div><b>{l}</b><div className="small">{d}</div></div>
            </label>
          ))}
        </div>
        <div className="field" style={{ marginTop: 14 }}><label>Reference (optional — never full account or card numbers)</label><input type="text" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder={hint} /></div>
        {err && <div className="msg err">{err}</div>}
        <div className="row"><button className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary" onClick={save}>Save billing method</button></div>
      </div>
    </div>
  );
}

function StartOnboarding({ onClose, onCreated }) {
  const [leads, setLeads] = useState([]);
  const [leadId, setLeadId] = useState('');
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.from('leads').select('id, name, brand, email, source, created_at').is('org_id', null).order('created_at', { ascending: false }).limit(50)
      .then(({ data }) => setLeads((data || []).filter((l) => l.email && !/test|example\.com/i.test(l.email + l.brand + l.name))));
  }, []);

  const start = async () => {
    setBusy(true); setErr(null);
    if (leadId) {
      const { data, error } = await supabase.rpc('convert_lead', { p_lead_id: leadId });
      setBusy(false); if (error) return setErr(error.message); return onCreated(data);
    }
    if (!name.trim()) { setBusy(false); return setErr('Enter the brand name.'); }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const { data, error } = await supabase.from('orgs').insert({ name: name.trim(), slug, contact_name: contact || null, contact_email: email || null }).select('id').single();
    if (!error) await supabase.from('rate_cards').insert({ org_id: data.id, label: 'Standard (<1,000 orders/mo)' });
    setBusy(false); if (error) return setErr(error.message); onCreated(data.id);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>Start onboarding<span className="dot">.</span></h3>
        <p className="lead">Pick a website lead, or enter the brand by hand. Either way they get the full checklist.</p>
        <div className="field"><label>From a website lead</label>
          <select value={leadId} onChange={(e) => setLeadId(e.target.value)}>
            <option value="">— choose —</option>
            {leads.map((l) => <option key={l.id} value={l.id}>{l.brand || l.name} · {l.email} · {l.source || 'website'}</option>)}
          </select>
        </div>
        <div className="or">OR</div>
        <div className="field"><label>Brand name</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={!!leadId} /></div>
        <div className="field"><label>Contact name</label><input type="text" value={contact} onChange={(e) => setContact(e.target.value)} disabled={!!leadId} /></div>
        <div className="field"><label>Contact email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!!leadId} /></div>
        {err && <div className="msg err">{err}</div>}
        <div className="row"><button className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary" disabled={busy} onClick={start}>{busy ? 'Starting…' : 'Start onboarding'}</button></div>
      </div>
    </div>
  );
}
