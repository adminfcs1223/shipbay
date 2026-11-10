// Appointment setting (Derek, 2026-11-10): setters dial and book calls for the closer they are assigned to.
// Everything that changes data goes through a database function, so a call is one transaction on the server:
//   log_call      the dial, every effect on the lead, and a booking if there is one (safe to retry: client_id)
//   book_meeting  a call on the closer's calendar; the server refuses a double-booking
//   open_slots    the closer's free times; setter_board what a closer sees about their setters
// The invite email (.ics to the prospect and the closer) is the "appt" edge function.
import { useEffect, useMemo, useState } from 'react';
import { supabase, fn } from '../../lib';
import { ago, hhmm, mmss, num, pct, ymd } from './util';

const first = (p) => ((p?.full_name || p?.email || '').split(' ')[0] || '');
const isSetter = (me) => me?.role === 'shipbay_setter';
const fmtDay = (d) => new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = (d) => new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
export const fmtWhen = (d) => `${fmtDay(d)} · ${fmtTime(d)}`;
const OUTCOME = { no_answer: 'No answer', voicemail: 'Voicemail', gatekeeper: 'Gatekeeper', connected: 'Connected', booked: 'Booked', not_fit: 'Not a fit', wrong_number: 'Bad number', dnc: 'Do not contact' };
export const outcomeLabel = (o) => OUTCOME[o] || o || '—';
const netDown = (error) => !error?.code && /fetch|network|load failed/i.test(error?.message || '');

/* =================== the call log =================== */
const OUTBOX = 'shipbay-call-outbox';
const readBox = () => { try { return JSON.parse(localStorage.getItem(OUTBOX) || '[]'); } catch { return []; } };
const writeBox = (x) => { try { localStorage.setItem(OUTBOX, JSON.stringify(x)); } catch { /* storage unavailable */ } };
export const outbox = () => readBox();

/** One dial → one transaction on the server. If the connection drops the call waits in this browser and is retried;
 *  the client_id makes the retry the same call, never a second one. A rule the server refuses comes back as { error }. */
export async function logCall(payload) {
  const p = { client_id: crypto.randomUUID(), ...payload };
  const { data, error } = await supabase.rpc('log_call', { p });
  if (!error) return data;
  if (netDown(error)) { writeBox([...readBox().filter((x) => x.client_id !== p.client_id), { ...p, queued_at: new Date().toISOString() }]); return { queued: true, client_id: p.client_id }; }
  return { error: error.message };
}
/** Send whatever is waiting. Returns { sent, left }. */
export async function flushOutbox() {
  const box = readBox(); if (!box.length) return { sent: 0, left: 0 };
  const left = []; let sent = 0;
  for (const item of box) {
    const { queued_at, failed, ...p } = item;
    const { error } = await supabase.rpc('log_call', { p });
    if (!error) sent++; else left.push(netDown(error) ? item : { ...item, failed: error.message });
  }
  writeBox(left); return { sent, left: left.length };
}
export const dropFromOutbox = (clientId) => writeBox(readBox().filter((x) => x.client_id !== clientId));

/* =================== booking =================== */
export async function bookMeeting({ lead_id, closer_id, starts_at, note, invitee_email }) {
  const { data, error } = await supabase.rpc('book_meeting', { p: { lead_id, closer_id: closer_id || '', starts_at, note: note || '', invitee_email: invitee_email || '' } });
  return error ? { error: error.message } : data;
}
export const sendInvite = (meeting_id) => fn('appt', { action: 'invite', meeting_id });
export async function cancelMeeting(meeting_id, reason) {
  const { error } = await supabase.rpc('cancel_meeting', { p_meeting: meeting_id, p_reason: reason || null });
  if (error) return { error: error.message };
  const mail = await fn('appt', { action: 'cancel', meeting_id });
  return { ok: true, mailError: mail?.error || null };
}

/** The closer a booking goes to: a setter books for their closer; a closer books for themselves unless they pick someone. */
export function useCloser(me, people) {
  const locked = isSetter(me) && !!me.closer_id;
  const [closerId, setCloserId] = useState(() => (isSetter(me) ? me.closer_id || '' : me?.id || ''));
  useEffect(() => { if (!closerId && people?.length && !isSetter(me)) setCloserId(people.find((p) => p.id === me.id)?.id || people[0].id); }, [people?.length]);
  const closer = (people || []).find((p) => p.id === closerId) || null;
  return { closerId, setCloserId, closer, locked };
}

