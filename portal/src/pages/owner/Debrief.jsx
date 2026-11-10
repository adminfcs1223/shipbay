// Post-call debrief (Derek, 2026-11-02; rev 4 2026-11-10): the answers after every dial, each one a knob on the next list cut.
// Stored on sales_calls (every answer) and sales_leads (the durable ones). The rep sees only the questions that apply.
// Rev 4 (Derek, 11-10 — "build everything from within the portal"): the last question "Send the email?" is a real composer.
// The email goes out from the rep's own address (their Gmail when it's connected, otherwise Resend as their @shipbay3pl.com
// with reply-to them). No HubSpot, no Power sequence. A CCE lead's first email is the rep's own, after the call.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib';
import { ownerFn, pct } from './util';
import { listName, useReplyKit, fillTpl } from './Sales';
import { logCall, sendInvite, SlotPicker, useCloser, fmtWhen } from './Appt';

export const DIAL = [['no_answer', 'No answer'], ['voicemail', 'Voicemail'], ['bad_number', 'Bad number'], ['gatekeeper', 'Gatekeeper'], ['decision_maker', 'Reached decision-maker']];
export const PICKED = [['owner_founder', 'Owner / founder'], ['ops', 'Ops'], ['cs', 'Customer service'], ['retail_floor', 'Retail floor']];
export const NOT_FIT = [['on_3pl', 'Already on a 3PL'], ['ships_own_store', 'Ships from own store / retail'], ['too_small', 'Too small'], ['too_big', 'Too big'], ['product_type', 'Product type (food, heavy, hazmat, furniture)'], ['out_of_region', 'Out of region'], ['amazon_only', 'Amazon-only'], ['dormant', 'Dormant'], ['b2b_only', 'B2B-only']];
export const SETUP = [['self_shipstation', 'Self-ship · ShipStation'], ['self_shippo', 'Self-ship · Shippo'], ['self_pirateship', 'Self-ship · Pirate Ship'], ['self_veeqo', 'Self-ship · Veeqo'], ['self_other', 'Self-ship · other'], ['threepl', '3PL'], ['hybrid', 'Hybrid'], ['fba', 'FBA']];
export const PAIN = [['space', 'Space'], ['time', 'Time'], ['q4', 'Q4'], ['cost', 'Cost'], ['moving', 'Moving'], ['none', 'None']];
export const RESULT = [['booked', 'Booked'], ['callback', 'Callback'], ['send_info', 'Send info'], ['soft_no', 'Soft no'], ['hard_no', 'Hard no (DNC)']];
export const EMAIL = [['nothing', 'Nothing yet'], ['replied', 'Replied'], ['bounced', 'Bounced']];   // legacy values still in sales_calls.email_result; the UI no longer asks
/** Quick path (nobody picked up): the one decision is whether the rep's email goes out now. */
export const YESNO = [['yes', 'Yes'], ['no', 'No']];
const NO_PICKUP = ['no_answer', 'voicemail'];
/** Outcomes after which the email question is pointless: they booked, said never, or aren't a fit. */
const NO_EMAIL_AFTER = ['booked', 'hard_no'];
const THIRD_PARTY = ['agency', 'fulfill', 'fulfilment'];

/** Why the rep can't email this lead right now, or null if they can. */
export function powerBlock(lead) {
  if (!lead) return 'no lead';
  if (lead.sequence === 'blitz' || lead.power_enrolled_at) return 'in a sequence';
  if (THIRD_PARTY.includes(lead.source || '')) return 'third-party';
  if (['dnc', 'lost', 'signed', 'won'].includes(lead.stage || 'new')) return lead.stage;
  if (!lead.email) return 'no email';
  return null;
}

/** Send one email from the rep (their Gmail if connected, else Resend as them). The server logs the send on the lead. */
export async function sendRepEmail({ to, subject, body, lead }) {
  const r = await ownerFn({ action: 'rep_send', to, subject, body, lead_id: lead?.id || null });
  return r?.error ? { error: r.error } : r;
}

