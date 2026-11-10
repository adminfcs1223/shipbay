// Appointment setting (Derek, 2026-11-10): setters dial and book calls for the closer they are assigned to.
// Everything that changes data goes through a database function, so a call is one transaction on the server:
//   log_call      the dial and every effect on the lead (safe to retry: client_id)
//   setter_board  what a closer sees about their setters
// Appointments are booked in Calendly, embedded here; the "appt" edge function reads each booking back from Calendly and
// records it on the lead, with the setter as a guest on the invite so the call is on both calendars.
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase, fn } from '../../lib';
import { ago, hhmm, mmss, num, pct } from './util';

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

/* =================== booking: Calendly =================== */
// Appointments are booked in Calendly (Derek, 2026-11-10). The closer's Calendly page is embedded; Calendly owns the
// availability, the invite, the reminders and the meeting link. The setter is added as a guest, so the call is on both
// calendars. When Calendly says a booking was made, the server reads it back from Calendly and records it on the lead.
export async function cancelMeeting(meeting_id, reason) {
  const r = await fn('appt', { action: 'cancel', meeting_id, reason: reason || '' });
  return r.error ? { error: r.error } : { ok: true };
}

/** The closer a booking goes to: a setter books for their closer; a closer books for themselves unless they pick someone. */
export function useCloser(me, people) {
  const locked = isSetter(me) && !!me.closer_id;
  const [closerId, setCloserId] = useState(() => (isSetter(me) ? me.closer_id || '' : me?.id || ''));
  useEffect(() => { if (!closerId && people?.length && !isSetter(me)) setCloserId(people.find((p) => p.id === me.id)?.id || people[0].id); }, [people?.length]);
  const closer = (people || []).find((p) => p.id === closerId) || null;
  return { closerId, setCloserId, closer, locked };
}

let calendlyScript = null;
const loadCalendly = () => calendlyScript || (calendlyScript = new Promise((res, rej) => {
  if (window.Calendly) return res();
  const s = document.createElement('script'); s.src = 'https://assets.calendly.com/assets/external/widget.js'; s.async = true;
  s.onload = () => res(); s.onerror = () => { calendlyScript = null; rej(new Error('Calendly did not load')); };
  document.head.appendChild(s);
}));

/** What the setter sees once Calendly confirmed and the portal recorded it. */
function Booked({ r, lead, onDone }) {
  const m = r.meeting || {};
  return (
    <div className="booked">
      <div className="booked-when">{fmtWhen(m.starts_at)}</div>
      <div className="booked-who">{lead.company || lead.domain || lead.email} with {(m.closer_name || r.host_name || '').split(' ')[0] || 'the closer'}{m.invitee_email ? ` · Calendly sent the invite to ${m.invitee_email}` : ''}</div>
      {r.setter_calendar === 'calendly' && <div className="sm">You are on the invite as a guest. It is on your calendar too.</div>}
      {r.setter_calendar === 'email' && <div className="note warn">Calendly did not add you as a guest (that event type has to allow guests), so a calendar invite with the join link was emailed to you instead.</div>}
      {r.setter_calendar === 'failed' && <div className="note warn">You are not on the invite: Calendly did not add you as a guest and the backup email did not go ({r.setter_note}). Add it to your calendar by hand.</div>}
      {r.join_url && <div className="sm"><a href={r.join_url} target="_blank" rel="noreferrer">Join link ↗</a></div>}
      {onDone && <div className="row"><div className="spacer" /><button type="button" className="btn-sm primary" onClick={onDone}>Done</button></div>}
    </div>
  );
}

/** The closer's Calendly page, with the lead filled in and the setter added as a guest. Used in the Book tab and in the
 *  "Book a call" dialog during a dial. */
