// Team — what every salesperson has been up to: dials, connects, booked, replies answered, won, time on the phone.
// Also where the owner decides who is on the sales team and who is in the email round-robin.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib';
import { fetchAll, money, pct, num, ago, hhmm, stageLabel, stageClass } from './util';

const CONNECT = new Set(['connected', 'booked', 'not_fit']); const PICKUP = new Set(['gatekeeper', 'connected', 'booked', 'not_fit']);
const RANGES = [['today', 'Today'], ['week', '7 days'], ['month', '30 days'], ['all', 'All time']];
export const DEFAULT_GOALS = { dials_day: 60, dials_week: 300, emails_day: 150, emails_week: 750, booked_day: 1, booked_week: 5 };
export const GOAL_LABELS = { dials: 'Dials', emails: 'Emails sent', booked: 'Calls booked' };

/** Goals: team defaults + per-rep overrides, stored in fin_settings.sales_goals. */
export function useGoals() {
  const [g, setG] = useState(null);
  const load = async () => { const { data } = await supabase.from('fin_settings').select('value').eq('key', 'sales_goals').maybeSingle(); setG({ team: { ...DEFAULT_GOALS, ...(data?.value?.team || {}) }, reps: data?.value?.reps || {} }); };
  useEffect(() => { load(); }, []);
  const save = async (next) => { await supabase.from('fin_settings').upsert({ key: 'sales_goals', value: next }); setG(next); };
  return [g, save];
}
export const goalsFor = (g, uid) => ({ ...(g?.team || DEFAULT_GOALS), ...((uid && g?.reps?.[uid]) || {}) });

/** Progress bars: [{key:'dials', value, goal}] */
export function GoalBars({ title, items }) {
  return (
    <div className="card goals">
      <div className="cardhead"><h3>{title}</h3></div>
      <div className="goalrows">{items.filter((i) => i.goal > 0).map((i) => { const p = Math.min(1, i.value / i.goal); const done = i.value >= i.goal; return (
        <div key={i.key} className={`goalrow ${done ? 'done' : ''}`}>
          <div className="lbl"><span>{GOAL_LABELS[i.key] || i.key}</span><b>{num(i.value)} <span className="of">/ {num(i.goal)}</span></b></div>
          <div className="bar"><i style={{ width: `${p * 100}%` }} /></div>
        </div>
      ); })}</div>
    </div>
  );
}

export function useTeamData() {
  const [d, setD] = useState(null);
  const load = async () => {
    const [people, calls, sessions, leads, meetings, rr] = await Promise.all([
      supabase.from('profiles').select('id, full_name, email, role, is_sales, is_owner, active, last_seen_at').like('role', 'shipbay%').order('full_name'),
      fetchAll('sales_calls', 'id, lead_id, outcome, started_at, seconds, by_user'),
      fetchAll('sales_call_sessions', 'id, started_at, ended_at, seconds, by_user'),
      fetchAll('sales_leads', 'id, company, email, stage, assigned_to, answered_at, deal_value, won_at, last_touch_at, source, filter_id'),
      fetchAll('sales_meetings', 'id, starts_at, status, outcome, assigned_to, invitee_name, lead_id'),
      supabase.from('fin_settings').select('value').eq('key', 'round_robin').maybeSingle(),
    ]);
    setD({ people: people.data || [], calls, sessions, leads, meetings, rr: rr.data?.value || { members: [], next: 0 } });
  };
  useEffect(() => { load(); }, []);
  return [d, load];
}

export function teamStats(d, range) {
  const since = range === 'today' ? new Date(new Date().setHours(0, 0, 0, 0)).getTime() : range === 'week' ? Date.now() - 7 * 86400000 : range === 'month' ? Date.now() - 30 * 86400000 : 0;
  const inR = (iso) => iso && new Date(iso).getTime() >= since;
  const reps = d.people.filter((p) => p.is_sales || p.is_owner);
  return reps.map((p) => {
    const C = d.calls.filter((c) => c.by_user === p.id && inR(c.started_at));
    const L = d.leads.filter((l) => l.assigned_to === p.id);
    const S = d.sessions.filter((s) => s.by_user === p.id && inR(s.started_at));
    const M = d.meetings.filter((m) => m.assigned_to === p.id);
    const won = L.filter((l) => l.stage === 'signed' && (range === 'all' || inR(l.won_at)));
    const lastCall = d.calls.filter((c) => c.by_user === p.id).sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
    const dials = C.length; const pick = C.filter((c) => PICKUP.has(c.outcome)).length; const conn = C.filter((c) => CONNECT.has(c.outcome)).length; const booked = C.filter((c) => c.outcome === 'booked').length;
    const lost = L.filter((l) => l.stage === 'lost' && (range === 'all' || inR(l.last_touch_at))).length;
    const closeRate = won.length + lost ? won.length / (won.length + lost) : null;
    return { p, dials, lost, closeRate, pickRate: dials ? pick / dials : 0, connRate: dials ? conn / dials : 0, booked, talk: C.filter((c) => CONNECT.has(c.outcome)).reduce((a, c) => a + c.seconds, 0), time: S.reduce((a, s) => a + (s.seconds || 0), 0),
      leads: L.length, waiting: L.filter((l) => l.stage === 'replied' && !l.answered_at).length, answered: L.filter((l) => inR(l.answered_at)).length, meetings: M.filter((m) => m.status === 'active' && new Date(m.starts_at) >= Date.now()).length, won: won.length, wonValue: won.reduce((a, l) => a + Number(l.deal_value || 0), 0), lastActive: lastCall?.started_at || p.last_seen_at || null };
  }).sort((a, b) => b.dials - a.dials || b.booked - a.booked);
}

