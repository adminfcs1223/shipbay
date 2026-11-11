// Follow-ups + the setter's Dashboard (Derek, 2026-11-10 19:49 ET).
// Every email a setter sends flags the lead for a follow-up (database triggers, migration 20261110250000): due 2 business
// days after the email, then 4, then 7. Sending the next email, a call that reaches a person, a reply or a booking closes it.
// The Dashboard is the setter's day: calls, emails, follow-ups, the bonus bar, and the follow-up list.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib';
import { ago, num, fetchAll } from './util';
import { useGoals, goalsFor, bonusFor, bonusProgress, BonusBar } from './Team';
import { PowerButton } from './Debrief';

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayLabel = (iso) => { const d = new Date(`${iso}T12:00:00`); return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); };
const isSetter = (me) => me?.role === 'shipbay_setter';

/** open follow-ups I can see (mine; the owner and a setter's closer see more) + the ones closed today */
export function useFollowUps() {
  const [rows, setRows] = useState(null);
  const load = async () => {
    const day0 = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const [open, done] = await Promise.all([
      supabase.from('sales_followups').select('*').is('done_at', null).order('due_on').limit(2000),
      supabase.from('sales_followups').select('id, owner_id, done_how, done_at').gte('done_at', day0).limit(2000)]);
    setRows({ open: open.data || [], doneToday: done.data || [], error: open.error?.message || null });
  };
  useEffect(() => { load(); }, []);
  return [rows, load];
}

/** The follow-up list: what is due, who it is, when the email went, and the ways to clear it. */
export function FollowUpList({ me, leads, rows, reload, say, openLead, people, mineOnly = true, limit = null }) {
  const [busy, setBusy] = useState(null); const today = ymd(new Date());
  const list = (rows?.open || []).filter((f) => !mineOnly || f.owner_id === me.id);
  const due = list.filter((f) => f.due_on <= today); const later = list.filter((f) => f.due_on > today);
  const who = (id) => { const p = (people || []).find((x) => x.id === id); return p ? (p.full_name || p.email).split(' ')[0] : ''; };
  const finish = async (f, stop) => {
    if (stop && !window.confirm('Stop following up with this lead? No more follow-ups are flagged for it unless you email them again.')) return;
    setBusy(f.id); const { data, error } = await supabase.rpc('followup_done', { p_id: f.id, p_stop: !!stop }); setBusy(null);
    if (error) return say?.({ error: error.message });
    say?.(null, stop ? 'Stopped. No more follow-ups on this lead.' : data?.next ? `Done. Next follow-up ${dayLabel(data.next)}.` : 'Done. That was the last follow-up for this lead.');
    reload();
  };
  const row = (f, isDue) => { const l = (leads || []).find((x) => x.id === f.lead_id); const late = f.due_on < today; return (
    <tr key={f.id} className={late ? 'late' : ''}>
      <td><b className={l ? 'click' : ''} onClick={() => l && openLead?.(l)}>{l ? (l.company || l.domain || l.email) : 'a lead you no longer hold'}</b><div className="sm">{l ? [l.contact_name, l.email].filter(Boolean).join(' · ') : ''}</div></td>
      <td className="sm">Follow-up {f.n} of 3<div className="sm">emailed {ago(f.email_at)}{!mineOnly && f.owner_id !== me.id ? ` · ${who(f.owner_id)}` : ''}</div></td>
      <td><span className={`statuspill ${late ? 'bad' : isDue ? 'warn' : 'muted'}`}>{late ? `due ${dayLabel(f.due_on)}` : isDue ? 'due today' : dayLabel(f.due_on)}</span></td>
      <td className="n"><div className="fuacts">
        {l && f.owner_id === me.id && <PowerButton lead={l} me={me} say={say} onDone={reload} />}
        {l?.phone && <a className="btn-sm" href={`tel:${l.phone.replace(/[^+\d]/g, '')}`} onClick={() => openLead?.(l)}>Call</a>}
        <button className="btn-xs" disabled={busy === f.id} title="You followed up another way. The next follow-up gets flagged." onClick={() => finish(f, false)}>Done</button>
        <button className="btn-xs" disabled={busy === f.id} title="No more follow-ups on this lead" onClick={() => finish(f, true)}>Stop</button>
      </div></td>
    </tr>
  ); };
  if (rows === null) return <div className="card"><div className="empty">Loading…</div></div>;
  if (rows.error) return <div className="card"><div className="msg err">{rows.error}</div></div>;
  const shownLater = limit ? later.slice(0, limit) : later;
  return (
    <>
      <div className="card">
        <div className="cardhead"><h3>Follow-ups due</h3><span className="sm">{num(due.length)}</span></div>
        {due.length === 0 ? <div className="empty">Nothing to follow up today.</div> : <div className="tablewrap"><table className="ordertable fin futable"><tbody>{due.map((f) => row(f, true))}</tbody></table></div>}
      </div>
      {later.length > 0 && <div className="card">
        <div className="cardhead"><h3>Coming up</h3><span className="sm">{num(later.length)}</span></div>
        <div className="tablewrap"><table className="ordertable fin futable"><tbody>{shownLater.map((f) => row(f, false))}</tbody></table></div>
        {limit && later.length > limit ? <div className="sm" style={{ marginTop: 8 }}>{num(later.length - limit)} more after these.</div> : null}
      </div>}
    </>
  );
}