/** Pre-filled draft from the rep's own template (Sales → Settings → My auto email). */
export const draftFor = (kit, lead, me) => ({ to: lead?.email || '', subject: fillTpl(kit.tpl.reply_subject, lead, me, kit.booking) || 'Following up', body: fillTpl(kit.tpl.reply_body, lead, me, kit.booking) + (kit.tpl.signature ? `\n${fillTpl(kit.tpl.signature, lead, me, kit.booking)}` : '') });

/** The composer: to / subject / body, sends as the rep. */
export function RepCompose({ draft, setDraft, me, lead, sending }) {
  const toOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.to || '');
  return (
    <div className="dbr-compose">
      <label className="dbr-to"><b>To</b><input type="email" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value.trim() })} spellCheck={false} disabled={sending} /><b>from</b><span>{me?.email}</span></label>
      {draft.to && lead?.email && draft.to.toLowerCase() !== lead.email.toLowerCase() && <span className="sm">{toOk ? `Saves ${draft.to} as their email, then sends.` : 'That doesn\u2019t look like an email address.'}</span>}
      <label className="dbr-to"><b>Subject</b><input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} disabled={sending} /></label>
      <textarea rows={9} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} disabled={sending} />
      <span className="sm">Sent as you; replies land in your inbox. Edit the default under Sales → Settings → My auto email.</span>
    </div>
  );
}

/** The one button on the Calls card and the lead panel: email the lead now, as yourself. (Exported as PowerButton so older screens keep working.) */
export function PowerButton({ lead, me, note, onDone, say }) {
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const kit = useReplyKit(me);
  const [draft, setDraft] = useState(null);
  const block = powerBlock(lead);
  if (block === 'third-party') return null;
  if (block === 'in a sequence') return <span className="pill navy">In a sequence</span>;
  if (block) return <button className="btn-sm" disabled title={block === 'no email' ? 'No email on file' : `Not while the lead is ${block.replace('_', ' ')}`}>Email</button>;
  const start = () => { setDraft(draftFor(kit, lead, me)); setOpen(true); };
  const send = async () => {
    setBusy(true); const r = await sendRepEmail({ ...draft, lead }); setBusy(false);
    if (r.error) return say?.({ error: r.error });
    if (draft.to.toLowerCase() !== (lead.email || '').toLowerCase()) await supabase.from('sales_leads').update({ email: draft.to.toLowerCase() }).eq('id', lead.id);
    say?.(null, `Sent to ${draft.to} from ${r.from || me?.email}.`); setOpen(false); onDone?.();
  };
  return (
    <>
      <button className="btn-sm" onClick={start}>{lead.first_email_at ? 'Email again' : 'Email'}</button>
      {open && draft && <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}><div className="modal dbr">
        <div className="dbr-head"><div><h3>{lead.company || lead.domain || lead.email}</h3><span className="sm">Your email, from you</span></div></div>
        <section><RepCompose draft={draft} setDraft={setDraft} me={me} lead={lead} sending={busy} /></section>
        <div className="row"><button className="btn-sm" type="button" onClick={() => setOpen(false)}>Cancel</button><div className="spacer" /><button className="btn-sm primary" type="button" disabled={busy || !draft.to || !draft.subject} onClick={send}>{busy ? 'Sending…' : 'Send'}</button></div>
      </div></div>}
    </>
  );
}

const label = (list, k) => (list.find(([x]) => x === k) || [])[1] || k || '—';

/** The outcome the boards and stages run on. The server (log_call) decides; this mirrors it for display only.
 *  A booking or a hard no counts whoever picked up, gatekeeper included. */
export function outcomeFor(a) {
  if (a.dial_result === 'no_answer') return 'no_answer';
  if (a.dial_result === 'voicemail') return 'voicemail';
  if (a.dial_result === 'bad_number') return 'wrong_number';
  if (a.result === 'booked') return 'booked';
  if (a.result === 'hard_no') return 'dnc';
  if (a.dial_result === 'gatekeeper') return 'gatekeeper';
  if (a.fit === 'not_fit') return 'not_fit';
  return 'connected';
}

/** Save one debriefed call. The call row, every effect on the lead and a booking are ONE transaction on the server
 *  (log_call), so a half-saved call cannot happen and a retry is never a second call. Email, invite and the Smartlead
 *  stop run after it; if one of those fails the call is still saved and the message says exactly what did not happen.
 *  Returns the outcome, { outcome, error } when a follow-up step failed, { saved: false, error } when nothing was saved,
 *  or { queued: true } when the connection dropped and the call is waiting in this browser. */