export function BookForm({ me, lead, people, onBooked, onCancel }) {
  const { closerId, setCloserId, closer, locked } = useCloser(me, people);
  const [link, setLink] = useState(null); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false); const [done, setDone] = useState(null);
  const [note, setNote] = useState(''); const [email, setEmail] = useState(lead?.email || ''); const [widget, setWidget] = useState('loading');
  const box = useRef(null); const noteRef = useRef(''); noteRef.current = note;
  useEffect(() => { setEmail(lead?.email || ''); setDone(null); setErr(null); }, [lead?.id]);
  useEffect(() => { let live = true; setLink(null); setErr(null); fn('appt', { action: 'calendly_link', closer_id: closerId || '' }).then((r) => { if (!live) return; if (r.error) setErr(r.error); else setLink(r); }); return () => { live = false; }; }, [closerId]);
  // the setter rides along as a guest unless they are the host of that Calendly page themselves
  const iAmHost = link ? (link.own ? closer?.id === me.id : !!me.is_owner) : false;
  const pageUrl = useMemo(() => {
    if (!link?.url) return '';
    try { const u = new URL(link.url); u.searchParams.set('hide_gdpr_banner', '1'); if (!iAmHost && me.email) u.searchParams.set('guests', me.email); return u.toString(); } catch { return ''; }
  }, [link?.url, iAmHost, me.email]);
  useEffect(() => {
    if (!pageUrl || done || !box.current) return undefined; let live = true; setWidget('loading');
    loadCalendly().then(() => {
      if (!live || !box.current) return; box.current.innerHTML = '';
      window.Calendly.initInlineWidget({ url: pageUrl, parentElement: box.current, prefill: { name: lead.contact_name || '', email: lead.email || '' },
        utm: { utmSource: 'shipbay-portal', utmMedium: isSetter(me) ? 'setter' : 'closer', utmContent: lead.id, utmTerm: me.id } });
      setWidget('ready');
    }).catch(() => { if (live) setWidget('failed'); });
    return () => { live = false; };
  }, [pageUrl, lead?.id, done]);
  const finish = (r) => { setBusy(false); if (r.error) { setErr(r.error); return; } setErr(null); setDone(r); onBooked?.(r.meeting, r); };
  useEffect(() => {
    const onMsg = (e) => {
      if (e.origin !== 'https://calendly.com' || e.data?.event !== 'calendly.event_scheduled' || done) return;
      setBusy(true);
      fn('appt', { action: 'calendly_booked', lead_id: lead.id, closer_id: closerId || '', event_uri: e.data.payload?.event?.uri || '', invitee_uri: e.data.payload?.invitee?.uri || '', note: noteRef.current }).then(finish);
    };
    window.addEventListener('message', onMsg); return () => window.removeEventListener('message', onMsg);
  }, [lead?.id, closerId, done]);
  const find = () => { setBusy(true); fn('appt', { action: 'calendly_find', lead_id: lead.id, closer_id: closerId || '', email: email.trim(), note }).then(finish); };
  if (done) return <Booked r={done} lead={lead} onDone={onCancel} />;
  return (
    <div className="bookform">
      {locked ? <div className="bookfor one">For <b>{closer ? (closer.full_name || closer.email) : 'your closer'}</b>{link && !link.own ? <span className="sm"> · no Calendly link of their own yet, so this is {link.whose}’s Calendly and the call goes to whoever hosts it</span> : null}</div>
        : isSetter(me) ? <div className="bookfor"><span className="note warn">No closer is assigned to you yet. Pick who takes it.</span><CloserPick people={people} value={closerId} onChange={setCloserId} me={me} /></div>
        : (people || []).length > 1 ? <div className="bookfor"><CloserPick people={people} value={closerId} onChange={setCloserId} me={me} />{link && !link.own ? <span className="sm">No Calendly link saved for them yet: this is {link.whose}’s Calendly, and the call goes to whoever hosts it.</span> : null}</div> : null}
      <textarea rows={2} placeholder="For the closer: what they said, what to price… (write it before you confirm the time)" value={note} onChange={(e) => setNote(e.target.value)} />
      {err && <div className="msg err">{err}</div>}
      {busy && <div className="msg ok">Calendly confirmed. Recording it on the lead…</div>}
      <div className="calbox" ref={box} />
      {!link && !err && <div className="empty">Opening Calendly…</div>}
      {widget === 'failed' && pageUrl && <div className="note warn">Calendly did not load here. <a href={pageUrl} target="_blank" rel="noreferrer">Open it in a new tab ↗</a>, book it, then press Find the booking.</div>}
      <div className="row findrow">
        <span className="sm">Booked, but this screen did not change?</span>
        <input type="email" value={email} placeholder="email the booking was made with" spellCheck={false} onChange={(e) => setEmail(e.target.value)} />
        <button type="button" className="btn-sm" disabled={busy || !email.trim()} onClick={find}>Find the booking</button>
        <div className="spacer" />
        {onCancel && <button type="button" className="btn-sm" onClick={onCancel}>Close</button>}
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
    <div className="overlay top" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal dbr calmodal">
        <div className="dbr-head"><div><h3>{lead.company || lead.domain || lead.email}</h3><span className="sm">{[lead.contact_name, lead.phone, lead.email].filter(Boolean).join(' · ')}</span></div></div>
        <BookForm me={me} lead={lead} people={people} onBooked={onBooked} onCancel={onClose} />
      </div>
    </div>
  );
}

