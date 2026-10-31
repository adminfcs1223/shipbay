// Sales — every lead from every channel in one place (Master), the cold-email machine (Email), the dialer (Calls),
// and partner / 3rd-party leads (Third party). All rows live in sales_* tables, owner-only.
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib';
import { ownerFn, fetchAll, money, pct, num, ago, mmss, hhmm, STAGES, stageLabel, stageClass, parseCsv, guessColumns } from './util';

const SUB = [['master', 'Master leads'], ['email', 'Email'], ['calls', 'Calls'], ['third', 'Third party']];

export default function Sales({ me, status, refreshStatus }) {
  const [sub, setSub] = useState('master');
  const [leads, setLeads] = useState(null); const [sources, setSources] = useState([]);
  const [msg, setMsg] = useState(null);
  const load = async () => {
    const [l, s] = await Promise.all([fetchAll('sales_leads', '*', (q) => q.order('created_at', { ascending: false })), fetchAll('sales_sources')]);
    setLeads(l); setSources(s);
  };
  useEffect(() => { load(); }, []);
  const say = (r, ok) => { if (r?.error) setMsg({ kind: 'err', text: r.error }); else if (ok) setMsg({ kind: 'ok', text: ok }); };
  const counts = useMemo(() => { const c = { total: 0 }; for (const l of leads || []) { c.total++; c[l.stage] = (c[l.stage] || 0) + 1; } return c; }, [leads]);

  if (leads === null) return <div className="card"><div className="empty">Loading leads…</div></div>;
  return (
    <>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}
      <div className="kpis fin">
        <div className="tile"><small>All leads</small><b>{num(counts.total)}</b><span>{num(counts.new || 0)} untouched</span></div>
        <div className="tile"><small>Contacted</small><b>{num(counts.contacted || 0)}</b><span>emailed or dialed</span></div>
        <div className="tile warn"><small>Replied</small><b className="hot">{num(counts.replied || 0)}</b><span>answer them first</span></div>
        <div className="tile ok"><small>Calls booked</small><b>{num(counts.call_booked || 0)}</b><span>{num(counts.quoted || 0)} quoted</span></div>
        <div className="tile ok"><small>Signed</small><b>{num(counts.signed || 0)}</b><span>{num(counts.lost || 0)} lost · {num(counts.dnc || 0)} do-not-contact</span></div>
      </div>
      <div className="card ownertabs"><div className="tabs">{SUB.map(([k, l]) => <button key={k} className={sub === k ? 'on' : ''} onClick={() => setSub(k)}>{l}{k === 'email' && counts.replied ? <i>{counts.replied}</i> : null}</button>)}</div></div>
      {sub === 'master' && <Master leads={leads} sources={sources} reload={load} say={say} />}
      {sub === 'email' && <Email leads={leads} status={status} reload={load} refreshStatus={refreshStatus} say={say} />}
      {sub === 'calls' && <Calls me={me} leads={leads} reload={load} say={say} />}
      {sub === 'third' && <Third leads={leads} sources={sources} reload={load} say={say} />}
    </>
  );
}

const srcLabel = (sources, k) => sources.find((s) => s.key === k)?.label || k;
const lists = (leads) => [...new Set(leads.map((l) => l.filter_id).filter(Boolean))].sort();

