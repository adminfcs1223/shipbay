// Deals — HubSpot's board: one column per pipeline stage with the stage total on top, cards you drag between stages,
// and a table view. A deal is an account whose lead status is past New.
import { useMemo, useState } from 'react';
import { supabase } from '../../lib';
import { money, num, ago, stageLabel } from '../owner/util';
import { expectedMonthly, winLead } from '../owner/Sales';
import { HS_URL, initialsOf, avColor } from './Hub';
import { CreatePanel } from './Contacts';

const COLS = [['contacted', 'Contacted'], ['replied', 'Replied'], ['call_booked', 'Call booked'], ['quoted', 'Quoted'], ['signed', 'Closed won'], ['lost', 'Closed lost']];
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
      <div className="hub-head">
        <div><h1>Deals</h1><small>{num(pool.length)} deals · {money(openTotal)}/mo open · {money(wonTotal)}/mo won</small></div>
        <div className="acts">
          {hs?.portal_id && <a className="hs-btn ghost" href={`https://app.hubspot.com/contacts/${hs.portal_id}/objects/0-3/views/all/board${hs.pipeline_id ? `?pipeline=${hs.pipeline_id}` : ''}`} target="_blank" rel="noreferrer">Open in HubSpot</a>}
          <button className="hs-btn primary" onClick={() => setCreating(true)}>Create deal</button>
        </div>
      </div>
      <div className="hub-card">
        <div className="hub-filters">
          <select className="pill strong" value="shipbay" readOnly><option value="shipbay">ShipBay Sales pipeline</option></select>
          <div className="hub-toggle"><button className={mode === 'board' ? 'on' : ''} title="Board view" onClick={() => setMode('board')}><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="13" rx="1"/></svg></button><button className={mode === 'table' ? 'on' : ''} title="Table view" onClick={() => setMode('table')}><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="5" width="18" height="3" rx="1"/><rect x="3" y="10.5" width="18" height="3" rx="1"/><rect x="3" y="16" width="18" height="3" rx="1"/></svg></button></div>
          <select className="pill" value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">Deal owner</option><option value="none">Unassigned</option>{people.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}</select>
          <select className="pill" value={sort} onChange={(e) => setSort(e.target.value)}><option value="value">Sort: amount</option><option value="recent">Sort: last activity</option><option value="name">Sort: name</option></select>
          <div className="spacer" />
          <label className="hub-tsearch"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input placeholder="Search deals" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        </div>
        {mode === 'board' ? (
          <div className="hub-board">
            {COLS.map(([k, label]) => { const items = col(k); const tot = items.reduce((a, l) => a + val(l), 0); return (
              <div key={k} className={`hub-col ${over === k ? 'over' : ''} ${k}`} onDragOver={(e) => { e.preventDefault(); setOver(k); }} onDragLeave={() => setOver(null)} onDrop={() => { setOver(null); move(drag, k); setDrag(null); }}>
                <div className="hub-colhead"><b>{label}</b><small>{money(tot)}/mo · {items.length} deal{items.length === 1 ? '' : 's'}</small><i className="bar" /></div>
                <div className="hub-cards">
                  {items.map((l) => <div key={l.id} className="hub-dealcard" draggable onDragStart={() => setDrag(l)} onDragEnd={() => setDrag(null)}>
                    <button className="hub-link title" onClick={() => openLead(l)}>{l.company || l.email} — fulfillment</button>
                    <div className="meta"><span>Amount: <b>{val(l) ? `${money(val(l))}/mo` : '--'}</b></span><span>{k === 'signed' ? `Won ${fmtD(l.won_at)}` : `${days(l)} day${days(l) === 1 ? '' : 's'} in stage`}</span></div>
                    <div className="foot">{l.assigned_to ? <span className="hub-owner"><span className="hub-av xs" style={{ background: avColor(who(l.assigned_to)) }}>{initialsOf(who(l.assigned_to))}</span>{who(l.assigned_to).split(' ')[0]}</span> : <span className="muted">Unassigned</span>}{l.contact_name && <span className="muted">{l.contact_name}</span>}</div>
                  </div>)}
                  {items.length === 0 && <div className="hub-colempty">Drop a deal here</div>}
                </div>
              </div>); })}
          </div>
        ) : (
          <div className="hub-tablewrap"><table className="hub-table">
            <thead><tr><th>Deal name</th><th>Deal stage</th><th>Amount / mo</th><th>Annual</th><th>Close date</th><th>Deal owner</th><th>Company</th><th>Last activity</th></tr></thead>
            <tbody>{pool.sort(sorter).map((l) => <tr key={l.id}><td><button className="hub-link" onClick={() => openLead(l)}>{l.company || l.email} — fulfillment</button></td><td><span className={`hub-status s-${l.stage}`}>{COLS.find((c) => c[0] === l.stage)?.[1] || stageLabel(l.stage)}</span></td><td>{val(l) ? money(val(l)) : '--'}</td><td>{val(l) ? money(val(l) * 12) : '--'}</td><td>{fmtD(l.won_at)}</td><td>{who(l.assigned_to) || <span className="muted">Unassigned</span>}</td><td>{l.company || '--'}</td><td>{l.last_touch_at ? ago(l.last_touch_at) : '--'}</td></tr>)}</tbody>
          </table></div>
        )}
      </div>
      {creating && <CreatePanel kind="contact" me={me} rep={rep} people={people} sources={sources} onClose={() => setCreating(false)} reload={reload} say={say} openLead={openLead} defaults={{ stage: 'contacted' }} />}
    </div>
  );
}