const name = (p) => (p.full_name || p.email).split(' ')[0];

export function TeamTable({ rows, compact }) {
  return (
    <div className="tablewrap"><table className="ordertable fin">
      <thead><tr><th>Rep</th><th className="n">Dials</th><th className="n">Pick-up</th><th className="n">Booked</th><th className="n">Replies answered</th>{!compact && <th className="n">Waiting</th>}<th className="n">Won</th><th className="n">Close rate</th>{!compact && <th className="n">Phone time</th>}<th>Last active</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.p.id}><td><b>{name(r.p)}</b>{r.p.is_owner && <span className="sm"> (you)</span>}<div className="sm">{num(r.leads)} leads · {num(r.meetings)} calls on the books</div></td>
          <td className="n">{num(r.dials)}</td><td className="n">{pct(r.pickRate)}</td><td className="n"><b>{num(r.booked)}</b></td><td className="n">{num(r.answered)}</td>{!compact && <td className={`n ${r.waiting ? 'neg' : ''}`}>{num(r.waiting)}</td>}
          <td className="n">{num(r.won)}{r.wonValue ? <div className="sm">{money(r.wonValue)}/mo</div> : null}</td><td className="n">{r.closeRate == null ? '—' : pct(r.closeRate)}{r.lost ? <div className="sm">{num(r.lost)} lost</div> : null}</td>{!compact && <td className="n">{hhmm(r.time)}</td>}<td className="sm">{ago(r.lastActive)}</td></tr>
      ))}{rows.length === 0 && <tr><td colSpan={10} className="empty">No salespeople yet — add them below.</td></tr>}</tbody>
    </table></div>
  );
}

