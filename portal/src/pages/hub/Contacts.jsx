// Contacts / Companies / Activities index — HubSpot's record table: views, filter pills, column table, bulk bar, pager,
// and the "Create contact" panel that slides in from the right.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib';
import { money, num, ago, STAGES, stageLabel } from '../owner/util';
import { findExisting, srcLabelPlain, listName, expectedMonthly } from '../owner/Sales';
import { HS_URL, initialsOf, avColor } from './Hub';

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '--');
const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '--');
const LIFE = (s) => (s === 'signed' ? 'Customer' : ['quoted', 'call_booked'].includes(s) ? 'Opportunity' : s === 'replied' ? 'Sales qualified lead' : 'Lead');
const PER = 25;

export default function Contacts({ me, rep, kind, data, people, sources, reload, say, openLead, goTab, hs, autoCreate = false }) {
  const { leads, allLeads, calls, touches, mail, meetings, sends, quotes, orgs } = data;
  const [view, setView] = useState('all'); const [owner, setOwner] = useState(''); const [stage, setStage] = useState(''); const [src, setSrc] = useState(''); const [created, setCreated] = useState(''); const [q, setQ] = useState(''); const [page, setPage] = useState(1); const [sel, setSel] = useState(() => new Set()); const [creating, setCreating] = useState(autoCreate); const [sort, setSort] = useState(['last', 'desc']);
  const who = (id) => { const p = people.find((x) => x.id === id); return p ? (p.full_name || p.email) : ''; };
  // last activity per lead (calls, notes, emails, meetings, replies)
  const lastAct = useMemo(() => { const m = {}; const bump = (id, at) => { if (id && at && (!m[id] || at > m[id])) m[id] = at; }; calls.forEach((c) => bump(c.lead_id, c.started_at)); touches.forEach((t) => bump(t.lead_id, t.at)); mail.forEach((x) => bump(x.lead_id, x.at)); meetings.forEach((x) => bump(x.lead_id, x.starts_at)); sends.forEach((s) => s.replied && bump(s.lead_id, s.reply_at)); leads.forEach((l) => bump(l.id, l.last_touch_at)); return m; }, [calls, touches, mail, meetings, sends, leads]);
  const base = kind === 'company' ? leads.filter((l) => l.company || l.domain) : leads;
  const views = kind === 'company'
    ? [['all', 'All companies'], ['mine', 'My companies'], ['clients', 'Clients'], ['open', 'Open deals']]
    : [['all', 'All contacts'], ['mine', 'My contacts'], ['unassigned', 'Unassigned'], ['replied', 'Replied'], ['booked', 'Calls booked'], ['clients', 'Customers']];
  const rows = useMemo(() => {
    const since = created === '7' ? Date.now() - 7 * 864e5 : created === '30' ? Date.now() - 30 * 864e5 : created === '90' ? Date.now() - 90 * 864e5 : 0;
    const t = q.trim().toLowerCase();
    const out = base.filter((l) => {
      if (view === 'mine' && l.assigned_to !== me.id) return false; if (view === 'unassigned' && l.assigned_to) return false;
      if (view === 'replied' && l.stage !== 'replied') return false; if (view === 'booked' && l.stage !== 'call_booked') return false; if (view === 'clients' && l.stage !== 'signed') return false; if (view === 'open' && !['replied', 'call_booked', 'quoted'].includes(l.stage)) return false;
      if (owner && (owner === 'none' ? l.assigned_to : l.assigned_to !== owner)) return false; if (stage && l.stage !== stage) return false; if (src && l.source !== src) return false;
      if (since && new Date(l.created_at).getTime() < since) return false;
      if (t && ![l.company, l.domain, l.contact_name, l.email, l.phone, l.city].filter(Boolean).some((v) => v.toLowerCase().includes(t))) return false;
      return true;
    });
    const [k, dir] = sort; const d = dir === 'asc' ? 1 : -1;
    const key = (l) => (k === 'name' ? (kind === 'company' ? l.company || l.domain || '' : l.contact_name || l.company || l.email || '').toLowerCase() : k === 'created' ? l.created_at : k === 'last' ? lastAct[l.id] || '' : k === 'stage' ? STAGES.findIndex((s) => s[0] === l.stage) : k === 'value' ? expectedMonthly(l, quotes).value || 0 : '');
    return out.sort((a, b) => (key(a) > key(b) ? d : key(a) < key(b) ? -d : 0));
  }, [base, view, owner, stage, src, created, q, sort, lastAct, me.id, kind, quotes]);
  useEffect(() => { setPage(1); }, [view, owner, stage, src, created, q]);
  const pages = Math.max(1, Math.ceil(rows.length / PER)); const slice = rows.slice((page - 1) * PER, page * PER);
  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allOn = slice.length > 0 && slice.every((l) => sel.has(l.id));
  const bulk = async (patch, ok) => { const { error } = await supabase.from('sales_leads').update(patch).in('id', [...sel]); say(error ? { error: error.message } : null, ok); setSel(new Set()); reload(); };
  const merge = async () => { const ids = [...sel]; if (ids.length < 2) return; const keep = rows.find((l) => sel.has(l.id))?.id; if (!confirm(`Merge ${ids.length} records into one? Calls, emails, quotes and notes move to the kept record.`)) return; const { error } = await supabase.rpc('merge_leads', { p_keep: keep, p_drop: ids.filter((i) => i !== keep) }); say(error ? { error: error.message } : null, 'Merged.'); setSel(new Set()); reload(); };
  const th = (k, label, cls = '') => <th className={`${cls} ${sort[0] === k ? 'sorted' : ''}`} onClick={() => setSort([k, sort[0] === k && sort[1] === 'desc' ? 'asc' : 'desc'])}>{label}{sort[0] === k ? <i>{sort[1] === 'desc' ? '▾' : '▴'}</i> : null}</th>;

  if (kind === 'activity') return <Activities data={data} people={people} openLead={openLead} />;
  return (
    <div className="hub-page">
      <div className="hub-sheet">
      <div className="hub-head">
        <div className="hub-title"><h1>{kind === 'company' ? 'Companies' : 'Contacts'}</h1><i>⌄</i></div>
        <div className="acts">
          <button className="hub-kebab" title="More">⋮</button>
          <button className="hs-btn primary" onClick={() => setCreating(true)}>Add {kind === 'company' ? 'companies' : 'contacts'} <i>▾</i></button>
        </div>
      </div>
      <div className="hub-views">{views.map(([k, l]) => <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 10h18M9 4v16"/></svg>{l}</button>)}<button className="add" title="Add view">+</button></div>
      <div className="hub-toolbar">
        <label className="hub-tsearch"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input placeholder="Search ( / )" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <button className={`hub-pillbtn mint ${owner || stage || src || created ? 'on' : ''}`} onClick={() => { setOwner(''); setStage(''); setSrc(''); setCreated(''); }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>Filter{owner || stage || src || created ? ' · clear' : ''}</button>
        <button className="hub-pillbtn" onClick={() => setSort([sort[0], sort[1] === 'desc' ? 'asc' : 'desc'])}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h10M4 12h7M4 17h4M17 5v14M14 16l3 3 3-3"/></svg>Sort by</button>
        <div className="spacer" />
        {hs?.portal_id && <a className="hub-pillbtn" href={`https://app.hubspot.com/contacts/${hs.portal_id}/objects/${kind === 'company' ? '0-2' : '0-1'}/views/all/list`} target="_blank" rel="noreferrer">Open in HubSpot ↗</a>}
        <button className="hub-iconbtn" title="Table" ><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="5" width="18" height="3" rx="1"/><rect x="3" y="10.5" width="18" height="3" rx="1"/><rect x="3" y="16" width="18" height="3" rx="1"/></svg></button>
        <button className="hub-iconbtn" title="Edit columns">⚙</button>
      </div>
      <div className="hub-chips">
        <select className="chip" value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">{kind === 'company' ? 'Company' : 'Contact'} owner</option><option value="none">Unassigned</option>{people.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}</select>
        <select className="chip" value={created} onChange={(e) => setCreated(e.target.value)}><option value="">Create date</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select>
        <select className="chip" value={sort[0] === 'last' ? '' : ''} onChange={() => {}}><option value="">Last activity date</option></select>
        <select className="chip" value={stage} onChange={(e) => setStage(e.target.value)}><option value="">Lead status</option>{STAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <select className="chip" value={src} onChange={(e) => setSrc(e.target.value)}><option value="">Original source</option>{sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
        <button className="hub-roundbtn" title="Add filter">+</button><button className="hub-roundbtn" title="Edit filters">✎</button>
        <button className="linkish adv"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>Advanced filters</button>
      </div>
      <div className="hub-card flat">
        {sel.size > 0 && <div className="hub-bulk"><b>{sel.size} selected</b>
          {!rep && <select className="pill" defaultValue="" onChange={(e) => e.target.value && bulk({ assigned_to: e.target.value === 'none' ? null : e.target.value }, 'Owner updated.')}><option value="" disabled>Assign owner</option><option value="none">Unassigned</option>{people.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}</select>}
          <select className="pill" defaultValue="" onChange={(e) => e.target.value && bulk({ stage: e.target.value, last_touch_at: new Date().toISOString(), ...(rep ? { assigned_to: me.id } : {}) }, 'Lead status updated.')}><option value="" disabled>Set lead status</option>{STAGES.filter((s) => s[0] !== 'signed').map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          {sel.size > 1 && <button className="hs-btn ghost sm" onClick={merge}>Merge</button>}
          <button className="linkish" onClick={() => setSel(new Set())}>Cancel</button></div>}
        <div className="hub-tablewrap"><table className="hub-table">
          <thead><tr><th className="chk"><input type="checkbox" checked={allOn} onChange={() => setSel((s) => { const n = new Set(s); slice.forEach((l) => (allOn ? n.delete(l.id) : n.add(l.id))); return n; })} /></th><th className="exp"></th>
            {th('name', kind === 'company' ? 'Company name' : 'Name', 'sticky')}
            {kind === 'company' ? <>{<th>Company domain name</th>}<th>Phone number</th><th>City</th>{th('value', 'Expected $/mo')}</> : <><th>Email</th><th>Phone number</th><th>Primary company</th></>}
            <th>{kind === 'company' ? 'Company' : 'Contact'} owner</th>{th('last', 'Last Activity Date')}{th('stage', 'Lead Status')}<th>Lifecycle Stage</th><th>Original Source</th>{th('created', 'Create Date')}</tr></thead>
          <tbody>
            {slice.map((l) => { const name = kind === 'company' ? (l.company || l.domain || l.email) : (l.contact_name || l.company || l.email); const exp = expectedMonthly(l, quotes); return (
              <tr key={l.id} className={sel.has(l.id) ? 'sel' : ''}>
                <td className="chk"><input type="checkbox" checked={sel.has(l.id)} onChange={() => toggle(l.id)} /></td><td className="exp"><button className="hub-exp" onClick={() => openLead(l)}>›</button></td>
                <td className="sticky name"><button className="hub-link nm" onClick={() => openLead(l)}><span className={`hub-av ${kind === 'company' ? 'sq' : ''}`} style={{ background: avColor(name) }}>{kind === 'company' ? (l.domain ? <img src={`https://www.google.com/s2/favicons?domain=${l.domain}&sz=64`} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} /> : initialsOf(name)) : initialsOf(name)}</span><span>{name}</span></button></td>
                {kind === 'company' ? <><td>{l.domain ? <a className="hub-link" href={`https://${l.domain}`} target="_blank" rel="noreferrer">{l.domain}</a> : '--'}</td><td>{l.phone || '--'}</td><td>{[l.city, l.state].filter(Boolean).join(', ') || '--'}</td><td>{exp.value ? money(exp.value) : '--'}</td></>
                  : <><td>{l.email ? <a className="hub-link" href={`mailto:${l.email}`}>{l.email} <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6M20 4l-9 9M19 14v6H4V5h6"/></svg></a> : '--'}</td><td>{l.phone || '--'}</td><td>{l.company ? <button className="hub-link" onClick={() => openLead(l)}>{l.company}</button> : '--'}</td></>}
                <td>{l.assigned_to ? <span className="hub-owner"><span className="hub-av xs" style={{ background: avColor(who(l.assigned_to)) }}>{initialsOf(who(l.assigned_to))}</span>{who(l.assigned_to)}{people.find((p) => p.id === l.assigned_to)?.email ? ` (${people.find((p) => p.id === l.assigned_to).email.split('@')[0]}…)` : ''}</span> : <span className="muted">No owner</span>}</td>
                <td>{fmtDT(lastAct[l.id])}</td>
                <td>{stageLabel(l.stage)}</td>
                <td><span className={`hub-life l-${LIFE(l.stage).split(' ')[0].toLowerCase()}`}>{LIFE(l.stage)}</span></td>
                <td>{srcLabelPlain(l.source)}{l.filter_id ? <span className="muted"> · {l.filter_id}</span> : ''}</td>
                <td>{fmtDate(l.created_at)}</td>
              </tr>); })}
            {slice.length === 0 && <tr><td colSpan={12} className="hub-none">No records match these filters.</td></tr>}
          </tbody>
        </table></div>
        <div className="hub-pager"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</button>{Array.from({ length: Math.min(pages, 7) }, (_, i) => { const p = pages <= 7 ? i + 1 : Math.max(1, Math.min(pages - 6, page - 3)) + i; return <button key={p} className={p === page ? 'on' : ''} onClick={() => setPage(p)}>{p}</button>; })}<button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next ›</button><span className="spacer" /><span className="muted">{PER} per page</span></div>
      </div>
      <div className="hub-foot"><span className="hub-count">{num(rows.length)} {kind === 'company' ? 'companies' : 'contacts'}</span><span className="spacer" /><button className="hub-pillbtn" onClick={() => goTab('master')}>Import</button><button className="hub-pillbtn">Export</button><button className="hub-pillbtn">Clone</button></div>
      </div>
      {creating && <CreatePanel kind={kind} me={me} rep={rep} people={people} sources={sources} onClose={() => setCreating(false)} reload={reload} say={say} openLead={openLead} />}
    </div>
  );
}

/** HubSpot's right-hand "Create contact" panel */
export function CreatePanel({ kind = 'contact', me, rep, people, sources, onClose, reload, say, openLead, defaults = {} }) {
  const [f, setF] = useState({ email: '', first: '', last: '', company: '', domain: '', phone: '', title: '', stage: 'new', source: 'other', assigned_to: rep ? me.id : me.id, ...defaults });
  const [busy, setBusy] = useState(false); const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (again) => {
    const name = [f.first, f.last].filter(Boolean).join(' '); if (!f.email && !name && !f.company && !f.domain) return say({ error: 'Give at least an email, a name or a company.' });
    setBusy(true); const domain = f.domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase() || null;
    const dup = await findExisting({ email: f.email, domain, company: f.company });
    if (dup) { setBusy(false); if (confirm('This company or email is already in the CRM. Open the existing record instead?')) { onClose(); openLead(dup); } return; }
    const { data, error } = await supabase.from('sales_leads').insert({ email: f.email || null, contact_name: name || null, company: f.company || (domain ? domain.split('.')[0] : null) || name || f.email, domain, phone: f.phone || null, title: f.title || null, stage: f.stage, source: f.source, assigned_to: f.assigned_to || null, last_touch_at: f.stage === 'new' ? null : new Date().toISOString(), in_calls: true }).select('id').single();
    setBusy(false); if (error) return say({ error: error.message });
    say(null, `${kind === 'company' ? 'Company' : 'Contact'} created.`); reload();
    if (again) setF({ ...f, email: '', first: '', last: '', phone: '', title: '' }); else { onClose(); openLead(data.id); }
  };
  return (
    <div className="hub-panelback" onClick={onClose}><div className="hub-panel" onClick={(e) => e.stopPropagation()}>
      <div className="hub-panelhead"><h2>Create {kind}</h2><button onClick={onClose} aria-label="Close">×</button></div>
      <div className="hub-panelbody">
        {kind === 'company' ? <>
          <label>Company domain name<input autoFocus value={f.domain} onChange={set('domain')} placeholder="brand.com" /></label>
          <label>Company name<input value={f.company} onChange={set('company')} /></label>
          <label>Phone number<input value={f.phone} onChange={set('phone')} /></label>
          <div className="two"><label>Contact first name<input value={f.first} onChange={set('first')} /></label><label>Last name<input value={f.last} onChange={set('last')} /></label></div>
          <label>Contact email<input type="email" value={f.email} onChange={set('email')} /></label>
        </> : <>
          <label>Email<input autoFocus type="email" value={f.email} onChange={set('email')} /></label>
          <div className="two"><label>First name<input value={f.first} onChange={set('first')} /></label><label>Last name<input value={f.last} onChange={set('last')} /></label></div>
          <label>Phone number<input value={f.phone} onChange={set('phone')} /></label>
          <label>Job title<input value={f.title} onChange={set('title')} /></label>
          <div className="two"><label>Company name<input value={f.company} onChange={set('company')} /></label><label>Company domain<input value={f.domain} onChange={set('domain')} placeholder="brand.com" /></label></div>
        </>}
        <div className="two">
          <label>{kind === 'company' ? 'Company' : 'Contact'} owner<select value={f.assigned_to || ''} onChange={set('assigned_to')} disabled={rep}><option value="">Unassigned</option>{people.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}</select></label>
          <label>Lead status<select value={f.stage} onChange={set('stage')}>{STAGES.filter((s) => s[0] !== 'signed').map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        </div>
        <label>Original source<select value={f.source} onChange={set('source')}>{sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
        <p className="hub-hint">Lifecycle stage follows the lead status. The record syncs to HubSpot on the next pass (a few minutes at most).</p>
      </div>
      <div className="hub-panelfoot"><button className="hs-btn primary" disabled={busy} onClick={() => save(false)}>Create</button><button className="hs-btn ghost" disabled={busy} onClick={() => save(true)}>Create and add another</button><button className="linkish" onClick={onClose}>Cancel</button></div>
    </div></div>
  );
}

/** every activity across the accounts you can see, newest first */
function Activities({ data, people, openLead }) {
  const { leads, calls, touches, mail, meetings, sends } = data; const [kind, setKind] = useState(''); const [page, setPage] = useState(1);
  const byId = useMemo(() => Object.fromEntries(leads.map((l) => [l.id, l])), [leads]);
  const who = (id) => { const p = people.find((x) => x.id === id); return p ? (p.full_name || p.email).split(' ')[0] : ''; };
  const rows = useMemo(() => [
    ...calls.filter((c) => byId[c.lead_id]).map((c) => ({ id: `c${c.id}`, at: c.started_at, kind: 'Call', lead: byId[c.lead_id], by: who(c.by_user), text: `${c.outcome.replace('_', ' ')}${c.note ? ` — ${c.note}` : ''}` })),
    ...touches.filter((t) => byId[t.lead_id]).map((t) => ({ id: `t${t.id}`, at: t.at, kind: t.kind === 'email_sent' ? 'Email' : t.kind === 'meeting_note' ? 'Meeting' : 'Note', lead: byId[t.lead_id], by: who(t.by_user), text: t.note || '' })),
    ...mail.filter((m) => byId[m.lead_id]).map((m) => ({ id: `m${m.id}`, at: m.at, kind: 'Email', lead: byId[m.lead_id], by: m.is_sent ? who(m.user_id) : (m.from_name || m.from_email), text: m.subject || '' })),
    ...meetings.filter((m) => byId[m.lead_id]).map((m) => ({ id: `g${m.id}`, at: m.starts_at, kind: 'Meeting', lead: byId[m.lead_id], by: who(m.assigned_to), text: m.name || 'Meeting' })),
    ...sends.filter((s) => s.replied && byId[s.lead_id] && !s.mailbox).map((s) => ({ id: `s${s.id}`, at: s.reply_at || s.sent_at, kind: 'Email', lead: byId[s.lead_id], by: s.lead_name || s.lead_email, text: `Replied: ${s.reply_subject || s.subject || ''}` })),
  ].filter((r) => !kind || r.kind === kind).sort((a, b) => (b.at || '').localeCompare(a.at || '')), [calls, touches, mail, meetings, sends, byId, kind]);
  const pages = Math.max(1, Math.ceil(rows.length / 50)); const slice = rows.slice((page - 1) * 50, page * 50);
  return (
    <div className="hub-page">
      <div className="hub-head"><div><h1>Activities</h1><small>{num(rows.length)} activities</small></div></div>
      <div className="hub-views">{[['', 'All'], ['Call', 'Calls'], ['Email', 'Emails'], ['Note', 'Notes'], ['Meeting', 'Meetings']].map(([k, l]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => { setKind(k); setPage(1); }}>{l}</button>)}</div>
      <div className="hub-card"><div className="hub-tablewrap"><table className="hub-table">
        <thead><tr><th>Activity</th><th>Contact</th><th>Company</th><th>By</th><th>Date</th><th>Details</th></tr></thead>
        <tbody>{slice.map((r) => <tr key={r.id}><td><span className={`hub-kind k-${r.kind.toLowerCase()}`}>{r.kind}</span></td><td><button className="hub-link" onClick={() => openLead(r.lead)}>{r.lead.contact_name || r.lead.email || '--'}</button></td><td>{r.lead.company || '--'}</td><td>{r.by || '--'}</td><td>{fmtDT(r.at)}</td><td className="ellip">{r.text}</td></tr>)}{slice.length === 0 && <tr><td colSpan={6} className="hub-none">Nothing logged yet.</td></tr>}</tbody>
      </table></div>
      <div className="hub-pager"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</button><span className="muted">{page} / {pages}</span><button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next ›</button></div></div>
    </div>
  );
}
