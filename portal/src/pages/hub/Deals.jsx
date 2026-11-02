// Deals — HubSpot's board: one column per pipeline stage with the stage total on top, cards you drag between stages,
// and a table view. A deal is an account whose lead status is past New.
import { useMemo, useState } from 'react';
import { supabase } from '../../lib';
import { money, num, ago, stageLabel } from '../owner/util';
import { expectedMonthly, winLead } from '../owner/Sales';
import { HS_URL, initialsOf, avColor } from './Hub';
import { CreatePanel } from './Contacts';

const COLS = [['contacted', 'Contacted', '#0091ae', .1], ['replied', 'Replied', '#e8710a', .25], ['call_booked', 'Call booked', '#7c3aed', .4], ['quoted', 'Quoted', '#b8860b', .6], ['signed', 'Closed Won', '#00875a', 1], ['lost', 'Closed Lost', '#c0392b', 0]];
const fmtD = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '--');

export default function Deals({ me, rep, data, people, sources, reload, say, openLead, goTab, hs, quotes }) {
  const { leads } = data; const [mode, setMode] = useState('board'); const [owner, setOwner] = useState(''); const [q, setQ] = useState(''); const [drag, setDrag] = useState(null); const [over, setOver] = useState(null); const [creating, setCreating] = useState(false); const [sort, setSort] = useState('value');
  const val = (l) => expectedMonthly(l, quotes).value || 0;
  const who = (id) => { const p = people.find((x) => x.id === id); return p ? (p.full_name || p.email) : ''; };
  const pool = useMemo(() => { const t = q.trim().toLowerCase(); return leads.filter((l) => COLS.some(([k]) => k === l.stage) && (!owner || (owner === 'none' ? !l.assigned_to : l.assigned_to === owner)) && (!t || [l.company, l.contact_name, l.email, l.domain].filter(Boolean).some((v) => v.toLowerCase().includes(t)))); }, [leads, owner, q]);
  const sorter = { value: (a, b) => val(b) - val(a), recent: (a, b) => (b.last_touch_at || '').localeCompare(a.last_touch_at || ''), name: (a, b) => (a.company || '').localeCompare(b.company || '') }[sort];
  const col = (k) => pool.filter((l) => l.stage === k).sort(sorter);
  const move = async (l, stage) => {
    if (!l || l.stage === stage) return;
    if (stage === 'signed') { if (await winLead(l, quotes, say)) reload(); return; }
    const patch = { stage, last_touch_at: new Date().toISOString(), assigned_to: l.assigned_to || me.id };
    if (stage === 'lost') { const r = window.prompt('Closed lost — reason? (optional)', l.lost_reason || ''); if (r === null) return; patch.lost_reason = r || null; }
    const { error } = await supabase.from('sales_leads').update(patch).eq('id', l.id); if (error) return say({ error: error.message }); reload();
  };
  const openTotal = ['contacted', 'replied', 'call_booked', 'quoted'].flatMap(col).reduce((a, l) => a + val(l), 0); const wonTotal = col('signed').reduce((a, l) => a + val(l), 0);
  const days = (l) => Math.max(0, Math.round((Date.now() - new Date(l.last_touch_at || l.created_at).getTime()) / 864e5));
  return (
    <div className="hub-page">
      <div className="hub-sheet">
      <div className="hub-head">
        <div className="hub-title"><h1>Deals</h1><i>⌄</i></div>
        <div className="acts"><button className="hub-kebab" title="More">⋮</button><button className="hs-btn primary" onClick={() => setCreating(true)}>Add deals <i>▾</i></button></div>
      </div>
      <div className="hub-views">{[['all', 'All deals'], ['follow', 'Suggested follow-ups'], ['mine', 'My deals']].map(([k, l]) => <button key={k} className={(k === 'mine' ? owner === me.id : k === 'all' ? !owner : false) ? 'on' : ''} onClick={() => setOwner(k === 'mine' ? me.id : '')}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 10h18M9 4v16"/></svg>{l}</button>)}<button className="add">+</button></div>
      <div className="hub-toolbar">
        <label className="hub-tsearch"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input placeholder="Search ( / )" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <button className="hub-pillbtn mint"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>Filter</button>
        <select className="hub-pillbtn sel" value={sort} onChange={(e) => setSort(e.target.value)}><option value="value">Sort by: amount</option><option value="recent">Sort by: last activity</option><option value="name">Sort by: name</option></select>
        <div className="spacer" />
        <span className="hub-pillbtn sel static">ShipBay Sales Pipeline ▾</span>
        <div className="hub-toggle"><button className={mode === 'board' ? 'on' : ''} title="Board view" onClick={() => setMode('board')}><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="13" rx="1"/></svg></button><button className={mode === 'table' ? 'on' : ''} title="Table view" onClick={() => setMode('table')}><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="5" width="18" height="3" rx="1"/><rect x="3" y="10.5" width="18" height="3" rx="1"/><rect x="3" y="16" width="18" height="3" rx="1"/></svg></button></div>
        {hs?.portal_id && <a className="hub-iconbtn" title="Open in HubSpot" href={`https://app.hubspot.com/contacts/${hs.portal_id}/objects/0-3/views/all/board${hs.pipeline_id ? `?pipeline=${hs.pipeline_id}` : ''}`} target="_blank" rel="noreferrer">↗</a>}
        <button className="hub-iconbtn">⚙</button>
      </div>
      <div className="hub-chips">
        <select className="chip" value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">Deal owner</option><option value="none">Unassigned</option>{people.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}</select>
        <select className="chip"><option>Create date</option></select><select className="chip"><option>Last activity date</option></select><select className="chip"><option>Close date</option></select>
        <button className="hub-roundbtn">+</button><button className="hub-roundbtn">✎</button><button className="linkish adv">Advanced filters</button>
      </div>
      <div className="hub-card flat">
        {mode === 'board' ? (
          <div className="hub-board">
            {COLS.map(([k, label, color, prob]) => { const items = col(k); const tot = items.reduce((a, l) => a + val(l) * 12, 0); return (
              <div key={k} className={`hub-col ${over === k ? 'over' : ''} ${k}`} onDragOver={(e) => { e.preventDefault(); setOver(k); }} onDragLeave={() => setOver(null)} onDrop={() => { setOver(null); move(drag, k); setDrag(null); }}>
                <div className="hub-colhead"><span className="hub-stagetag" style={{ background: color }}>{label}</span><span className="cnt">{items.length}</span></div>
                <div className="hub-cards">
                  {items.map((l) => <div key={l.id} className="hub-dealcard" draggable onDragStart={() => setDrag(l)} onDragEnd={() => setDrag(null)}>
                    <button className="hub-link title" onClick={() => openLead(l)}>{l.company || l.email} — fulfillment</button>
                    <div className="meta"><span>Create date: {fmtD(l.created_at)}</span><span>Deal owner: {who(l.assigned_to) || 'No owner'}</span><span>Amount: {val(l) ? `${money(val(l))}/mo` : '--'}</span></div>
                    <div className="hub-dealsep" />
                    <div className="hub-dealcontact"><span className="hub-av xs ring" style={{ background: avColor(l.contact_name || l.company) }}>{initialsOf(l.contact_name || l.company || l.email)}</span>{l.contact_name && <button className="hub-link" onClick={() => openLead(l)}>{l.contact_name}</button>}</div>
                    <div className="hub-dealsep" />
                    <div className="foot"><span className={`hub-agechip ${days(l) > 14 ? 'warn' : ''}`}>⏱ {days(l) === 0 ? 'today' : `${days(l)} day${days(l) === 1 ? '' : 's'} ago`}</span><span className="spacer" /><span className="hub-cardicons">✉ ☰</span></div>
                  </div>)}
                </div>
                <div className="hub-colfoot"><b>{money(tot)}</b> | Total amount<br /><b>{money(tot * prob)}</b> ({Math.round(prob * 100)}%) | Weighted amount</div>
              </div>); })}
          </div>
        ) : (
          <div className="hub-tablewrap"><table className="hub-table">
            <thead><tr><th>Deal name</th><th>Deal stage</th><th>Amount / mo</th><th>Annual</th><th>Close date</th><th>Deal owner</th><th>Company</th><th>Last activity</th></tr></thead>
            <tbody>{pool.sort(sorter).map((l) => <tr key={l.id}><td><button className="hub-link" onClick={() => openLead(l)}>{l.company || l.email} — fulfillment</button></td><td><span className={`hub-status s-${l.stage}`}>{COLS.find((c) => c[0] === l.stage)?.[1] || stageLabel(l.stage)}</span></td><td>{val(l) ? money(val(l)) : '--'}</td><td>{val(l) ? money(val(l) * 12) : '--'}</td><td>{fmtD(l.won_at)}</td><td>{who(l.assigned_to) || <span className="muted">Unassigned</span>}</td><td>{l.company || '--'}</td><td>{l.last_touch_at ? ago(l.last_touch_at) : '--'}</td></tr>)}</tbody>
          </table></div>
        )}
      </div>
      <div className="hub-foot"><span className="hub-count">{num(pool.length)} deals</span><span className="spacer" /><button className="hub-pillbtn">Export</button><button className="hub-pillbtn">Clone</button></div>
      </div>
      {creating && <CreatePanel kind="contact" me={me} rep={rep} people={people} sources={sources} onClose={() => setCreating(false)} reload={reload} say={say} openLead={openLead} defaults={{ stage: 'contacted' }} />}
    </div>
  );
}
