// Sales — the salesperson's desk (anyone on staff flagged is_sales). Your booked calls and the leads handed to you.
// Reps only see rows assigned to them (RLS); the owner hands leads over from Owner → Sales.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib';
import { fetchAll, num, ago, STAGES, stageLabel, stageClass, money } from './owner/util';
import { Calendar } from './owner/Sales';

const OUT = [['connected', 'Connected'], ['voicemail', 'Voicemail'], ['no_answer', 'No answer'], ['booked', 'Booked a call'], ['not_fit', 'Not a fit']];

export default function SalesDesk({ me }) {
  const [leads, setLeads] = useState(null); const [open, setOpen] = useState(null); const [msg, setMsg] = useState(null);
  const load = async () => setLeads(await fetchAll('sales_leads', '*', (q) => q.eq('assigned_to', me.id).order('last_touch_at', { ascending: false, nullsFirst: false })));
  useEffect(() => { load(); }, [me.id]);
  const say = (r, ok) => { if (r?.error) setMsg({ kind: 'err', text: r.error }); else if (ok) setMsg({ kind: 'ok', text: ok }); };
  const setStage = async (l, stage) => { await supabase.from('sales_leads').update({ stage, last_touch_at: new Date().toISOString() }).eq('id', l.id); load(); };
  const logCall = async (l, outcome) => {
    if (!outcome) return;
    await supabase.from('sales_calls').insert({ lead_id: l.id, started_at: new Date().toISOString(), ended_at: new Date().toISOString(), seconds: 0, outcome, by_user: me.id });
    const patch = { attempts: (l.attempts || 0) + 1, last_outcome: outcome, last_touch_at: new Date().toISOString() };
    if (outcome === 'booked') patch.stage = 'call_booked'; else if (outcome === 'not_fit') patch.stage = 'lost'; else if (l.stage === 'new') patch.stage = 'contacted';
    await supabase.from('sales_leads').update(patch).eq('id', l.id); load();
  };
  const counts = useMemo(() => ({ total: (leads || []).length, waiting: (leads || []).filter((l) => l.stage === 'replied' && !l.answered_at).length, booked: (leads || []).filter((l) => l.stage === 'call_booked').length }), [leads]);
  if (!me?.is_sales && me?.role !== 'shipbay_admin') return <div className="card"><div className="empty">Ask Derek to add you to the sales team.</div></div>;
  return (
    <div className="owner">
      <div className="pagehead">
        <div><h1>Sales<span className="dot">.</span></h1><p className="sub">Your booked calls and the leads in your hands.</p></div>
        <div className="glance">
          <div><small>Your leads</small><b>{num(counts.total)}</b></div>
          <div><small>Waiting on you</small><b className={counts.waiting ? 'hot' : ''}>{num(counts.waiting)}</b></div>
          <div><small>Calls booked</small><b>{num(counts.booked)}</b></div>
        </div>
      </div>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}
      <h3 className="secthead">Booked calls</h3>
      <Calendar me={me} leads={leads || []} status={null} reload={load} say={say} mineOnly />
      <h3 className="secthead">Your leads</h3>
      <div className="card">
        {leads === null ? <div className="empty">Loading…</div> : leads.length === 0 ? <div className="empty">Nothing handed to you yet.</div> : (
          <div className="tablewrap"><table className="ordertable leads">
            <thead><tr><th>Company</th><th>Contact</th><th>Stage</th><th>Last touch</th><th>Log a call</th><th /></tr></thead>
            <tbody>{leads.map((l) => (
              <tr key={l.id}>
                <td><b>{l.company || l.domain || l.email}</b><div className="sm">{[l.city, l.state].filter(Boolean).join(', ')}{l.est_sales_usd ? ` · ~${money(l.est_sales_usd)}/mo online` : ''}</div></td>
                <td>{l.contact_name}<div className="sm">{l.phone && <a href={`tel:${l.phone.replace(/[^+\d]/g, '')}`}>{l.phone}</a>}{l.phone && l.email ? ' · ' : ''}{l.email && <a href={`mailto:${l.email}`}>{l.email}</a>}</div></td>
                <td><select className={`statuspill ${stageClass(l.stage)}`} value={l.stage} onChange={(e) => setStage(l, e.target.value)}>{STAGES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>{l.stage === 'replied' && !l.answered_at && <div className="sm neg">reply waiting</div>}</td>
                <td className="sm">{ago(l.last_touch_at)}{l.last_outcome && <div className="sm">{l.last_outcome.replace('_', ' ')}</div>}</td>
                <td><select className="statusselect" value="" onChange={(e) => logCall(l, e.target.value)}><option value="">outcome…</option>{OUT.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
                <td className="n"><button className="btn-xs" onClick={() => setOpen(l)}>Notes</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {open && <RepNotes lead={open} onClose={() => setOpen(null)} reload={load} say={say} />}
    </div>
  );
}

function RepNotes({ lead, onClose, reload, say }) {
  const [notes, setNotes] = useState(lead.notes || ''); const [next, setNext] = useState(lead.next_action_at ? lead.next_action_at.slice(0, 16) : '');
  const save = async () => { const { error } = await supabase.from('sales_leads').update({ notes, next_action_at: next ? new Date(next).toISOString() : null }).eq('id', lead.id); if (error) return say({ error: error.message }); reload(); onClose(); };
  return (
    <div className="overlay" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>{lead.company || lead.email}</h3>
      <p className="lead">{[lead.contact_name, lead.title, lead.email, lead.phone].filter(Boolean).join(' · ')}</p>
      <div className="field"><label>Notes</label><textarea rows={6} style={{ width: '100%', padding: 10, border: '1.5px solid var(--line)', borderRadius: 10, font: '14px var(--font-body)' }} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      <div className="field"><label>Follow up on</label><input type="datetime-local" value={next} onChange={(e) => setNext(e.target.value)} /></div>
      <div className="row"><div className="spacer" /><button className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary" onClick={save}>Save</button></div>
    </div></div>
  );
}