export async function saveDebrief({ lead, me, started, seconds, note, a, emailedNow, sessionId, meeting, clientId }) {
  const send = a.send === 'yes' && !!a.draft?.to;
  const p = {
    ...(clientId ? { client_id: clientId } : {}), lead_id: lead.id, started_at: new Date(started).toISOString(), seconds, note: note || '', session_id: sessionId || '',
    dial_result: a.dial_result || '', picked_up: a.picked_up || '', fit: a.fit || '', not_fit_reason: a.not_fit_reason || '', not_fit_detail: a.not_fit_detail || '',
    orders_month: a.orders_month || '', current_setup: a.current_setup || '', pain: a.pain || '', result: a.result || '',
    callback_at: a.result === 'callback' && a.callback_at ? new Date(a.callback_at).toISOString() : '', to_email: send ? a.draft.to : '',
    meeting_id: a.result === 'booked' && meeting ? meeting.id : '',
    ...(a.result === 'booked' && !meeting && a.book_at ? { book: { closer_id: a.book_for || '', starts_at: a.book_at, invitee_email: a.book_email || '' } } : {}),
  };
  const r = await logCall(p);
  if (r.error) return { saved: false, error: r.error };
  if (r.queued) return { queued: true };
  const problems = [];
  if (r.meeting_id && !meeting) { const inv = await sendInvite(r.meeting_id); if (inv?.error) problems.push(`The call is on the calendar, but the invite did not go: ${inv.error}`); }
  if (send && !['booked', 'dnc', 'not_fit'].includes(r.outcome)) {
    const m = await sendRepEmail({ to: a.draft.to, subject: a.draft.subject, body: a.draft.body, lead });
    await supabase.rpc('call_email_result', { p_call: r.call_id, p_result: m.error ? 'failed' : 'sent' });
    if (m.error) problems.push(`Call saved, but the email didn't go: ${m.error}`);
  }
  if (emailedNow && !lead.first_email_at) await supabase.from('sales_leads').update({ first_email_at: new Date().toISOString() }).eq('id', lead.id);
  if (r.outcome === 'dnc' && lead.email) { const stop = await ownerFn({ action: 'smartlead_stop_lead', email: lead.email }); if (stop?.error) problems.push(`Marked do-not-contact here, but the email campaign did not confirm the stop: ${stop.error}`); }
  return problems.length ? { outcome: r.outcome, error: problems.join(' ') } : r.outcome;
}

function Pick({ options, value, onChange, cols = 3 }) {
  return <div className="dbr-pick" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>{options.map(([k, l]) => <button key={k} type="button" className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{l}</button>)}</div>;
}