/** A closer's open times, a week at a time. Picking one calls onChange(isoString). */
export function SlotPicker({ closerId, value, onChange }) {
  const [week, setWeek] = useState(0); const [slots, setSlots] = useState(null); const [err, setErr] = useState(null); const [other, setOther] = useState(false);
  useEffect(() => {
    if (!closerId) { setSlots([]); return; }
    let live = true; setSlots(null); setErr(null);
    const d = new Date(); d.setDate(d.getDate() + week * 7);
    supabase.rpc('open_slots', { p_closer: closerId, p_from: ymd(d), p_days: 7 }).then(({ data, error }) => { if (!live) return; if (error) { setErr(error.message); setSlots([]); } else setSlots(data || []); });
    return () => { live = false; };
  }, [closerId, week]);
  const days = useMemo(() => { const by = {}; for (const s of slots || []) { const k = ymd(new Date(s.slot)); (by[k] = by[k] || []).push(s.slot); } return Object.entries(by); }, [slots]);
  if (!closerId) return <div className="empty">No closer to book for yet.</div>;
  return (
    <div className="slots">
      <div className="slots-nav">
        <button type="button" className="btn-xs" disabled={week === 0} onClick={() => setWeek(week - 1)}>‹ Earlier</button>
        <button type="button" className="btn-xs" onClick={() => setWeek(week + 1)}>Later ›</button>
        <div className="spacer" />
        <button type="button" className={`btn-xs ${other ? 'on' : ''}`} onClick={() => setOther(!other)}>Another time</button>
      </div>
      {other && <label className="dbr-to"><b>When</b><input type="datetime-local" value={value && !(slots || []).some((s) => s.slot === value) ? toLocalInput(value) : ''} onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : '')} /></label>}
      {err && <div className="note warn">{err}</div>}
      {slots === null ? <div className="empty">Loading times…</div> : days.length === 0 ? <div className="empty">Nothing open these seven days.</div> : (
        <div className="slotgrid" style={{ gridTemplateColumns: `repeat(${Math.min(7, days.length)}, minmax(0, 1fr))` }}>
          {days.map(([k, list]) => (
            <div key={k} className="slotday">
              <b>{fmtDay(list[0])}</b>
              {list.map((s) => <button key={s} type="button" className={same(s, value) ? 'on' : ''} onClick={() => onChange(s)}>{fmtTime(s)}</button>)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
const same = (a, b) => !!a && !!b && new Date(a).getTime() === new Date(b).getTime();
const toLocalInput = (iso) => { const d = new Date(iso); return `${ymd(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** Closer + time + the prospect's email + a note. Used in the Book tab and in the "Book a call" dialog during a dial. */
export function BookForm({ me, lead, people, onBooked, onCancel, compact = false }) {
  const { closerId, setCloserId, closer, locked } = useCloser(me, people);
  const [at, setAt] = useState(''); const [email, setEmail] = useState(lead?.email || ''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null); const [done, setDone] = useState(null);
  useEffect(() => { setEmail(lead?.email || ''); setAt(''); setDone(null); setErr(null); }, [lead?.id]);
  const emailOk = !email || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const book = async () => {
    setBusy(true); setErr(null);
    const m = await bookMeeting({ lead_id: lead.id, closer_id: closerId, starts_at: at, note, invitee_email: email.trim() });
    if (m.error) { setBusy(false); setErr(m.error); return; }
    const inv = await sendInvite(m.id);
    setBusy(false); setDone({ meeting: m, invite: inv }); onBooked?.(m, inv);
  };
  if (done) {
    const m = done.meeting; const inv = done.invite || {};
    return (
      <div className="booked">
        <div className="booked-when">{fmtWhen(m.starts_at)}</div>
        <div className="booked-who">{lead.company || lead.domain || lead.email} with {(m.closer_name || '').split(' ')[0]}</div>
        {inv.error ? <div className="note warn">On the calendar, but the invite did not go: {inv.error}</div>
          : inv.prospect_invited ? <div className="sm">Invite sent to {m.invitee_email}.</div>
          : <div className="note warn">On the calendar. No email on file, so the prospect got no invite.</div>}
        {onCancel && <div className="row"><div className="spacer" /><button type="button" className="btn-sm primary" onClick={onCancel}>Done</button></div>}
      </div>
    );
  }
  return (
    <div className={`bookform ${compact ? 'compact' : ''}`}>
      {locked ? <div className="bookfor one">For <b>{closer ? (closer.full_name || closer.email) : 'your closer'}</b></div>
        : isSetter(me) ? <div className="bookfor"><span className="note warn">No closer is assigned to you yet. Pick who takes it.</span><CloserPick people={people} value={closerId} onChange={(v) => { setCloserId(v); setAt(''); }} me={me} /></div>
        : (people || []).length > 1 ? <div className="bookfor"><CloserPick people={people} value={closerId} onChange={(v) => { setCloserId(v); setAt(''); }} me={me} /></div> : null}
      <SlotPicker closerId={closerId} value={at} onChange={setAt} />
      <label className="dbr-to"><b>Invite to</b><input type="email" value={email} placeholder="their email" spellCheck={false} onChange={(e) => setEmail(e.target.value)} /></label>
      {!emailOk && <span className="note warn">That does not look like an email address.</span>}
      <textarea rows={2} placeholder="For the closer: what they said, what to price…" value={note} onChange={(e) => setNote(e.target.value)} />
      {err && <div className="msg err">{err}</div>}
      <div className="row">
        {onCancel && <button type="button" className="btn-sm" onClick={onCancel}>Cancel</button>}
        <div className="spacer" />
        <span className="sm">{at ? fmtWhen(at) : 'Pick a time'}</span>
        <button type="button" className="btn-sm primary" disabled={busy || !at || !closerId || !emailOk} onClick={book}>{busy ? 'Booking…' : 'Book the call'}</button>
      </div>
    </div>
  );
}
function CloserPick({ people, value, onChange, me }) {
  return <div className="dbr-pick" style={{ gridTemplateColumns: `repeat(${Math.min(4, Math.max(2, (people || []).length))}, 1fr)` }}>{(people || []).map((p) => <button key={p.id} type="button" className={value === p.id ? 'on' : ''} onClick={() => onChange(p.id)}>{p.id === me?.id ? `${first(p)} (me)` : (p.full_name || p.email)}</button>)}</div>;
}

/** "Book a call" while the prospect is still on the line. */
export function BookModal({ me, lead, people, onBooked, onClose }) {
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal dbr">
        <div className="dbr-head"><div><h3>{lead.company || lead.domain || lead.email}</h3><span className="sm">{[lead.contact_name, lead.phone].filter(Boolean).join(' · ')}</span></div></div>
        <BookForm me={me} lead={lead} people={people} onBooked={onBooked} onCancel={onClose} compact />
      </div>
    </div>
  );
}

/* =================== the Book tab =================== */
export function Book({ me, leads, people, say, reload }) {
  const [q, setQ] = useState(''); const [lead, setLead] = useState(null); const [mtgs, setMtgs] = useState(null); const [busy, setBusy] = useState(null);
  const load = async () => { const { data } = await supabase.from('sales_meetings').select('*').neq('status', 'canceled').gte('starts_at', new Date(Date.now() - 3600000).toISOString()).order('starts_at').limit(200); setMtgs(data || []); };
  useEffect(() => { load(); }, []);
  const hits = useMemo(() => { const t = q.trim().toLowerCase(); if (t.length < 2) return []; return (leads || []).filter((l) => l.stage !== 'dnc' && [l.company, l.domain, l.contact_name, l.email, l.phone].filter(Boolean).some((v) => v.toLowerCase().includes(t))).slice(0, 8); }, [q, leads]);
  const who = (id) => first((people || []).find((p) => p.id === id)) || '—';
  const mine = (mtgs || []).filter((m) => m.booked_by === me.id || m.assigned_to === me.id);
  const cancel = async (m) => {
    const why = window.prompt('Cancel this call? The prospect and the closer get a cancellation. Reason (optional):', ''); if (why === null) return;
    setBusy(m.id); const r = await cancelMeeting(m.id, why); setBusy(null);
    say(r.error ? r : r.mailError ? { error: `Canceled here, but the cancellation email did not go: ${r.mailError}` } : null, 'Canceled. Both sides were told.'); load(); reload?.();
  };
  const resend = async (m) => { setBusy(m.id); const r = await sendInvite(m.id); setBusy(null); say(r, r.prospect_invited ? `Invite sent to ${m.invitee_email}.` : 'Sent to the closer. No email on file for the prospect.'); load(); };
  return (
    <div className="bookgrid">
      <div className="card">
        <div className="cardhead"><h3>Book a call</h3></div>
        {!lead ? (
          <div className="bookfind">
            <input className="search" autoFocus placeholder="Who is it for? Company, name, email or phone…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) { setLead(hits[0]); setQ(''); } }} />
            {hits.length > 0 && <ul className="uplist">{hits.map((l) => <li key={l.id} onClick={() => { setLead(l); setQ(''); }}><b>{l.company || l.domain || l.email}</b><span>{[l.contact_name, l.email, l.phone].filter(Boolean).join(' · ')}</span></li>)}</ul>}
            {q.trim().length >= 2 && hits.length === 0 && <div className="empty">Not in your leads. Add them under Calls first, or ask whoever owns the lead.</div>}
          </div>
        ) : (
          <>
            <div className="bookwho"><div><b>{lead.company || lead.domain || lead.email}</b><span className="sm">{[lead.contact_name, lead.phone, lead.email].filter(Boolean).join(' · ')}</span></div><button className="btn-xs" onClick={() => setLead(null)}>Change</button></div>
            <BookForm me={me} lead={lead} people={people} onBooked={() => { load(); reload?.(); }} onCancel={() => setLead(null)} />
          </>
        )}
      </div>
      <div className="card">
        <div className="cardhead"><h3>Coming up</h3><span className="sm">{mine.length}</span></div>
        {mtgs === null ? <div className="empty">Loading…</div> : mine.length === 0 ? <div className="empty">Nothing booked.</div> : (
          <ul className="bookings">{mine.map((m) => (
            <li key={m.id}>
              <div><b>{fmtWhen(m.starts_at)}</b><span>{m.invitee_name || m.name}</span>
                <span className="sm">{m.assigned_to === me.id ? (m.booked_by && m.booked_by !== me.id ? `booked by ${who(m.booked_by)}` : 'yours') : `for ${who(m.assigned_to)}`}{m.source === 'portal' ? (m.invite_sent_at ? ' · invite sent' : m.invite_error ? ` · ${m.invite_error}` : ' · no invite yet') : ` · ${m.source}`}</span></div>
              {m.source === 'portal' && <div className="acts"><button className="btn-xs" disabled={busy === m.id} onClick={() => resend(m)}>{m.invite_sent_at ? 'Resend' : 'Send invite'}</button><button className="btn-xs bad" disabled={busy === m.id} onClick={() => cancel(m)}>Cancel</button></div>}
            </li>
          ))}</ul>
        )}
      </div>
    </div>
  );
}

/* =================== the call script =================== */
/** Whose script applies: my own version, else my closer's, else the team's. Tokens fill from the lead on screen. */
export function Script({ me, lead, people, booking, fill }) {
  const [rows, setRows] = useState(null); const [edit, setEdit] = useState(null); const [asTeam, setAsTeam] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const load = async () => { const { data } = await supabase.from('sales_scripts').select('*'); setRows(data || []); };
  useEffect(() => { load(); }, []);
  if (rows === null) return <div className="card script"><div className="empty">Loading…</div></div>;
  const mine = rows.find((r) => r.owner_id === me.id); const closers = isSetter(me) && me.closer_id ? rows.find((r) => r.owner_id === me.closer_id) : null; const team = rows.find((r) => !r.owner_id);
  const cur = mine || closers || team; const whose = mine ? 'Your version' : closers ? `${first((people || []).find((p) => p.id === me.closer_id)) || 'Your closer'}’s script` : 'Team script';
  const closerName = isSetter(me) ? first((people || []).find((p) => p.id === me.closer_id)) || 'our specialist' : first(me);
  const save = async () => {
    setBusy(true); setErr(null);
    const row = { body: edit, updated_at: new Date().toISOString(), updated_by: me.id };
    const r = asTeam ? (team ? await supabase.from('sales_scripts').update(row).eq('id', team.id) : await supabase.from('sales_scripts').insert({ ...row, owner_id: null }))
      : mine ? await supabase.from('sales_scripts').update(row).eq('id', mine.id) : await supabase.from('sales_scripts').insert({ ...row, owner_id: me.id });
    setBusy(false); if (r.error) { setErr(r.error.message); return; }
    setEdit(null); setAsTeam(false); load();
  };
  const reset = async () => { if (!mine || !window.confirm('Go back to the shared script? Your version is removed.')) return; await supabase.from('sales_scripts').delete().eq('id', mine.id); setEdit(null); load(); };
  return (
    <div className="card script">
      <div className="cardhead"><h3>Script</h3><span className="sm">{whose}</span><div className="spacer" />
        {edit === null ? <button className="btn-xs" onClick={() => { setEdit(cur?.body || ''); setAsTeam(false); }}>Edit</button>
          : <><button className="btn-xs" onClick={() => setEdit(null)}>Cancel</button><button className="btn-xs primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : asTeam ? 'Save for the team' : 'Save my version'}</button></>}
      </div>
      {edit === null ? <pre className="scriptbody">{fill(cur?.body || 'No script yet. Press Edit to write one.', lead, me, booking, closerName)}</pre> : (
        <>
          <textarea className="scriptedit" rows={18} value={edit} onChange={(e) => setEdit(e.target.value)} spellCheck />
          <div className="row"><span className="sm">Fills in on screen: <code>{'{first}'}</code> <code>{'{company}'}</code> <code>{'{me}'}</code> <code>{'{closer}'}</code> <code>{'{booking}'}</code></span><div className="spacer" />
            {me.is_owner && <label className="chk"><input type="checkbox" checked={asTeam} onChange={(e) => setAsTeam(e.target.checked)} /> change it for everyone</label>}
            {mine && <button className="btn-xs" onClick={reset}>Use the shared one</button>}
          </div>
          {err && <div className="msg err">{err}</div>}
        </>
      )}
    </div>
  );
}

/* =================== your recent calls (void a mistake) =================== */
export function RecentCalls({ me, calls, leads, onChange, say }) {
  const mine = (calls || []).filter((c) => c.by_user === me.id).slice(0, 8);
  if (!mine.length) return null;
  const name = (c) => { const l = (leads || []).find((x) => x.id === c.lead_id); return l ? (l.company || l.domain || l.email) : 'a lead that moved to the closer'; };
  const voidIt = async (c) => {
    const why = window.prompt('Void this call? It drops out of every count and the lead gets the try back. Why?', ''); if (why === null) return;
    const { error } = await supabase.rpc('void_call', { p_call: c.id, p_reason: why || null });
    say(error ? { error: error.message } : null, 'Voided.'); onChange?.();
  };
  return (
    <div className="card">
      <div className="cardhead"><h3>Your last calls</h3></div>
      <table className="ordertable fin"><tbody>{mine.map((c) => (
        <tr key={c.id} className={c.voided_at ? 'voided' : ''}>
          <td className="sm">{ago(c.started_at)}</td><td><b>{name(c)}</b>{c.note && <div className="sm">{c.note}</div>}</td>
          <td><span className={`statuspill ${c.outcome === 'booked' ? 'ok' : c.outcome === 'dnc' || c.outcome === 'wrong_number' ? 'bad' : 'muted'}`}>{outcomeLabel(c.outcome)}</span></td>
          <td className="n">{c.seconds ? mmss(c.seconds) : '—'}</td>
          <td className="n">{c.voided_at ? <span className="sm">voided</span> : Date.now() - new Date(c.created_at || c.started_at).getTime() < 86400000 || me.is_owner ? <button className="btn-xs" onClick={() => voidIt(c)}>Void</button> : null}</td>
        </tr>
      ))}</tbody></table>
    </div>
  );
}

/* =================== Setters: what a closer sees about their setters =================== */
const RANGES = [[1, 'Today'], [7, '7 days'], [30, '30 days']];
export function Setters({ me, people }) {
  const [days, setDays] = useState(7); const [d, setD] = useState(null); const [err, setErr] = useState(null); const [open, setOpen] = useState(null);
  useEffect(() => { let live = true; setD(null); supabase.rpc('setter_board', { p_days: days }).then(({ data, error }) => { if (!live) return; if (error) setErr(error.message); else setD(data); }); return () => { live = false; }; }, [days]);
  if (err) return <div className="card"><div className="msg err">{err}</div></div>;
  if (!d) return <div className="card"><div className="empty">Loading…</div></div>;
  const P = d.people || []; const setters = P.filter((p) => p.is_setter);
  const who = (id) => first((people || []).find((p) => p.id === id)) || '';
  const sum = (f) => setters.reduce((a, p) => a + (f(p) || 0), 0);
  const rate = (a, b) => (b ? a / b : null);
  const tot = { dials: sum((p) => p.range.dials), connects: sum((p) => p.range.connects), booked: sum((p) => p.meetings.booked - p.meetings.canceled), held: sum((p) => p.meetings.held), noShow: sum((p) => p.meetings.no_show), upcoming: sum((p) => p.meetings.upcoming) };
  return (
    <>
      <div className="opsbar"><span className="seg tight">{RANGES.map(([k, l]) => <button key={k} className={days === k ? 'on' : ''} onClick={() => setDays(k)}>{l}</button>)}</span></div>
      <div className="card"><div className="glance setters">
        <div><small>Setters</small><b>{setters.length}</b></div>
        <div><small>Dials</small><b>{num(tot.dials)}</b></div>
        <div><small>Reached a person</small><b>{tot.dials ? pct(tot.connects / tot.dials) : '—'}</b></div>
        <div><small>Calls booked</small><b>{num(tot.booked)}</b></div>
        <div><small>On the calendar</small><b>{num(tot.upcoming)}</b></div>
        <div><small>Showed up</small><b>{tot.held + tot.noShow ? pct(tot.held / (tot.held + tot.noShow)) : '—'}</b></div>
      </div></div>
      <div className="card">
        {setters.length === 0 && <p className="hint">No setters are assigned to you yet. Derek sets that under Admin → Team.</p>}
        {P.length === 0 ? <div className="empty">Nothing to show.</div> : (
          <div className="tablewrap"><table className="ordertable fin setterstable">
            <thead><tr><th>Who</th><th className="n">Today</th><th className="n">Dials</th><th className="n">Reached</th><th className="n">Booked</th><th className="n">Per 100 dials</th><th className="n">Coming up</th><th className="n">Showed</th><th className="n">On the phone</th><th className="n">Last call</th></tr></thead>
            <tbody>{P.map((p) => { const booked = p.meetings.booked - p.meetings.canceled; const shows = p.meetings.held + p.meetings.no_show; return [
              <tr key={p.id} className={`click ${open === p.id ? 'hl' : ''}`} onClick={() => setOpen(open === p.id ? null : p.id)}>
                <td><b>{p.name}</b><div className="sm">{p.is_setter ? (p.closer_id ? `sets for ${p.closer_id === me.id ? 'you' : who(p.closer_id)}` : 'setter · no closer yet') : p.id === me.id ? 'you' : 'closer'}</div></td>
                <td className="n">{p.today.dials}{p.today.booked ? <span className="statuspill ok" style={{ marginLeft: 6 }}>{p.today.booked} booked</span> : null}</td>
                <td className="n">{num(p.range.dials)}</td>
                <td className="n">{p.range.dials ? pct(p.range.connects / p.range.dials) : '—'}{p.range.dm ? <div className="sm">{num(p.range.dm)} decision-maker{p.range.dm === 1 ? '' : 's'}</div> : null}</td>
                <td className="n"><b>{num(booked)}</b></td>
                <td className="n">{p.range.dials ? ((booked / p.range.dials) * 100).toFixed(1) : '—'}</td>
                <td className="n">{num(p.meetings.upcoming)}</td>
                <td className="n">{shows ? pct(rate(p.meetings.held, shows)) : '—'}{p.meetings.unmarked ? <div className="sm">{p.meetings.unmarked} not marked</div> : null}</td>
                <td className="n">{p.session_seconds ? hhmm(p.session_seconds) : '—'}</td>
                <td className="n sm">{p.range.last_call_at ? ago(p.range.last_call_at) : '—'}</td>
              </tr>,
              open === p.id && <tr key={`${p.id}-d`} className="detailrow"><td colSpan={10}>
                <div className="setterdetail">
                  <div><h4>Coming up</h4>{p.upcoming.length === 0 ? <div className="sm">Nothing booked.</div> : <ul className="uplist">{p.upcoming.map((u) => <li key={u.id}><b>{fmtWhen(u.starts_at)}</b><span>{u.invitee || u.name}</span><span className="sm">with {u.closer}{u.invite_sent ? ' · invite sent' : ' · no invite'}</span></li>)}</ul>}</div>
                  <div><h4>Last calls</h4>{p.recent.length === 0 ? <div className="sm">No calls yet.</div> : <ul className="feed">{p.recent.map((c) => <li key={c.id} className={c.outcome === 'booked' ? 'ok' : ''}><span className="sm">{ago(c.at)}</span><b>{c.company || '—'}</b><span>{outcomeLabel(c.outcome)}{c.seconds > 30 ? ` · ${Math.round(c.seconds / 60)} min` : ''}{c.note ? ` · ${c.note}` : ''}</span></li>)}</ul>}</div>
                </div>
              </td></tr>,
            ]; })}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

/* =================== a closer's bookable hours (Settings) =================== */
const DOW = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];
const ZONES = [['America/New_York', 'Eastern'], ['America/Chicago', 'Central'], ['America/Denver', 'Mountain'], ['America/Los_Angeles', 'Pacific']];
const DEFAULT_AV = { tz: 'America/New_York', days: [1, 2, 3, 4, 5], start_min: 540, end_min: 1020, slot_min: 20, step_min: 30, notice_min: 60, horizon_days: 14, location: '' };
const toHM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fromHM = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
export function Availability({ me, say }) {
  const [a, setA] = useState(null); const [saved, setSaved] = useState(false); const [busy, setBusy] = useState(false);
  useEffect(() => { supabase.from('sales_availability').select('*').eq('user_id', me.id).maybeSingle().then(({ data }) => { setA(data ? { ...DEFAULT_AV, ...data, location: data.location || '' } : DEFAULT_AV); setSaved(!!data); }); }, [me.id]);
  if (!a) return null;
  const set = (k, v) => setA({ ...a, [k]: v });
  const save = async () => {
    if (a.end_min <= a.start_min) return say({ error: 'The last call has to end after the first one starts.' });
    setBusy(true);
    const { error } = await supabase.from('sales_availability').upsert({ user_id: me.id, tz: a.tz, days: a.days, start_min: a.start_min, end_min: a.end_min, slot_min: Number(a.slot_min) || 20, step_min: Number(a.step_min) || 30, notice_min: Number(a.notice_min) || 0, horizon_days: Number(a.horizon_days) || 14, location: a.location.trim() || null, updated_at: new Date().toISOString() });
    setBusy(false); say(error ? { error: error.message } : null, 'Saved. Setters see these times now.'); if (!error) setSaved(true);
  };
  return (
    <div className="card">
      <div className="cardhead"><h3>When I take booked calls</h3>{!saved && <span className="sm">not saved yet · weekdays 9 to 5 Eastern until you save</span>}<div className="spacer" /><button className="btn-sm primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>
      <div className="availgrid">
        <div className="wide"><span className="lbl">Days</span><div className="daypick">{DOW.map(([k, l]) => <button key={k} type="button" className={a.days.includes(k) ? 'on' : ''} onClick={() => set('days', a.days.includes(k) ? a.days.filter((x) => x !== k) : [...a.days, k].sort())}>{l}</button>)}</div></div>
        <label>First call<input type="time" value={toHM(a.start_min)} onChange={(e) => set('start_min', fromHM(e.target.value))} /></label>
        <label>Done by<input type="time" value={toHM(a.end_min === 1440 ? 1439 : a.end_min)} onChange={(e) => set('end_min', fromHM(e.target.value))} /></label>
        <label>Time zone<select value={a.tz} onChange={(e) => set('tz', e.target.value)}>{ZONES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>Call length (min)<input type="number" min="5" max="240" value={a.slot_min} onChange={(e) => set('slot_min', e.target.value)} /></label>
        <label>A slot every (min)<input type="number" min="5" max="240" value={a.step_min} onChange={(e) => set('step_min', e.target.value)} /></label>
        <label>Soonest (min from now)<input type="number" min="0" value={a.notice_min} onChange={(e) => set('notice_min', e.target.value)} /></label>
        <label>How far out (days)<input type="number" min="1" max="90" value={a.horizon_days} onChange={(e) => set('horizon_days', e.target.value)} /></label>
        <label className="wide">Where it happens<input value={a.location} placeholder="Leave blank for a phone call, or paste your Zoom / Meet link" onChange={(e) => set('location', e.target.value)} /></label>
      </div>
    </div>
  );
}