/* =================== Master =================== */
function Master({ leads, sources, reload, say }) {
  const [q, setQ] = useState(''); const [src, setSrc] = useState(''); const [stage, setStage] = useState(''); const [list, setList] = useState(''); const [phoneOnly, setPhoneOnly] = useState(false);
  const [open, setOpen] = useState(null); const [adding, setAdding] = useState(false); const [importing, setImporting] = useState(false);
  const rows = useMemo(() => leads.filter((l) => (!src || l.source === src) && (!stage || l.stage === stage) && (!list || l.filter_id === list) && (!phoneOnly || l.phone)
    && (!q || [l.company, l.domain, l.contact_name, l.email, l.phone, l.city, l.state, l.notes].filter(Boolean).some((s) => s.toLowerCase().includes(q.toLowerCase())))), [leads, q, src, stage, list, phoneOnly]);
  const order = { replied: 0, call_booked: 1, quoted: 2, contacted: 3, new: 4, signed: 5, lost: 6, dnc: 7 };
  const sorted = useMemo(() => [...rows].sort((a, b) => (order[a.stage] ?? 9) - (order[b.stage] ?? 9) || (b.last_touch_at || '').localeCompare(a.last_touch_at || '') || (b.est_sales_usd || 0) - (a.est_sales_usd || 0)), [rows]);
  return (
    <>
      <div className="opsbar wrap">
        <input className="search" placeholder="Search company, email, phone, city…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={src} onChange={(e) => setSrc(e.target.value)}><option value="">All channels</option>{sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
        <select value={stage} onChange={(e) => setStage(e.target.value)}><option value="">All stages</option>{STAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <select value={list} onChange={(e) => setList(e.target.value)}><option value="">All lists</option>{lists(leads).map((f) => <option key={f}>{f}</option>)}</select>
        <label className="chk sm"><input type="checkbox" checked={phoneOnly} onChange={(e) => setPhoneOnly(e.target.checked)} /> has phone</label>
        <div className="spacer" />
        <button className="btn-sm" onClick={() => setImporting(true)}>Import CSV</button>
        <button className="btn-sm primary" onClick={() => setAdding(true)}>+ Add lead</button>
      </div>
      <div className="card">
        <div className="tablewrap"><table className="ordertable leads">
          <thead><tr><th>Company</th><th>Contact</th><th>Phone</th><th>Where</th><th className="n">Est. sales / mo</th><th>Channel · list</th><th>Stage</th><th className="n">Tries</th><th>Last touch</th></tr></thead>
          <tbody>{sorted.slice(0, 400).map((l) => (
            <tr key={l.id} className="click" onClick={() => setOpen(l)}>
              <td><b>{l.company || l.domain || l.email}</b>{l.domain && <div className="sm">{l.domain}</div>}</td>
              <td>{l.contact_name}{l.email && <div className="sm">{l.email}</div>}</td>
              <td className="mono sm">{l.phone}</td>
              <td className="sm">{[l.city, l.state].filter(Boolean).join(', ')}</td>
              <td className="n">{l.est_sales_usd ? money(l.est_sales_usd) : '—'}</td>
              <td className="sm">{srcLabel(sources, l.source)}{l.filter_id && <div className="sm mono">{l.filter_id}</div>}</td>
              <td><span className={`statuspill ${stageClass(l.stage)}`}>{stageLabel(l.stage)}</span></td>
              <td className="n">{l.attempts || 0}</td>
              <td className="sm">{ago(l.last_touch_at)}{l.last_outcome && <div className="sm">{l.last_outcome.replace('_', ' ')}</div>}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <div className="sm" style={{ padding: '8px 2px' }}>Showing {Math.min(400, sorted.length)} of {sorted.length} · replies and booked calls float to the top.</div>
      </div>
      {open && <LeadDrawer lead={leads.find((x) => x.id === open.id) || open} sources={sources} onClose={() => setOpen(null)} reload={reload} say={say} />}
      {adding && <LeadForm sources={sources} onClose={() => setAdding(false)} reload={reload} say={say} />}
      {importing && <ImportCsv sources={sources} onClose={() => setImporting(false)} reload={reload} say={say} />}
    </>
  );
}

/* ---------- one lead: edit, history ---------- */
function LeadDrawer({ lead, sources, onClose, reload, say }) {
  const [f, setF] = useState(lead); const [calls, setCalls] = useState([]); const [sends, setSends] = useState([]); const [busy, setBusy] = useState(false);
  useEffect(() => { setF(lead); }, [lead.id]);
  useEffect(() => { (async () => {
    const [c, s] = await Promise.all([supabase.from('sales_calls').select('*').eq('lead_id', lead.id).order('started_at', { ascending: false }), supabase.from('sales_email_sends').select('*').eq('lead_id', lead.id).order('sent_at', { ascending: false })]);
    setCalls(c.data || []); setSends(s.data || []);
  })(); }, [lead.id]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    const patch = { company: f.company, domain: f.domain, contact_name: f.contact_name, email: f.email, phone: f.phone, title: f.title, city: f.city, state: f.state, est_sales_usd: f.est_sales_usd ? Number(f.est_sales_usd) : null, stage: f.stage, source: f.source, filter_id: f.filter_id, notes: f.notes, next_action_at: f.next_action_at ? new Date(f.next_action_at).toISOString() : null, in_calls: f.in_calls, in_email: f.in_email };
    const { error } = await supabase.from('sales_leads').update(patch).eq('id', lead.id); setBusy(false);
    if (error) return say({ error: error.message }); say(null, 'Saved.'); reload();
  };
  const del = async () => { if (!window.confirm(`Delete ${lead.company || lead.email}? Call and email history stays but loses its link.`)) return; await supabase.from('sales_leads').delete().eq('id', lead.id); reload(); onClose(); };
  return (
    <div className="overlay" onClick={onClose}><div className="modal wide drawer" onClick={(e) => e.stopPropagation()}>
      <div className="opsbar"><h3 style={{ margin: 0 }}>{lead.company || lead.email}</h3><div className="spacer" />{lead.phone && <a className="btn-sm" href={`tel:${lead.phone.replace(/[^+\d]/g, '')}`}>Call {lead.phone}</a>}{lead.domain && <a className="btn-sm" href={`https://${lead.domain}`} target="_blank" rel="noreferrer">Site ↗</a>}<button className="btn-sm" onClick={onClose}>Close</button></div>
      <div className="addgrid lead">
        <label>Stage<select value={f.stage} onChange={set('stage')}>{STAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>Channel<select value={f.source} onChange={set('source')}>{sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
        <label>List / filter<input value={f.filter_id || ''} onChange={set('filter_id')} /></label>
        <label>Next action<input type="datetime-local" value={toLocalInput(f.next_action_at)} onChange={set('next_action_at')} /></label>
        <label>Company<input value={f.company || ''} onChange={set('company')} /></label>
        <label>Domain<input value={f.domain || ''} onChange={set('domain')} /></label>
        <label>Contact<input value={f.contact_name || ''} onChange={set('contact_name')} /></label>
        <label>Title<input value={f.title || ''} onChange={set('title')} /></label>
        <label>Email<input value={f.email || ''} onChange={set('email')} /></label>
        <label>Phone<input value={f.phone || ''} onChange={set('phone')} /></label>
        <label>City<input value={f.city || ''} onChange={set('city')} /></label>
        <label>State<input value={f.state || ''} onChange={set('state')} /></label>
        <label>Est. sales $/mo<input type="number" value={f.est_sales_usd || ''} onChange={set('est_sales_usd')} /></label>
        <label className="chk"><input type="checkbox" checked={!!f.in_calls} onChange={(e) => setF({ ...f, in_calls: e.target.checked })} /> in the call queue</label>
        <label className="chk"><input type="checkbox" checked={!!f.in_email} onChange={(e) => setF({ ...f, in_email: e.target.checked })} /> in email campaign</label>
        <label className="wide2">Notes<textarea rows={3} value={f.notes || ''} onChange={set('notes')} /></label>
      </div>
      <div className="row"><button className="btn-xs" onClick={del}>Delete</button><div className="spacer" /><span className="sm">{lead.products ? `${lead.products} products · ` : ''}{lead.plan || ''}{lead.rank ? ` · rank ${num(lead.rank)}` : ''}{lead.categories ? ` · ${lead.categories}` : ''}</span><button className="btn-sm primary" disabled={busy} onClick={save}>Save</button></div>
      {(calls.length > 0 || sends.length > 0) && (
        <div className="history">
          {calls.length > 0 && <><h4>Calls</h4><ul>{calls.map((c) => <li key={c.id}><b>{c.outcome.replace('_', ' ')}</b> · {new Date(c.started_at).toLocaleString()} · {mmss(c.seconds)}{c.note && <> — {c.note}</>}</li>)}</ul></>}
          {sends.length > 0 && <><h4>Emails</h4><ul>{sends.map((s) => <li key={s.id}>Step {s.step}{s.variant ? ` ${s.variant}` : ''} · {new Date(s.sent_at).toLocaleDateString()} · {s.subject}{s.replied && <b> · replied{s.reply_type ? ` (${s.reply_type})` : ''}</b>}{s.bounced && <b className="neg"> · bounced</b>}</li>)}</ul></>}
        </div>
      )}
    </div></div>
  );
}

/* ---------- add one lead (also used by Third party with a fixed source) ---------- */
export function LeadForm({ sources, onClose, reload, say, fixedSource, title = 'Add a lead' }) {
  const [f, setF] = useState({ source: fixedSource || 'other', filter_id: '', company: '', domain: '', contact_name: '', email: '', phone: '', title: '', city: '', state: '', est_sales_usd: '', notes: '', in_calls: true });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault(); if (!f.company && !f.email && !f.domain) return say({ error: 'Give at least a company, email or domain.' }); setBusy(true);
    const row = { ...f, est_sales_usd: f.est_sales_usd ? Number(f.est_sales_usd) : null, domain: cleanDomain(f.domain), filter_id: f.filter_id || null };
    const { error } = await supabase.from('sales_leads').insert(row); setBusy(false);
    if (error) return say({ error: /duplicate/i.test(error.message) ? 'That domain or email is already in the list.' : error.message });
    say(null, 'Lead added.'); reload(); onClose();
  };
  return (
    <div className="overlay" onClick={onClose}><form className="modal wide" onClick={(e) => e.stopPropagation()} onSubmit={save}>
      <h3>{title}</h3>
      <div className="addgrid lead">
        {!fixedSource && <label>Channel<select value={f.source} onChange={set('source')}>{sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>}
        <label>List / partner name<input value={f.filter_id} onChange={set('filter_id')} placeholder="e.g. Fulfill.com Nov" /></label>
        <label>Company<input value={f.company} onChange={set('company')} autoFocus /></label>
        <label>Domain<input value={f.domain} onChange={set('domain')} placeholder="brand.com" /></label>
        <label>Contact<input value={f.contact_name} onChange={set('contact_name')} /></label>
        <label>Title<input value={f.title} onChange={set('title')} /></label>
        <label>Email<input value={f.email} onChange={set('email')} /></label>
        <label>Phone<input value={f.phone} onChange={set('phone')} /></label>
        <label>City<input value={f.city} onChange={set('city')} /></label>
        <label>State<input value={f.state} onChange={set('state')} /></label>
        <label>Est. sales $/mo<input type="number" value={f.est_sales_usd} onChange={set('est_sales_usd')} /></label>
        <label className="chk"><input type="checkbox" checked={f.in_calls} onChange={(e) => setF({ ...f, in_calls: e.target.checked })} /> put in the call queue</label>
        <label className="wide2">Notes<textarea rows={2} value={f.notes} onChange={set('notes')} /></label>
      </div>
      <div className="row"><button type="button" className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary" disabled={busy}>Add</button></div>
    </form></div>
  );
}
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return ''; return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const cleanDomain = (d) => (d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null;

/* ---------- CSV import ---------- */
function ImportCsv({ sources, onClose, reload, say }) {
  const [parsed, setParsed] = useState(null); const [map, setMap] = useState({}); const [source, setSource] = useState('other'); const [list, setList] = useState(''); const [inCalls, setInCalls] = useState(true);
  const [prog, setProg] = useState(null); const fileRef = useRef();
  const onFile = async (file) => { const text = await file.text(); const p = parseCsv(text); setParsed(p); setMap(guessColumns(p.headers)); if (!list) setList(file.name.replace(/\.csv$/i, '')); };
  const run = async () => {
    const rows = parsed.rows.map((r) => {
      const g = (k) => (map[k] ? r[map[k]] : '');
      const sales = g('est_sales_usd').replace(/[^0-9.]/g, '');
      return { source, filter_id: list || null, company: g('company') || null, domain: cleanDomain(g('domain')), contact_name: g('contact_name') || null, email: g('email').toLowerCase() || null, phone: g('phone') || null, title: g('title') || null, city: g('city') || null, state: g('state') || null, est_sales_usd: sales ? Math.round(Number(sales)) : null, products: g('products') ? Number(g('products')) || null : null, categories: g('categories') || null, notes: g('notes') || null, in_calls: inCalls };
    }).filter((r) => r.company || r.domain || r.email);
    let ok = 0, dup = 0, bad = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error } = await supabase.from('sales_leads').insert(chunk);
      if (!error) ok += chunk.length;
      else for (const r of chunk) { const { error: e2 } = await supabase.from('sales_leads').insert(r); if (!e2) ok++; else if (/duplicate/i.test(e2.message)) dup++; else bad++; }
      setProg({ done: Math.min(i + 200, rows.length), total: rows.length, ok, dup, bad });
    }
    say(null, `Imported ${ok} leads${dup ? `, ${dup} already there` : ''}${bad ? `, ${bad} failed` : ''}.`); reload(); onClose();
  };
  const FIELDS = [['company', 'Company'], ['domain', 'Domain / website'], ['contact_name', 'Contact name'], ['email', 'Email'], ['phone', 'Phone'], ['title', 'Title'], ['city', 'City'], ['state', 'State'], ['est_sales_usd', 'Est. sales'], ['products', 'Products'], ['categories', 'Categories'], ['notes', 'Notes']];
  return (
    <div className="overlay" onClick={onClose}><div className="modal wide" onClick={(e) => e.stopPropagation()}>
      <h3>Import leads from a CSV</h3>
      <p className="lead">Any CSV — Storeleads export, a partner’s list, Apollo. Duplicates (same domain or email) are skipped, so re-importing is safe.</p>
      {!parsed ? (
        <div className="drop" onClick={() => fileRef.current.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}>
          <b>Drop a CSV here or click to choose</b><span>First row must be the column names.</span>
          <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => e.target.files[0] && onFile(e.target.files[0])} />
        </div>
      ) : (
        <>
          <div className="addgrid lead">
            <label>Channel<select value={source} onChange={(e) => setSource(e.target.value)}>{sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
            <label>List name<input value={list} onChange={(e) => setList(e.target.value)} /></label>
            <label className="chk"><input type="checkbox" checked={inCalls} onChange={(e) => setInCalls(e.target.checked)} /> put in the call queue</label>
          </div>
          <div className="mapgrid">{FIELDS.map(([k, l]) => <label key={k}><span>{l}</span><select value={map[k] || ''} onChange={(e) => setMap({ ...map, [k]: e.target.value })}><option value="">— skip —</option>{parsed.headers.map((h) => <option key={h}>{h}</option>)}</select></label>)}</div>
          <p className="note">{parsed.rows.length} rows found. First one: <code>{Object.values(parsed.rows[0] || {}).slice(0, 5).join(' · ')}</code></p>
          {prog && <div className="bar"><i style={{ width: `${(prog.done / prog.total) * 100}%` }} /></div>}
          <div className="row"><button className="btn-sm" onClick={() => setParsed(null)}>Different file</button><div className="spacer" /><button className="btn-sm primary" disabled={!!prog} onClick={run}>{prog ? `${prog.done} / ${prog.total}…` : `Import ${parsed.rows.length} leads`}</button></div>
        </>
      )}
    </div></div>
  );
}

/* =================== Email =================== */
function Email({ leads, status, reload, refreshStatus, say }) {
  const [sends, setSends] = useState(null); const [busy, setBusy] = useState(false); const [view, setView] = useState('replies');
  const load = async () => setSends(await fetchAll('sales_email_sends', '*', (q) => q.order('sent_at', { ascending: false })));
  useEffect(() => { load(); }, []);
  const sync = async () => { setBusy(true); const r = await ownerFn({ action: 'smartlead_sync' }); setBusy(false); say(r, r.error ? null : `Smartlead synced: ${JSON.stringify(r.out || r).slice(0, 160)}`); load(); reload(); refreshStatus(); };
  const setReply = async (s, reply_type) => { await supabase.from('sales_email_sends').update({ reply_type }).eq('id', s.id); if (s.lead_id && reply_type === 'Negative') await supabase.from('sales_leads').update({ stage: 'dnc' }).eq('id', s.lead_id).eq('stage', 'replied'); load(); reload(); };
  const m = useMemo(() => {
    const S = sends || []; const emails = new Set(S.map((s) => s.lead_email));
    const replied = S.filter((s) => s.replied); const repliedLeads = new Set(replied.map((s) => s.lead_email));
    const by = (key) => { const g = {}; for (const s of S) { const k = key(s) || '—'; g[k] = g[k] || { sent: 0, leads: new Set(), replied: 0, pos: 0, bounced: 0 }; g[k].sent++; g[k].leads.add(s.lead_email); if (s.replied) g[k].replied++; if (s.reply_type === 'Positive') g[k].pos++; if (s.bounced) g[k].bounced++; } return Object.entries(g).map(([k, v]) => ({ k, ...v, leads: v.leads.size })).sort((a, b) => a.k.localeCompare(b.k)); };
    return { sent: S.length, leads: emails.size, replied: replied.length, repliedLeads: repliedLeads.size, pos: S.filter((s) => s.reply_type === 'Positive').length, bounced: S.filter((s) => s.bounced).length, byStep: by((s) => `Step ${s.step}${s.variant ? ' · ' + s.variant : ''}`), byList: by((s) => leads.find((l) => l.id === s.lead_id)?.filter_id), replies: replied };
  }, [sends, leads]);
  if (sends === null) return <div className="card"><div className="empty">Loading…</div></div>;
  return (
    <>
      <div className="opsbar">
        <div><b>Smartlead campaign{status.smartlead_campaigns?.includes(',') ? 's' : ''} {status.smartlead_campaigns || '—'}</b><div className="sm">Last sync {ago(status.smartlead_last_sync?.at)}. Opens aren’t shown — email scanners fake them; replies are the only honest number.</div></div>
        <div className="spacer" />
        <button className="btn-sm primary" disabled={busy || !status.smartlead_key_set} onClick={sync}>{busy ? 'Syncing…' : 'Sync from Smartlead'}</button>
      </div>
      <div className="kpis fin">
        <div className="tile"><small>Emails sent</small><b>{num(m.sent)}</b><span>to {num(m.leads)} people</span></div>
        <div className="tile"><small>Reply rate</small><b>{pct(m.repliedLeads / (m.leads || 1), 1)}</b><span>{num(m.repliedLeads)} people replied</span></div>
        <div className="tile ok"><small>Positive</small><b className="hot">{num(m.pos)}</b><span>{pct(m.pos / (m.leads || 1), 1)} of people — the number that matters</span></div>
        <div className="tile"><small>Bounced</small><b>{num(m.bounced)}</b><span>{pct(m.bounced / (m.sent || 1), 1)} · under 3% keeps the domains healthy</span></div>
      </div>
      <div className="seg">{[['replies', `Replies (${m.replied})`], ['score', 'Scoreboard'], ['all', 'All sends']].map(([k, l]) => <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>)}</div>
      {view === 'replies' && (
        <div className="card">
          <p className="hint">Tag each reply. Positive = interested or asked a question. Negative = not interested / stop (sets the lead to do-not-contact). Auto-reply and Bounce-back don’t count against you.</p>
          <div className="tablewrap"><table className="ordertable leads">
            <thead><tr><th>When</th><th>Who</th><th>Step</th><th>Subject</th><th>Reply type</th><th>Lead stage</th></tr></thead>
            <tbody>{m.replies.map((s) => { const l = leads.find((x) => x.id === s.lead_id); return (
              <tr key={s.id}><td className="sm">{new Date(s.sent_at).toLocaleDateString()}</td><td><b>{s.lead_name || l?.company || s.lead_email}</b><div className="sm">{s.lead_email}</div></td><td className="sm">{s.step}{s.variant ? ` ${s.variant}` : ''}</td><td className="sm">{s.subject}</td>
                <td><select className="statusselect" value={s.reply_type || ''} onChange={(e) => setReply(s, e.target.value)}><option value="">— tag —</option>{['Positive', 'Neutral', 'Negative', 'Auto-reply', 'Bounce-back'].map((t) => <option key={t}>{t}</option>)}</select></td>
                <td>{l ? <span className={`statuspill ${stageClass(l.stage)}`}>{stageLabel(l.stage)}</span> : '—'}</td></tr>
            ); })}</tbody>
          </table></div>
        </div>
      )}
      {view === 'score' && (
        <div className="ownergrid">
          <Score title="By step and variant" rows={m.byStep} />
          <Score title="By list (which Storeleads filter the lead came from)" rows={m.byList} />
        </div>
      )}
      {view === 'all' && (
        <div className="card"><div className="tablewrap"><table className="ordertable leads">
          <thead><tr><th>Sent</th><th>To</th><th>Step</th><th>Subject</th><th>Status</th></tr></thead>
          <tbody>{sends.slice(0, 500).map((s) => <tr key={s.id}><td className="sm">{new Date(s.sent_at).toLocaleString()}</td><td>{s.lead_name || s.lead_email}<div className="sm">{s.lead_email}</div></td><td className="sm">{s.step}{s.variant ? ` ${s.variant}` : ''}</td><td className="sm">{s.subject}</td><td>{s.bounced ? <span className="statuspill bad">bounced</span> : s.replied ? <span className="statuspill ok">replied{s.reply_type ? ` · ${s.reply_type}` : ''}</span> : <span className="statuspill muted">sent</span>}</td></tr>)}</tbody>
        </table></div></div>
      )}
    </>
  );
}
function Score({ title, rows }) {
  return (
    <div className="card"><h3>{title}</h3>
      <table className="ordertable fin"><thead><tr><th /><th className="n">Sent</th><th className="n">People</th><th className="n">Replied</th><th className="n">Reply %</th><th className="n">Positive</th><th className="n">Bounced</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.k}><td><b>{r.k}</b></td><td className="n">{num(r.sent)}</td><td className="n">{num(r.leads)}</td><td className="n">{num(r.replied)}</td><td className="n">{pct(r.replied / (r.leads || 1), 1)}</td><td className="n">{num(r.pos)}</td><td className="n">{num(r.bounced)}</td></tr>)}</tbody></table>
    </div>
  );
}

/* =================== Calls =================== */
const OUTCOMES = [['no_answer', 'No answer', ''], ['voicemail', 'Voicemail', ''], ['gatekeeper', 'Gatekeeper', 'warn'], ['connected', 'Connected', 'ok'], ['booked', 'Booked a call', 'ok solid'], ['not_fit', 'Not a fit', 'bad'], ['wrong_number', 'Wrong number', 'bad'], ['dnc', 'Do not call', 'bad']];
const PICKUP = new Set(['gatekeeper', 'connected', 'booked', 'not_fit']); const CONNECT = new Set(['connected', 'booked', 'not_fit']);
const grade = (bookedPer100, dials) => (dials < 30 ? '—' : bookedPer100 >= 3 ? 'A' : bookedPer100 >= 1.5 ? 'B' : bookedPer100 >= 0.5 ? 'C' : 'D');

function Calls({ me, leads, reload, say }) {
  const [list, setList] = useState(''); const [calls, setCalls] = useState([]); const [sessions, setSessions] = useState([]);
  const [session, setSession] = useState(() => { try { return JSON.parse(sessionStorage.getItem('shipbay-call-session') || 'null'); } catch { return null; } });
  const [cur, setCur] = useState(null); const [callStart, setCallStart] = useState(null); const [note, setNote] = useState(''); const [tick, setTick] = useState(0); const [skipped, setSkipped] = useState([]);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const loadCalls = async () => { const [c, s] = await Promise.all([fetchAll('sales_calls', '*', (q) => q.order('started_at', { ascending: false })), fetchAll('sales_call_sessions', '*', (q) => q.order('started_at', { ascending: false }))]); setCalls(c); setSessions(s); };
  useEffect(() => { loadCalls(); }, []);

  const queue = useMemo(() => {
    const now = Date.now();
    return leads.filter((l) => l.in_calls && l.phone && !['dnc', 'lost', 'signed'].includes(l.stage) && (!list || l.filter_id === list) && !skipped.includes(l.id) && (!l.next_action_at || new Date(l.next_action_at).getTime() <= now))
      .sort((a, b) => (a.stage === 'replied' ? -1 : 0) - (b.stage === 'replied' ? -1 : 0) || (a.attempts || 0) - (b.attempts || 0) || (b.est_sales_usd || 0) - (a.est_sales_usd || 0));
  }, [leads, list, skipped]);
  const lead = cur ? leads.find((l) => l.id === cur) : queue[0];

  const startSession = async () => { const { data } = await supabase.from('sales_call_sessions').insert({ started_at: new Date().toISOString(), by_user: me.id, note: list || null }).select().single(); const s = { id: data.id, started_at: data.started_at }; setSession(s); sessionStorage.setItem('shipbay-call-session', JSON.stringify(s)); };
  const endSession = async () => { const secs = Math.round((Date.now() - new Date(session.started_at)) / 1000); await supabase.from('sales_call_sessions').update({ ended_at: new Date().toISOString(), seconds: secs }).eq('id', session.id); setSession(null); sessionStorage.removeItem('shipbay-call-session'); if (callStart) setCallStart(null); loadCalls(); };
  const startCall = () => { if (!session) startSession(); setCallStart(Date.now()); };
  const finish = async (outcome) => {
    if (!lead) return;
    const started = callStart || Date.now(); const secs = Math.round((Date.now() - started) / 1000);
    await supabase.from('sales_calls').insert({ lead_id: lead.id, started_at: new Date(started).toISOString(), ended_at: new Date().toISOString(), seconds: secs, outcome, note: note || null, by_user: me.id });
    const next = { no_answer: 2, voicemail: 3, gatekeeper: 1, connected: 7 }[outcome];
    const patch = { attempts: (lead.attempts || 0) + 1, last_outcome: outcome, last_touch_at: new Date().toISOString(), next_action_at: next ? new Date(Date.now() + next * 86400000).toISOString() : null };
    if (outcome === 'booked') patch.stage = 'call_booked'; else if (outcome === 'dnc') patch.stage = 'dnc'; else if (outcome === 'not_fit') patch.stage = 'lost';
    else if (outcome === 'wrong_number') { patch.in_calls = false; patch.tags = [...new Set([...(lead.tags || []), 'bad_number'])]; }
    else if (lead.stage === 'new') patch.stage = 'contacted';
    if (note) patch.notes = [lead.notes, `${new Date().toLocaleDateString()} ${outcome.replace('_', ' ')}: ${note}`].filter(Boolean).join('\n');
    if ((lead.attempts || 0) + 1 >= 4 && !['booked', 'connected', 'gatekeeper'].includes(outcome)) patch.in_calls = false;   // 4 tries with no human → park it
    await supabase.from('sales_leads').update(patch).eq('id', lead.id);
    setCallStart(null); setNote(''); setCur(null); reload(); loadCalls();
  };
  const skip = () => { if (lead) setSkipped([...skipped, lead.id]); setCur(null); setCallStart(null); };

  const board = useMemo(() => {
    const today = new Date().toDateString();
    const stat = (C) => { const dials = C.length; const pick = C.filter((c) => PICKUP.has(c.outcome)).length; const conn = C.filter((c) => CONNECT.has(c.outcome)).length; const booked = C.filter((c) => c.outcome === 'booked').length; const bad = C.filter((c) => c.outcome === 'wrong_number').length; const talk = C.filter((c) => CONNECT.has(c.outcome)).reduce((s, c) => s + c.seconds, 0); const per100 = dials ? (booked / dials) * 100 : 0; return { dials, pick, conn, booked, bad, talk, pickRate: dials ? pick / dials : 0, connRate: dials ? conn / dials : 0, per100, grade: grade(per100, dials), minPerConn: conn ? talk / 60 / conn : 0 }; };
    const todayCalls = calls.filter((c) => new Date(c.started_at).toDateString() === today);
    const byList = {}; for (const c of calls) { const k = leads.find((l) => l.id === c.lead_id)?.filter_id || '—'; (byList[k] = byList[k] || []).push(c); }
    const sessTime = (S) => S.reduce((s, x) => s + (x.seconds || (x.ended_at ? 0 : Math.round((Date.now() - new Date(x.started_at)) / 1000))), 0);
    return { today: stat(todayCalls), all: stat(calls), byList: Object.entries(byList).map(([k, C]) => ({ k, ...stat(C) })).sort((a, b) => b.dials - a.dials), timeToday: sessTime(sessions.filter((s) => new Date(s.started_at).toDateString() === today)), timeAll: sessTime(sessions) };
  }, [calls, sessions, leads, tick]);

  const sessSecs = session ? Math.round((Date.now() - new Date(session.started_at)) / 1000) : 0;
  const callSecs = callStart ? Math.round((Date.now() - callStart) / 1000) : 0;
  return (
    <>
      <div className="opsbar wrap">
        <select value={list} onChange={(e) => { setList(e.target.value); setCur(null); }}><option value="">All lists ({queue.length} ready)</option>{lists(leads).map((f) => <option key={f} value={f}>{f}</option>)}</select>
        <div className="spacer" />
        {session ? <><span className="mono">Session {hhmm(sessSecs)} {mmss(sessSecs % 60)}</span><button className="btn-sm" onClick={endSession}>End session</button></> : <button className="btn-sm primary" onClick={startSession}>Start session</button>}
      </div>
      <div className="callgrid">
        <div className="card dialer">
          {!lead ? <div className="empty">Queue is empty for this list. Import more leads or clear the filter.</div> : (
            <>
              <div className="who"><small>{lead.filter_id || srcLabelPlain(lead.source)} · try #{(lead.attempts || 0) + 1}{lead.stage === 'replied' && <span className="statuspill warn" style={{ marginLeft: 8 }}>replied to email</span>}</small>
                <h2>{lead.company || lead.domain}</h2>
                <a className="phone" href={`tel:${lead.phone.replace(/[^+\d]/g, '')}`}>{lead.phone}</a>
                <div className="sm">{[lead.contact_name, lead.city, lead.state].filter(Boolean).join(' · ')}{lead.est_sales_usd ? ` · ~${money(lead.est_sales_usd)}/mo online` : ''}{lead.products ? ` · ${lead.products} products` : ''}{lead.plan ? ` · ${lead.plan}` : ''}</div>
                {lead.domain && <a className="sm" href={`https://${lead.domain}`} target="_blank" rel="noreferrer">{lead.domain} ↗</a>}
                {lead.notes && <pre className="notes">{lead.notes}</pre>}
              </div>
              <div className="timer">{callStart ? <><b>{mmss(callSecs)}</b><span>on the call</span></> : <button className="btn primary big" onClick={startCall}>Start call</button>}</div>
              <textarea className="callnote" rows={2} placeholder="One line: who you spoke to, what they said, when to call back…" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="outcomes">{OUTCOMES.map(([k, l, cls]) => <button key={k} className={`oc ${cls}`} onClick={() => finish(k)}>{l}</button>)}</div>
              <div className="row"><button className="btn-xs" onClick={skip}>Skip for now</button><div className="spacer" /><span className="sm">Next up: {queue.filter((q) => q.id !== lead.id).slice(0, 3).map((q) => q.company).join(' · ') || '—'}</span></div>
            </>
          )}
        </div>
        <div className="scorecol">
          <div className="card"><h3>Today</h3><Board s={board.today} time={board.timeToday} /></div>
          <div className="card"><h3>All time</h3><Board s={board.all} time={board.timeAll} /></div>
        </div>
      </div>
      <div className="card">
        <h3>Which lists are worth dialing</h3>
        <p className="hint">Grade = booked calls per 100 dials: A ≥ 3, B 1.5–3, C 0.5–1.5, D below. No grade until 30 dials — before that it’s noise. High bad-number % means the list’s phone data is weak.</p>
        <table className="ordertable fin"><thead><tr><th>List</th><th className="n">Dials</th><th className="n">Pick-up</th><th className="n">Connect</th><th className="n">Booked</th><th className="n">Booked / 100</th><th className="n">Bad numbers</th><th className="n">Min / connect</th><th>Grade</th></tr></thead>
          <tbody>{board.byList.map((r) => <tr key={r.k}><td><b className="mono">{r.k}</b></td><td className="n">{r.dials}</td><td className="n">{pct(r.pickRate)}</td><td className="n">{pct(r.connRate)}</td><td className="n">{r.booked}</td><td className="n">{r.per100.toFixed(1)}</td><td className="n">{pct(r.dials ? r.bad / r.dials : 0)}</td><td className="n">{r.minPerConn.toFixed(1)}</td><td><b className={`grade g${r.grade}`}>{r.grade}</b></td></tr>)}
            {!board.byList.length && <tr><td colSpan={9} className="empty">No calls logged yet.</td></tr>}</tbody></table>
      </div>
    </>
  );
}
const srcLabelPlain = (k) => ({ cold_call: 'Cold call list', cold_email: 'Cold email', fulfill_com: 'Fulfill.com', fulfilment_com: 'fulfilment.com', agency: 'Agency', referral: 'Referral', inbound: 'Inbound', linkedin: 'LinkedIn' }[k] || 'Other');
function Board({ s, time }) {
  return (
    <div className="board">
      <div><b>{s.dials}</b><small>dials</small></div>
      <div><b>{pct(s.pickRate)}</b><small>pick-up</small></div>
      <div><b>{pct(s.connRate)}</b><small>connect</small></div>
      <div><b className="hot">{s.booked}</b><small>booked</small></div>
      <div><b>{s.per100.toFixed(1)}</b><small>booked / 100</small></div>
      <div><b className={`grade g${s.grade}`}>{s.grade}</b><small>grade</small></div>
      <div><b>{hhmm(time)}</b><small>time in sessions</small></div>
      <div><b>{s.minPerConn.toFixed(1)}</b><small>min / connect</small></div>
      <div><b>{pct(s.dials ? s.bad / s.dials : 0)}</b><small>bad numbers</small></div>
    </div>
  );
}

/* =================== Third party =================== */
function Third({ leads, sources, reload, say }) {
  const [adding, setAdding] = useState(null); const [edit, setEdit] = useState(null);
  const partner = sources.filter((s) => !['cold_email', 'cold_call'].includes(s.key));
  const stats = (k) => { const L = leads.filter((l) => l.source === k); return { n: L.length, replied: L.filter((l) => ['replied', 'call_booked', 'quoted'].includes(l.stage)).length, signed: L.filter((l) => l.stage === 'signed').length }; };
  const saveSrc = async (s) => { const { error } = await supabase.from('sales_sources').update({ monthly_cost: Number(s.monthly_cost) || 0, one_time_cost: Number(s.one_time_cost) || 0, per_lead_cost: Number(s.per_lead_cost) || 0, rev_share: Number(s.rev_share) || 0, integration_status: s.integration_status, notes: s.notes }).eq('key', s.key); if (error) return say({ error: error.message }); setEdit(null); reload(); };
  const addSrc = async () => { const label = window.prompt('Name of the new lead source (e.g. "Shopify partner directory"):'); if (!label) return; const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40); const { error } = await supabase.from('sales_sources').insert({ key, label }); if (error) return say({ error: error.message }); reload(); };
  const monthsRunning = (k) => ({ fulfill_com: 1, cold_email: 2 }[k] || 1);
  return (
    <>
      <p className="hint">Leads that come from somewhere other than your own cold email and cold calls: Fulfill.com introductions, fulfilment.com, the agency, referrals, inbound. Add them here so every channel is judged by the same numbers — cost per lead, cost per signed client. Integrations plug in later; until then it’s this form or a CSV import on Master leads.</p>
      <div className="card"><div className="tablewrap"><table className="ordertable fin">
        <thead><tr><th>Source</th><th className="n">Leads</th><th className="n">Replied / booked</th><th className="n">Signed</th><th className="n">$ / month</th><th className="n">One-time</th><th className="n">Per lead</th><th className="n">Rev share</th><th className="n">Spent so far</th><th className="n">$ per lead</th><th>Integration</th><th /></tr></thead>
        <tbody>{partner.map((s) => { const st = stats(s.key); const spent = Number(s.one_time_cost) + Number(s.monthly_cost) * monthsRunning(s.key) + Number(s.per_lead_cost) * st.n; return edit?.key === s.key ? (
          <tr key={s.key} className="hl"><td><b>{s.label}</b></td><td className="n">{st.n}</td><td className="n">{st.replied}</td><td className="n">{st.signed}</td>
            <td><input className="cellnum" type="number" value={edit.monthly_cost} onChange={(e) => setEdit({ ...edit, monthly_cost: e.target.value })} /></td>
            <td><input className="cellnum" type="number" value={edit.one_time_cost} onChange={(e) => setEdit({ ...edit, one_time_cost: e.target.value })} /></td>
            <td><input className="cellnum" type="number" value={edit.per_lead_cost} onChange={(e) => setEdit({ ...edit, per_lead_cost: e.target.value })} /></td>
            <td><input className="cellnum" type="number" step="0.01" value={edit.rev_share} onChange={(e) => setEdit({ ...edit, rev_share: e.target.value })} /></td>
            <td className="n">—</td><td className="n">—</td>
            <td><select className="statusselect" value={edit.integration_status} onChange={(e) => setEdit({ ...edit, integration_status: e.target.value })}>{['none', 'planned', 'connected'].map((x) => <option key={x}>{x}</option>)}</select></td>
            <td className="n" style={{ whiteSpace: 'nowrap' }}><button className="btn-xs primary" onClick={() => saveSrc(edit)}>Save</button> <button className="btn-xs" onClick={() => setEdit(null)}>Cancel</button></td></tr>
        ) : (
          <tr key={s.key}><td><b>{s.label}</b>{s.notes && <div className="sm">{s.notes}</div>}</td><td className="n">{st.n}</td><td className="n">{st.replied}</td><td className="n">{st.signed}</td><td className="n">{money(s.monthly_cost)}</td><td className="n">{money(s.one_time_cost)}</td><td className="n">{money(s.per_lead_cost)}</td><td className="n">{pct(s.rev_share)}</td><td className="n">{money(spent)}</td><td className="n">{st.n ? money(spent / st.n) : '—'}</td>
            <td><span className={`pill ${s.integration_status === 'connected' ? 'connected' : s.integration_status === 'planned' ? 'pending' : ''}`}>{s.integration_status}</span></td>
            <td className="n" style={{ whiteSpace: 'nowrap' }}><button className="btn-xs primary" onClick={() => setAdding(s.key)}>+ Lead</button> <button className="btn-xs" onClick={() => setEdit({ ...s })}>Costs</button></td></tr>
        ); })}</tbody>
      </table></div>
      <div className="row"><button className="btn-xs" onClick={addSrc}>+ New source</button></div></div>
      <div className="card">
        <h3>Recent third-party leads</h3>
        <table className="ordertable leads"><thead><tr><th>Company</th><th>Contact</th><th>Source</th><th>Stage</th><th>Added</th></tr></thead>
          <tbody>{leads.filter((l) => !['cold_email', 'cold_call'].includes(l.source)).slice(0, 50).map((l) => <tr key={l.id}><td><b>{l.company || l.domain}</b></td><td>{l.contact_name}<div className="sm">{l.email}{l.phone ? ` · ${l.phone}` : ''}</div></td><td className="sm">{srcLabel(sources, l.source)}{l.filter_id ? ` · ${l.filter_id}` : ''}</td><td><span className={`statuspill ${stageClass(l.stage)}`}>{stageLabel(l.stage)}</span></td><td className="sm">{new Date(l.created_at).toLocaleDateString()}</td></tr>)}
            {!leads.some((l) => !['cold_email', 'cold_call'].includes(l.source)) && <tr><td colSpan={5} className="empty">None yet — when Fulfill.com sends the first introduction, add it with “+ Lead”.</td></tr>}</tbody></table>
      </div>
      {adding && <LeadForm sources={sources} fixedSource={adding} title={`Add a lead from ${srcLabel(sources, adding)}`} onClose={() => setAdding(null)} reload={reload} say={say} />}
    </>
  );
}