/** The modal. Quick path for no-answer / voicemail / bad number; full path when a human picked up. */
export function Debrief({ lead, me, people = [], seconds, note, setNote, emailedNow, onSave, onCancel, saving = false, meeting = null }) {
  const kit = useReplyKit(me); const book = useCloser(me, people);
  const [a, setA] = useState({ dial_result: '', picked_up: '', fit: '', not_fit_reason: '', not_fit_detail: '', orders_month: '', current_setup: '', pain: '', result: '', callback_at: '', send: '', to_email: lead.email || '', email_result: '', draft: null, book_for: '', book_at: '', book_email: lead.email || '' });
  const setDraft = (d) => setA((x) => ({ ...x, draft: d, to_email: d.to }));
  const set = (k) => (v) => setA((x) => ({ ...x, [k]: v }));
  const human = a.dial_result === 'gatekeeper' || a.dial_result === 'decision_maker';
  const quick = ['no_answer', 'voicemail', 'bad_number'].includes(a.dial_result);
  const inSeq = !!(lead.sequence === 'blitz' || lead.power_enrolled_at);
  // The last question, always: send your email now? Not after a booking, a hard no, a not-fit, or a bad number — and not if they're in the Blitz.
  const askSend = !!lead.email && !inSeq && (NO_PICKUP.includes(a.dial_result) || (human && !!a.result && !NO_EMAIL_AFTER.includes(a.result) && a.fit !== 'not_fit'));
  const toOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.to_email || '');
  const sendDone = !askSend || (a.send === 'no') || (a.send === 'yes' && !!a.draft && toOk && !!a.draft.subject);
  const bookDone = a.result !== 'booked' || !!meeting || (!!book.closerId && !!a.book_at);
  const canSave = !!a.dial_result && sendDone && bookDone && (quick || (a.dial_result === 'gatekeeper' ? !!a.result : !!a.picked_up && !!a.fit && (a.fit !== 'not_fit' || !!a.not_fit_reason) && !!a.result));
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onCancel(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onCancel]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal dbr">
        <div className="dbr-head"><div><h3>{lead.company || lead.domain}</h3><span className="sm">{listName(lead.filter_id)} · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')} on the call</span></div></div>
        <section><div className="dbr-q">1 · Dial result</div><Pick options={DIAL} value={a.dial_result} onChange={set('dial_result')} cols={5} /></section>
        {a.dial_result === 'decision_maker' && <>
          <section><div className="dbr-q">2 · Who picked up</div><Pick options={PICKED} value={a.picked_up} onChange={set('picked_up')} cols={4} /></section>
          <section><div className="dbr-q">3 · Fit</div>
            <Pick options={[['fit', 'A fit'], ['not_fit', 'Not a fit'], ['unknown', 'Not sure yet']]} value={a.fit} onChange={set('fit')} />
            {a.fit === 'not_fit' && <div className="dbr-sub"><Pick options={NOT_FIT} value={a.not_fit_reason} onChange={set('not_fit_reason')} />
              {['on_3pl', 'product_type'].includes(a.not_fit_reason) && <input type="text" placeholder={a.not_fit_reason === 'on_3pl' ? 'Which 3PL?' : 'Which product type?'} value={a.not_fit_detail} onChange={(e) => set('not_fit_detail')(e.target.value)} />}</div>}
          </section>
          <section className="dbr-row">
            <div><div className="dbr-q">4 · Orders a month (rough is fine)</div><input type="number" min="0" inputMode="numeric" placeholder="e.g. 400" value={a.orders_month} onChange={(e) => set('orders_month')(e.target.value)} /></div>
          </section>
          <section><div className="dbr-q">5 · How they ship today</div><Pick options={SETUP} value={a.current_setup} onChange={set('current_setup')} cols={4} /></section>
          <section><div className="dbr-q">6 · Pain they named</div><Pick options={PAIN} value={a.pain} onChange={set('pain')} cols={6} /></section>
        </>}
        {human && <section><div className="dbr-q">7 · Outcome</div><Pick options={RESULT} value={a.result} onChange={set('result')} cols={5} />
          {a.result === 'callback' && <div className="dbr-sub"><input type="datetime-local" value={a.callback_at} onChange={(e) => set('callback_at')(e.target.value)} /></div>}
          {a.result === 'booked' && (meeting
            ? <div className="dbr-sub dbr-book"><div className="booked"><div className="booked-when">{fmtWhen(meeting.starts_at)}</div><div className="booked-who">Already booked{meeting.closer_name ? ` with ${meeting.closer_name.split(' ')[0]}` : ''} during this call.</div></div></div>
            : <div className="dbr-sub dbr-book">
              {book.locked ? <div className="bookfor one">For <b>{book.closer ? (book.closer.full_name || book.closer.email) : 'your closer'}</b></div>
                : <><div className="dbr-q">Book it for</div><Pick options={(people.length ? people : [me]).map((p) => [p.id, p.id === me?.id ? `${(p.full_name || p.email || 'me').split(' ')[0]} (me)` : (p.full_name || p.email)])} value={book.closerId} onChange={(v) => { book.setCloserId(v); set('book_at')(''); }} cols={Math.min(4, Math.max(2, people.length || 1))} /></>}
              <SlotPicker closerId={book.closerId} value={a.book_at} onChange={set('book_at')} />
              <label className="dbr-to"><b>Invite to</b><input type="email" value={a.book_email} placeholder="their email" spellCheck={false} onChange={(e) => set('book_email')(e.target.value.trim())} /></label>
            </div>)}</section>}
        {askSend && <section><div className="dbr-q">{human ? '8' : '2'} · Send your email now?</div><Pick options={YESNO} value={a.send} onChange={(v) => setA((x) => ({ ...x, send: v, draft: v === 'yes' ? (x.draft || draftFor(kit, lead, me)) : null }))} cols={2} />
          {a.send === 'yes' && a.draft && <div className="dbr-sub"><RepCompose draft={a.draft} setDraft={setDraft} me={me} lead={lead} sending={saving} /></div>}
        </section>}
        {!askSend && !!lead.email && inSeq && (quick || human) && <section><span className="sm">Already in a sequence — this just logs the dial.</span></section>}
        <section><textarea rows={2} placeholder="One line: who you spoke to, what they said, when to call back…" value={note} onChange={(e) => setNote(e.target.value)} /></section>
        <div className="row"><button className="btn-sm" type="button" onClick={onCancel}>Back to the call</button><div className="spacer" /><button className="btn-sm primary" type="button" disabled={!canSave || saving} onClick={() => onSave({ ...a, book_for: book.closerId })}>{saving ? (a.send === 'yes' ? 'Sending…' : 'Saving…') : a.send === 'yes' ? 'Send & close call' : 'Close call'}</button></div>
      </div>
    </div>
  );
}