/* =================== the Book tab =================== */
export function Book({ me, leads, people, say, reload, renderAdd }) {
  const [q, setQ] = useState(''); const [lead, setLead] = useState(null); const [mtgs, setMtgs] = useState(null); const [busy, setBusy] = useState(null); const [adding, setAdding] = useState(false);
  const load = async () => { const { data } = await supabase.from('sales_meetings').select('*').neq('status', 'canceled').gte('starts_at', new Date(Date.now() - 3600000).toISOString()).order('starts_at').limit(200); setMtgs(data || []); };
  useEffect(() => { load(); }, []);
  const hits = useMemo(() => { const t = q.trim().toLowerCase(); if (t.length < 2) return []; return (leads || []).filter((l) => l.stage !== 'dnc' && [l.company, l.domain, l.contact_name, l.email, l.phone].filter(Boolean).some((v) => v.toLowerCase().includes(t))).slice(0, 8); }, [q, leads]);
  const who = (id) => first((people || []).find((p) => p.id === id)) || '—';
  const mine = (mtgs || []).filter((m) => m.booked_by === me.id || m.assigned_to === me.id);
  const cancel = async (m) => {
    const why = window.prompt('Cancel this call? Calendly tells the prospect and the closer. Reason (optional):', ''); if (why === null) return;
    setBusy(m.id); const r = await cancelMeeting(m.id, why); setBusy(null);
    say(r.error ? r : null, 'Canceled. Calendly told both sides.'); load(); reload?.();
  };
  // a client who was not on any list: add them, then book
  const openExisting = (id) => { const l = (leads || []).find((x) => x.id === id); if (l) setLead(l); else say({ error: 'That company is already in the system and belongs to someone else. Ask them, or Derek, to book it.' }); };
  return (
    <div className="bookgrid">
      <div className="card">
        <div className="cardhead"><h3>Book a call</h3><div className="spacer" />{!lead && renderAdd && <button className="btn-sm" onClick={() => setAdding(true)}>Add a client</button>}</div>
        {!lead ? (
          <div className="bookfind">
            <input className="search" autoFocus placeholder="Who is it for? Company, name, email or phone…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) { setLead(hits[0]); setQ(''); } }} />
            {hits.length > 0 && <ul className="uplist">{hits.map((l) => <li key={l.id} onClick={() => { setLead(l); setQ(''); }}><b>{l.company || l.domain || l.email}</b><span>{[l.contact_name, l.email, l.phone].filter(Boolean).join(' · ')}</span></li>)}</ul>}
            {q.trim().length >= 2 && hits.length === 0 && <div className="empty">Not on your list.{renderAdd && <> <button className="btn-sm primary" onClick={() => setAdding(true)}>Add them as a client</button></>}</div>}
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
                <span className="sm">{m.assigned_to === me.id ? (m.booked_by && m.booked_by !== me.id ? `booked by ${who(m.booked_by)}` : 'yours') : `with ${who(m.assigned_to)}`}{/^https?:/.test(m.location || '') && <> · <a href={m.location} target="_blank" rel="noreferrer">Join ↗</a></>}</span></div>
              <div className="acts">{m.reschedule_url && <a className="btn-xs" href={m.reschedule_url} target="_blank" rel="noreferrer">Reschedule</a>}<button className="btn-xs bad" disabled={busy === m.id} onClick={() => cancel(m)}>Cancel</button></div>
            </li>
          ))}</ul>
        )}
      </div>
      {adding && renderAdd?.({ onClose: () => setAdding(false), onCreated: (l) => { setAdding(false); setQ(''); setLead(l); }, openExisting })}
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