export default function Team() {
  const [d, reload] = useTeamData(); const [range, setRange] = useState('week'); const [msg, setMsg] = useState(null); const [goals, saveGoals] = useGoals(); const [gRep, setGRep] = useState('');
  const rows = useMemo(() => (d ? teamStats(d, range) : []), [d, range]);
  if (!d) return <div className="card"><div className="empty">Loading…</div></div>;
  const say = (r, ok) => { if (r?.error) setMsg({ kind: 'err', text: r.error }); else if (ok) setMsg({ kind: 'ok', text: ok }); };
  const toggleSales = async (p) => { const { error } = await supabase.from('profiles').update({ is_sales: !p.is_sales }).eq('id', p.id); if (error) return say({ error: error.message }); reload(); };
  const toggleRR = async (p) => { const members = d.rr.members.includes(p.id) ? d.rr.members.filter((x) => x !== p.id) : [...d.rr.members, p.id]; const { error } = await supabase.from('fin_settings').upsert({ key: 'round_robin', value: { ...d.rr, members, next: 0 } }); if (error) return say({ error: error.message }); reload(); };
  const who = (id) => { const p = d.people.find((x) => x.id === id); return p ? name(p) : '—'; };
  const leadName = (id) => d.leads.find((l) => l.id === id)?.company || d.leads.find((l) => l.id === id)?.email || 'a lead';
  const feed = [
    ...d.calls.map((c) => ({ at: c.started_at, who: c.by_user, text: `${c.outcome.replace('_', ' ')} · ${leadName(c.lead_id)}${c.seconds > 30 ? ` · ${Math.round(c.seconds / 60)} min` : ''}`, kind: c.outcome === 'booked' ? 'ok' : '' })),
    ...d.leads.filter((l) => l.answered_at).map((l) => ({ at: l.answered_at, who: l.assigned_to, text: `answered ${l.company || l.email}'s reply`, kind: 'ok' })),
    ...d.leads.filter((l) => l.won_at).map((l) => ({ at: l.won_at, who: l.assigned_to, text: `won ${l.company || l.email}${l.deal_value ? ` · ${money(l.deal_value)}/mo` : ''}`, kind: 'win' })),
    ...d.meetings.filter((m) => m.outcome).map((m) => ({ at: m.starts_at, who: m.assigned_to, text: `call with ${m.invitee_name || 'invitee'} → ${m.outcome.replace('_', ' ')}`, kind: '' })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
  const tot = rows.reduce((a, r) => ({ dials: a.dials + r.dials, booked: a.booked + r.booked, answered: a.answered + r.answered, won: a.won + r.won, lost: a.lost + r.lost }), { dials: 0, booked: 0, answered: 0, won: 0, lost: 0 });
  const teamClose = tot.won + tot.lost ? tot.won / (tot.won + tot.lost) : null;
  const setGoal = (k, v) => { if (!goals) return; const n = Number(v) || 0; const next = gRep ? { ...goals, reps: { ...goals.reps, [gRep]: { ...(goals.reps[gRep] || {}), [k]: n } } } : { ...goals, team: { ...goals.team, [k]: n } }; saveGoals(next); };
  const cur = goals ? (gRep ? { ...goals.team, ...(goals.reps[gRep] || {}) } : goals.team) : DEFAULT_GOALS;
  return (
    <>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}
      <div className="opsbar"><span className="seg tight">{RANGES.map(([k, l]) => <button key={k} className={range === k ? 'on' : ''} onClick={() => setRange(k)}>{l}</button>)}</span><div className="spacer" /><span className="sm">Team: <b>{num(tot.dials)}</b> dials · <b>{num(tot.booked)}</b> booked · <b>{num(tot.answered)}</b> replies answered · <b>{num(tot.won)}</b> won · close rate <b>{teamClose == null ? '—' : pct(teamClose)}</b></span></div>
      <div className="card"><div className="cardhead"><h3>Scoreboard</h3><span className="sm">{RANGES.find((r) => r[0] === range)[1].toLowerCase()}</span></div><TeamTable rows={rows} /></div>
      <div className="ownergrid">
        <div className="card">
          <div className="cardhead"><h3>Activity</h3><span className="sm">latest first</span></div>
          {feed.length === 0 ? <div className="empty">Nothing logged yet.</div> : <ul className="feed">{feed.map((f, i) => <li key={i} className={f.kind}><span className="sm">{ago(f.at)}</span><b>{who(f.who)}</b><span>{f.text}</span></li>)}</ul>}
        </div>
        <div className="card">
          <div className="cardhead"><h3>Goals</h3><select className="statusselect" value={gRep} onChange={(e) => setGRep(e.target.value)}><option value="">Team</option>{d.people.filter((p) => p.is_sales || p.is_owner).map((p) => <option key={p.id} value={p.id}>{name(p)}</option>)}</select></div>
          <p className="hint">{gRep ? 'This person’s own targets (blank = team default).' : 'Team targets. Progress shows on the Dashboard; each rep sees their own on their Sales page.'}</p>
          <table className="ordertable fin goalsedit"><thead><tr><th /><th className="n">Per day</th><th className="n">Per week</th></tr></thead><tbody>
            {['dials', 'emails', 'booked'].map((k) => <tr key={k}><td>{GOAL_LABELS[k]}</td><td className="n"><input className="cellnum" type="number" min="0" value={cur[`${k}_day`] ?? ''} onChange={(e) => setGoal(`${k}_day`, e.target.value)} /></td><td className="n"><input className="cellnum" type="number" min="0" value={cur[`${k}_week`] ?? ''} onChange={(e) => setGoal(`${k}_week`, e.target.value)} /></td></tr>)}
          </tbody></table>
        </div>
        <div className="card">
          <div className="cardhead"><h3>Who’s on the team</h3></div>
          <p className="hint">Sales team members see the Sales page: their own leads, the untouched call pool, their booked calls. Round-robin decides who gets each new email reply, in turn.</p>
          <table className="ordertable fin"><thead><tr><th>Staff</th><th>On sales team</th><th>Email round-robin</th></tr></thead>
            <tbody>{d.people.filter((p) => p.active !== false).map((p) => (
              <tr key={p.id}><td><b>{p.full_name || p.email}</b><div className="sm">{p.email}</div></td>
                <td><label className="chk"><input type="checkbox" checked={!!p.is_sales} onChange={() => toggleSales(p)} /> {p.is_sales ? 'yes' : 'no'}</label></td>
                <td><label className="chk"><input type="checkbox" disabled={!p.is_sales && !p.is_owner} checked={d.rr.members.includes(p.id)} onChange={() => toggleRR(p)} /> {d.rr.members.includes(p.id) ? `in rotation${d.rr.members[d.rr.next % Math.max(1, d.rr.members.length)] === p.id ? ' · next up' : ''}` : 'out'}</label></td></tr>
            ))}</tbody></table>
        </div>
      </div>
    </>
  );
}