/** What the calls are saying, per list — the knobs for the next cut. */
export function DebriefBoard({ calls, leads }) {
  const rows = useMemo(() => {
    const by = {};
    for (const c of calls) { const k = c.list_id || leads.find((l) => l.id === c.lead_id)?.filter_id || '—'; (by[k] = by[k] || []).push(c); }
    const top = (C, key, list) => { const m = {}; for (const c of C) if (c[key]) m[c[key]] = (m[c[key]] || 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${label(list, k)} ${n}`).join(' · ') || '—'; };
    const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
    return Object.entries(by).map(([k, C]) => {
      const dials = C.length; const bad = C.filter((c) => c.dial_result === 'bad_number' || c.outcome === 'wrong_number').length; const dm = C.filter((c) => c.dial_result === 'decision_maker').length;
      const hours = {}; for (const c of C) if (c.hour_block != null && ['gatekeeper', 'decision_maker'].includes(c.dial_result)) hours[c.hour_block] = (hours[c.hour_block] || 0) + 1;
      const bestHour = Object.entries(hours).sort((a, b) => b[1] - a[1])[0];
      return { k, dials, bad: dials ? bad / dials : 0, dm: dials ? dm / dials : 0, notFit: top(C, 'not_fit_reason', NOT_FIT), picked: top(C, 'picked_up', PICKED), setup: top(C, 'current_setup', SETUP), pain: top(C.filter((c) => c.pain && c.pain !== 'none'), 'pain', PAIN), orders: median(C.map((c) => c.orders_month)), hour: bestHour ? `${bestHour[0]}:00` : '—', badFlag: dials >= 20 && bad / dials > 0.15 };
    }).sort((a, b) => b.dials - a.dials);
  }, [calls, leads]);
  if (!rows.length) return null;
  return (
    <div className="card">
      <h3>What the calls are saying</h3>
      <p className="hint">Per list. Bad numbers over 15% on a cut means StoreLeads phones are junk for it — source numbers from Apollo. Storefront pick-ups mean the next cut excludes Shopify POS. Not-fit reasons become app and category exclusions; orders/month calibrates the sales band; the best hour sets next week's dial order.</p>
      <table className="ordertable fin"><thead><tr><th>List</th><th className="n">Dials</th><th className="n">Bad numbers</th><th className="n">Reached DM</th><th>Who picks up</th><th>Not a fit</th><th className="n">Orders / mo (median)</th><th>Ship today</th><th>Pain</th><th>Best hour</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.k}><td><b className="mono">{r.k}</b></td><td className="n">{r.dials}</td><td className={`n ${r.badFlag ? 'neg' : ''}`}>{pct(r.bad)}{r.badFlag ? ' · junk phones' : ''}</td><td className="n">{pct(r.dm)}</td><td>{r.picked}</td><td>{r.notFit}</td><td className="n">{r.orders ?? '—'}</td><td>{r.setup}</td><td>{r.pain}</td><td>{r.hour}</td></tr>)}</tbody></table>
    </div>
  );
}