/* =================== a closer's Calendly link (Settings) =================== */
export function CalendlyLink({ me, say }) {
  const [url, setUrl] = useState(''); const [saved, setSaved] = useState(''); const [team, setTeam] = useState(null); const [busy, setBusy] = useState(false);
  useEffect(() => {
    supabase.from('sales_availability').select('calendly_url').eq('user_id', me.id).maybeSingle().then(({ data }) => { setUrl(data?.calendly_url || ''); setSaved(data?.calendly_url || ''); });
    fn('appt', { action: 'calendly_link', closer_id: me.id }).then((r) => setTeam(r));
  }, [me.id]);
  const save = async () => {
    const v = url.trim();
    if (v && !/^https:\/\/calendly\.com\/[^/\s]+\/[^/\s]+/.test(v)) return say({ error: 'Paste the link to one event, like https://calendly.com/your-name/intro-call. A profile link (no event after the name) will not pre-fill the prospect.' });
    setBusy(true); const { error } = await supabase.from('sales_availability').upsert({ user_id: me.id, calendly_url: v || null, updated_at: new Date().toISOString() }); setBusy(false);
    say(error ? { error: error.message } : null, v ? 'Saved. Setters now book on this Calendly page.' : 'Removed. Bookings for you fall back to the team link.'); if (!error) setSaved(v);
  };
  return (
    <div className="card">
      <div className="cardhead"><h3>My Calendly link</h3><span className="sm">{saved ? 'setters book your calls here' : team?.url ? `none saved · bookings for you use ${team.whose === 'the team link' ? 'the team link' : `${team.whose}’s Calendly`}` : 'none saved'}</span><div className="spacer" /><button className="btn-sm primary" disabled={busy || url.trim() === saved} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>
      <label className="dbr-to"><b>Event link</b><input value={url} placeholder="https://calendly.com/your-name/intro-call" spellCheck={false} onChange={(e) => setUrl(e.target.value)} /></label>
      {!saved && team?.url && <div className="sm" style={{ marginTop: 8 }}>Right now: <a href={team.url} target="_blank" rel="noreferrer">{team.url.replace(/^https?:\/\//, '')}</a></div>}
    </div>
  );
}

/* =================== the team script (Admin → Admin settings → Call script) =================== */
export function TeamScript({ me, fill }) {
  const [rows, setRows] = useState(null); const [people, setPeople] = useState([]); const [body, setBody] = useState(''); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(null); const [open, setOpen] = useState(null);
  const load = async () => {
    const [s, p] = await Promise.all([supabase.from('sales_scripts').select('*').order('updated_at', { ascending: false }), supabase.from('profiles').select('id, full_name, email, role').like('role', 'shipbay%')]);
    setRows(s.data || []); setPeople(p.data || []); setBody((s.data || []).find((r) => !r.owner_id)?.body || '');
  };
  useEffect(() => { load(); }, []);
  if (rows === null) return <div className="card"><div className="empty">Loading…</div></div>;
  const team = rows.find((r) => !r.owner_id); const own = rows.filter((r) => r.owner_id);
  const name = (id) => { const p = people.find((x) => x.id === id); return p ? (p.full_name || p.email) : 'someone'; };
  const save = async () => {
    setBusy(true); setMsg(null);
    const row = { body, updated_at: new Date().toISOString(), updated_by: me.id };
    const { error } = team ? await supabase.from('sales_scripts').update(row).eq('id', team.id) : await supabase.from('sales_scripts').insert({ ...row, owner_id: null });
    setBusy(false); setMsg(error ? { kind: 'err', text: error.message } : { kind: 'ok', text: 'Saved. Everyone without their own version sees this now.' }); if (!error) load();
  };
  const remove = async (r) => { if (!window.confirm(`Remove ${name(r.owner_id)}’s own version? They go back to the team script.`)) return; const { error } = await supabase.from('sales_scripts').delete().eq('id', r.id); setMsg(error ? { kind: 'err', text: error.message } : null); load(); };
  const sample = { contact_name: 'Jordan Lee', company: 'Vinyl Moons' };
  return (
    <>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}
      <div className="card script">
        <div className="cardhead"><h3>Team call script</h3><span className="sm">{team?.updated_at ? `last saved ${ago(team.updated_at)}${team.updated_by ? ` by ${name(team.updated_by).split(' ')[0]}` : ''}` : 'not written yet'}</span><div className="spacer" /><button className="btn-sm primary" disabled={busy || body === (team?.body || '')} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>
        <div className="tplgrid">
          <div>
            <textarea className="scriptedit" rows={24} value={body} onChange={(e) => setBody(e.target.value)} spellCheck />
            <div className="row"><span className="sm">Fills in on the caller’s screen: <code>{'{first}'}</code> <code>{'{company}'}</code> <code>{'{me}'}</code> <code>{'{closer}'}</code> <code>{'{booking}'}</code></span></div>
          </div>
          <div className="tplpreview"><small>What a setter sees · calling Jordan Lee at Vinyl Moons</small><pre className="scriptbody">{fill(body, sample, { full_name: 'Maya Torres' }, '', 'Xavier')}</pre></div>
        </div>
      </div>
      <div className="card">
        <div className="cardhead"><h3>Own versions</h3><span className="sm">{own.length}</span></div>
        {own.length === 0 ? <div className="empty">Nobody has changed the script for themselves. Everyone sees the team script.</div> : (
          <table className="ordertable fin"><thead><tr><th>Who</th><th>Changed</th><th /></tr></thead><tbody>{own.map((r) => [
            <tr key={r.id}><td><b>{name(r.owner_id)}</b><div className="sm">{people.find((p) => p.id === r.owner_id)?.role === 'shipbay_setter' ? 'setter' : 'closer · their setters see this one'}</div></td><td className="sm">{ago(r.updated_at)}</td>
              <td className="n"><button className="btn-xs" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide' : 'Read'}</button> <button className="btn-xs bad" onClick={() => remove(r)}>Remove</button></td></tr>,
            open === r.id && <tr key={`${r.id}-b`} className="detailrow"><td colSpan={3}><pre className="scriptbody">{r.body}</pre></td></tr>,
          ])}</tbody></table>
        )}
      </div>
    </>
  );
}
