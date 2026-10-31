// Strategies — the sales plays at a glance: what we're trying, what it costs, what it's producing. Numbers come
// straight from the leads (by channel / list); the log is where the weekly read goes.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib';
import { fetchAll, money, pct, num, ago } from './util';
import { CampaignCards, Score, Third, ChannelTable, byListRows } from './Sales';

const STATUS = [['active', 'Active', 'ok'], ['idea', 'Idea', 'muted'], ['paused', 'Paused', 'warn'], ['done', 'Done', 'navy']];

export default function Strategies({ sources: srcProp, status }) {
  const [strats, setStrats] = useState(null); const [leads, setLeads] = useState([]); const [sources, setSources] = useState(srcProp || []); const [calls, setCalls] = useState([]); const [sends, setSends] = useState([]); const [view, setView] = useState('plays');
  const [editing, setEditing] = useState(null); const [noteFor, setNoteFor] = useState(null); const [msg, setMsg] = useState(null);
  const load = async () => {
    const [s, l, so, c, e] = await Promise.all([fetchAll('sales_strategies', '*', (q) => q.order('created_at')), fetchAll('sales_leads', '*'), fetchAll('sales_sources'), fetchAll('sales_calls', 'id, lead_id, outcome, started_at'), fetchAll('sales_email_sends', 'id, lead_id, lead_email, step, variant, sent_at, replied, reply_type, bounced')]);
    setStrats(s); setLeads(l); setSources(so); setCalls(c); setSends(e);
  };
  useEffect(() => { load(); }, []);
  const say = (r, ok) => { if (r?.error) setMsg({ kind: 'err', text: r.error }); else if (ok) setMsg({ kind: 'ok', text: ok }); };

  const stats = useMemo(() => {
    const out = {};
    for (const s of strats || []) {
      const L = leads.filter((l) => (s.channel === 'mixed' || l.source === s.channel) && (!s.lists?.length || s.lists.includes(l.filter_id)));
      const ids = new Set(L.map((l) => l.id));
      const n = (st) => L.filter((l) => st.includes(l.stage)).length;
      const months = s.started ? Math.max(1, Math.ceil((Date.now() - new Date(s.started).getTime()) / (30 * 86400000))) : 1;
      const spent = Number(s.monthly_cost) * months + (sources.find((x) => x.key === s.channel)?.one_time_cost ? Number(sources.find((x) => x.key === s.channel).one_time_cost) : 0);
      const booked = n(['call_booked', 'quoted', 'signed']);
      out[s.id] = { leads: L.length, contacted: n(['contacted', 'replied', 'call_booked', 'quoted', 'signed', 'lost', 'dnc']), replied: n(['replied', 'call_booked', 'quoted', 'signed']), booked, signed: n(['signed']), dials: calls.filter((c) => ids.has(c.lead_id)).length, spent, perBooked: booked ? spent / booked : null, months };
    }
    return out;
  }, [strats, leads, sources, calls]);

  const emailBy = (key) => { const g = {}; for (const x of sends) { const k = key(x) || '—'; g[k] = g[k] || { k, sent: 0, leads: new Set(), replied: 0, pos: 0, bounced: 0 }; g[k].sent++; g[k].leads.add(x.lead_email); if (x.replied) g[k].replied++; if (x.reply_type === 'Positive') g[k].pos++; if (x.bounced) g[k].bounced++; } return Object.values(g).map((v) => ({ ...v, leads: v.leads.size })).sort((a, b) => a.k.localeCompare(b.k)); };
  const setStatus = async (s, status) => { await supabase.from('sales_strategies').update({ status }).eq('id', s.id); load(); };
  const addNote = async (s, note) => { if (!note.trim()) return; await supabase.from('sales_strategies').update({ log: [{ at: new Date().toISOString(), note: note.trim() }, ...(s.log || [])] }).eq('id', s.id); setNoteFor(null); load(); };

  if (strats === null) return <div className="card"><div className="empty">Loading…</div></div>;
  const order = { active: 0, idea: 1, paused: 2, done: 3 };
  const list = [...strats].sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  const tot = Object.values(stats).reduce((a, s) => ({ leads: a.leads + s.leads, replied: a.replied + s.replied, booked: a.booked + s.booked, signed: a.signed + s.signed, spent: a.spent + s.spent }), { leads: 0, replied: 0, booked: 0, signed: 0, spent: 0 });
  return (
    <>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}
      <div className="kpis fin">
        <div className="tile"><small>Plays running</small><b>{strats.filter((s) => s.status === 'active').length}</b><span>{strats.filter((s) => s.status === 'paused').length} paused · {strats.filter((s) => s.status === 'idea').length} ideas</span></div>
        <div className="tile"><small>Leads touched</small><b>{num(tot.leads)}</b><span>{num(tot.replied)} replied</span></div>
        <div className="tile ok"><small>Calls booked</small><b className="hot">{num(tot.booked)}</b><span>{num(tot.signed)} signed</span></div>
        <div className="tile"><small>Spent on sales</small><b>{money(tot.spent)}</b><span>{tot.booked ? `${money(tot.spent / tot.booked)} per booked call` : 'no booked calls yet'}</span></div>
      </div>
      <div className="opsbar wrap">
        <span className="seg tight">{[['plays', 'Plays'], ['email', 'Email campaign'], ['lists', 'Lists'], ['partners', 'Partners']].map(([k, l]) => <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>)}</span>
        <div className="spacer" />
        {view === 'plays' && <button className="btn-sm primary" onClick={() => setEditing({})}>+ New strategy</button>}
      </div>
      {view === 'email' && <>
        <CampaignCards status={status} say={say} reload={load} />
        <div className="ownergrid">
          <Score title="By step and variant" rows={emailBy((x) => `Step ${x.step}${x.variant ? ' · ' + x.variant : ''}`)} />
          <Score title="By list" rows={emailBy((x) => leads.find((l) => l.id === x.lead_id)?.filter_id)} />
        </div>
      </>}
      {view === 'lists' && <div className="card"><div className="cardhead"><h3>Lists</h3><span className="sm">every lead by the Storeleads filter it came from</span></div><ChannelTable rows={byListRows(leads)} mono /></div>}
      {view === 'partners' && <Third leads={leads} sources={sources} reload={load} say={say} />}
      {view === 'plays' && <div className="stratgrid">
        {list.map((s) => { const st = stats[s.id]; const S = STATUS.find((x) => x[0] === s.status); return (
          <div key={s.id} className={`card strat ${s.status}`}>
            <div className="cardhead">
              <div><h3>{s.name}</h3><div className="sm">{sources.find((x) => x.key === s.channel)?.label || (s.channel === 'mixed' ? 'All channels' : s.channel)}{s.lists?.length ? ` · lists ${s.lists.join(', ')}` : ''}{s.started ? ` · since ${new Date(s.started).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}</div></div>
              <select className={`statuspill ${S?.[2]}`} value={s.status} onChange={(e) => setStatus(s, e.target.value)}>{STATUS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            </div>
            {s.hypothesis && <p className="hyp">{s.hypothesis}</p>}
            {s.target && <p className="sm"><b>Working looks like:</b> {s.target}</p>}
            <div className="board strat">
              <div><b>{num(st.leads)}</b><small>leads</small></div>
              <div><b>{num(st.contacted)}</b><small>contacted</small></div>
              <div><b>{num(st.replied)}</b><small>replied</small></div>
              <div><b className="hot">{num(st.booked)}</b><small>booked</small></div>
              <div><b>{num(st.signed)}</b><small>signed</small></div>
              <div><b>{st.leads ? pct(st.replied / st.leads, 1) : '—'}</b><small>reply rate</small></div>
              <div><b>{money(s.monthly_cost)}</b><small>/ month</small></div>
              <div><b>{money(st.spent)}</b><small>spent</small></div>
              <div><b>{st.perBooked != null ? money(st.perBooked) : '—'}</b><small>per booked</small></div>
            </div>
            <div className="log">
              {(s.log || []).slice(0, 3).map((e, i) => <div key={i} className="entry"><span className="sm">{new Date(e.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>{e.note}</div>)}
              {noteFor === s.id ? <NoteBox onSave={(n) => addNote(s, n)} onCancel={() => setNoteFor(null)} /> : (
                <div className="row"><button className="btn-xs" onClick={() => setNoteFor(s.id)}>+ Note</button><button className="btn-xs" onClick={() => setEditing(s)}>Edit</button><div className="spacer" />{s.updated_at && <span className="sm">updated {ago(s.updated_at)}</span>}</div>
              )}
            </div>
          </div>
        ); })}
      </div>}
      {editing && <StratModal s={editing} sources={sources} lists={[...new Set(leads.map((l) => l.filter_id).filter(Boolean))].sort()} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} say={say} />}
    </>
  );
}

function NoteBox({ onSave, onCancel }) {
  const [v, setV] = useState('');
  return <div className="notebox"><textarea rows={2} autoFocus placeholder="What happened this week, what you’re changing…" value={v} onChange={(e) => setV(e.target.value)} /><div className="row"><button className="btn-xs" onClick={onCancel}>Cancel</button><div className="spacer" /><button className="btn-xs primary" onClick={() => onSave(v)}>Save note</button></div></div>;
}

function StratModal({ s, sources, lists, onClose, onSaved, say }) {
  const [f, setF] = useState({ name: '', channel: 'mixed', lists: [], status: 'active', hypothesis: '', target: '', monthly_cost: 0, started: '', notes: '', ...s });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault(); if (!f.name.trim()) return;
    const row = { name: f.name.trim(), channel: f.channel, lists: f.lists, status: f.status, hypothesis: f.hypothesis || null, target: f.target || null, monthly_cost: Number(f.monthly_cost) || 0, started: f.started || null, notes: f.notes || null };
    const r = s.id ? await supabase.from('sales_strategies').update(row).eq('id', s.id) : await supabase.from('sales_strategies').insert(row);
    if (r.error) return say({ error: r.error.message }); onSaved();
  };
  const del = async () => { if (!window.confirm(`Delete “${s.name}”?`)) return; await supabase.from('sales_strategies').delete().eq('id', s.id); onSaved(); };
  const toggleList = (code) => setF({ ...f, lists: f.lists.includes(code) ? f.lists.filter((x) => x !== code) : [...f.lists, code] });
  return (
    <div className="overlay" onClick={onClose}><form className="modal wide" onClick={(e) => e.stopPropagation()} onSubmit={save}>
      <h3>{s.id ? 'Edit strategy' : 'New strategy'}</h3>
      <div className="addgrid lead">
        <label className="wide">Name<input value={f.name} onChange={set('name')} autoFocus /></label>
        <label>Channel<select value={f.channel} onChange={set('channel')}><option value="mixed">All channels</option>{sources.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></label>
        <label>Status<select value={f.status} onChange={set('status')}>{STATUS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="wide2">Who we’re going after and why it should work<input value={f.hypothesis || ''} onChange={set('hypothesis')} /></label>
        <label className="wide">What “working” looks like<input value={f.target || ''} onChange={set('target')} placeholder="e.g. 2 booked calls / week" /></label>
        <label>$ / month<input type="number" step="1" value={f.monthly_cost} onChange={set('monthly_cost')} /></label>
        <label>Started<input type="date" value={f.started || ''} onChange={set('started')} /></label>
        <div className="wide2"><div className="sm" style={{ fontWeight: 600, marginBottom: 4 }}>Lists (leave empty for the whole channel)</div><div className="chips">{lists.map((c) => <button type="button" key={c} className={`chip ${f.lists.includes(c) ? 'on' : ''}`} onClick={() => toggleList(c)}>{c}</button>)}</div></div>
        <label className="wide2">Notes<textarea rows={2} value={f.notes || ''} onChange={set('notes')} /></label>
      </div>
      <div className="row">{s.id && <button type="button" className="btn-xs" onClick={del}>Delete</button>}<div className="spacer" /><button type="button" className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary">Save</button></div>
    </form></div>
  );
}