/** The Dashboard: what I have today (calls, emails, follow-ups), my bonus, and the follow-ups themselves. */
export function MyDay({ me, leads, people, say, openLead, go, reload }) {
  const [fu, loadFu] = useFollowUps(); const [goals] = useGoals(); const [calls, setCalls] = useState(null); const [emails, setEmails] = useState(null);
  const load = async () => {
    const month0 = new Date(new Date().getFullYear(), new Date().getMonth(), 1); const week0 = new Date(Date.now() - 8 * 86400000); const since = new Date(Math.min(month0, week0)).toISOString();
    const day0 = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const [c, e] = await Promise.all([
      fetchAll('sales_calls', 'id, lead_id, outcome, started_at, by_user', (q) => q.eq('by_user', me.id).is('voided_at', null).gte('started_at', since)),
      supabase.from('sales_touches').select('id', { count: 'exact', head: true }).eq('by_user', me.id).eq('kind', 'email_sent').gte('at', day0)]);
    setCalls(c); setEmails(e.count || 0);
  };
  useEffect(() => { load(); }, [me.id]);
  const today = ymd(new Date()); const day0 = new Date(new Date().setHours(0, 0, 0, 0)).getTime(); const now = Date.now();
  const ready = useMemo(() => (leads || []).filter((l) => l.assigned_to === me.id && l.in_calls && l.phone && !['dnc', 'lost', 'signed'].includes(l.stage) && (!l.next_action_at || new Date(l.next_action_at).getTime() <= now)).length, [leads, me.id]);
  if (!calls || !fu || !goals) return <div className="card"><div className="empty">Loading…</div></div>;
  const callsToday = calls.filter((c) => new Date(c.started_at).getTime() >= day0);
  const mineOpen = fu.open.filter((f) => f.owner_id === me.id); const dueNow = mineOpen.filter((f) => f.due_on <= today).length;
  const doneToday = fu.doneToday.filter((f) => f.owner_id === me.id && ['email', 'call', 'done'].includes(f.done_how)).length;
  const g = goalsFor(goals, me.id);
  // the bonus bar: a setter's shows once Derek has saved rules for them (Admin → Team → Bonus rules); closers use the team rules
  const hasOwn = !!goals.bonus_reps?.[me.id]; const b = bonusFor(goals, me.id); const p = bonusProgress(b, { calls, leads: leads || [] }, me.id);
  const refresh = () => { loadFu(); load(); reload?.(); };
  return (
    <>
      <div className="card"><div className="daytiles">
        <button onClick={() => go?.('calls')}><b>{num(ready)}</b><span>Calls to make</span><small>{num(callsToday.length)} made today{g.dials_day ? ` · goal ${num(g.dials_day)}` : ''}</small></button>
        <button className={dueNow ? 'hot' : ''} onClick={() => document.querySelector('.futable')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}><b>{num(dueNow)}</b><span>Follow-ups due</span><small>{num(doneToday)} done today · {num(mineOpen.length - dueNow)} coming up</small></button>
        <button onClick={() => go?.('email')}><b>{num(emails)}</b><span>Emails sent today</span><small>each one flags a follow-up</small></button>
        <button onClick={() => go?.('calendar')}><b>{num(callsToday.filter((c) => c.outcome === 'booked').length)}</b><span>Calls booked today</span><small>open the calendar</small></button>
      </div></div>
      <div className="card">
        {isSetter(me) && !hasOwn ? <div className="bonuswait"><b>Bonus</b><span className="sm">You are eligible. Derek is setting your target; the bar shows here once he has.</span></div> : <BonusBar b={b} p={p} />}
      </div>
      <FollowUpList me={me} leads={leads} rows={fu} reload={refresh} say={say} openLead={openLead} people={people} limit={12} />
    </>
  );
}
