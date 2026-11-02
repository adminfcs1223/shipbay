// Post-call debrief (Derek, 2026-11-02): nine answers after every dial. Each one maps to a knob on the next list cut.
// Stored on sales_calls (every answer) and sales_leads (the durable ones), pushed to HubSpot as call + contact properties
// by the owner function. The rep sees only the questions that apply to what happened on the dial.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib';
import { ownerFn, pct } from './util';
import { listName } from './Sales';

export const DIAL = [['no_answer', 'No answer'], ['voicemail', 'Voicemail'], ['bad_number', 'Bad number'], ['gatekeeper', 'Gatekeeper'], ['decision_maker', 'Reached decision-maker']];
export const PICKED = [['owner_founder', 'Owner / founder'], ['ops', 'Ops'], ['cs', 'Customer service'], ['retail_floor', 'Retail floor']];
export const NOT_FIT = [['on_3pl', 'Already on a 3PL'], ['ships_own_store', 'Ships from own store / retail'], ['too_small', 'Too small'], ['too_big', 'Too big'], ['product_type', 'Product type (food, heavy, hazmat, furniture)'], ['out_of_region', 'Out of region'], ['amazon_only', 'Amazon-only'], ['dormant', 'Dormant'], ['b2b_only', 'B2B-only']];
export const SETUP = [['self_shipstation', 'Self-ship · ShipStation'], ['self_shippo', 'Self-ship · Shippo'], ['self_pirateship', 'Self-ship · Pirate Ship'], ['self_veeqo', 'Self-ship · Veeqo'], ['self_other', 'Self-ship · other'], ['threepl', '3PL'], ['hybrid', 'Hybrid'], ['fba', 'FBA']];
export const PAIN = [['space', 'Space'], ['time', 'Time'], ['q4', 'Q4'], ['cost', 'Cost'], ['moving', 'Moving'], ['none', 'None']];
export const RESULT = [['booked', 'Booked'], ['callback', 'Callback'], ['send_info', 'Send info'], ['soft_no', 'Soft no'], ['hard_no', 'Hard no (DNC)']];
export const EMAIL = [['nothing', 'Nothing yet'], ['replied', 'Replied'], ['bounced', 'Bounced']];
/** Quick path (nobody picked up): the one decision is whether the email goes out. 'send' = Power sends it. */
export const SEND = [['send', 'Send the email'], ['skip', 'Not this time']];
const NO_PICKUP = ['no_answer', 'voicemail'];
const POWER_BLOCKED = ['replied', 'call_booked', 'won', 'dnc', 'lost', 'signed'];
const label = (list, k) => (list.find(([x]) => x === k) || [])[1] || k || '—';

/** the legacy outcome the scoreboards and stages run on, derived from the answers */
export function outcomeFor(a) {
  if (a.dial_result === 'no_answer') return 'no_answer';
  if (a.dial_result === 'voicemail') return 'voicemail';
  if (a.dial_result === 'bad_number') return 'wrong_number';
  if (a.dial_result === 'gatekeeper') return 'gatekeeper';
  if (a.result === 'booked') return 'booked';
  if (a.result === 'hard_no') return 'dnc';
  if (a.fit === 'not_fit') return 'not_fit';
  return 'connected';
}
const etHour = (d) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(d)) % 24;

/** Save one debriefed call: sales_calls row, lead patch, Blitz hand-off, HubSpot push. Returns the outcome. */
export async function saveDebrief({ lead, me, started, seconds, note, a, emailedNow }) {
  const outcome = outcomeFor(a);
  const now = new Date();
  const row = { lead_id: lead.id, started_at: new Date(started).toISOString(), ended_at: now.toISOString(), seconds, outcome, note: note || null, by_user: me.id, list_id: lead.filter_id || null, hour_block: etHour(new Date(started)),
    dial_result: a.dial_result || null, picked_up: a.picked_up || null, fit: a.fit || null, not_fit_reason: a.fit === 'not_fit' ? a.not_fit_reason || null : null, not_fit_detail: a.fit === 'not_fit' ? a.not_fit_detail || null : null,
    orders_month: a.orders_month ? Number(a.orders_month) : null, current_setup: a.current_setup || null, pain: a.pain || null, result: a.result || null, callback_at: a.result === 'callback' && a.callback_at ? new Date(a.callback_at).toISOString() : null, email_result: a.email_result || null };
  await supabase.from('sales_calls').insert(row);
  // the lead: attempts, next action, stage, the durable answers
  const next = { no_answer: 2, voicemail: 3, gatekeeper: 1, connected: 7 }[outcome];
  const patch = { attempts: (lead.attempts || 0) + 1, last_outcome: outcome, last_touch_at: now.toISOString(), assigned_to: lead.assigned_to || me.id, next_action_at: row.callback_at || (next ? new Date(Date.now() + next * 86400000).toISOString() : null) };
  if (row.picked_up) patch.picked_up = row.picked_up;
  if (row.orders_month != null) patch.orders_month_actual = row.orders_month;
  if (row.current_setup) patch.current_setup = row.current_setup;
  if (row.pain && row.pain !== 'none') patch.pain = row.pain;
  if (row.not_fit_reason) patch.not_fit_reason = row.not_fit_reason;
  if (outcome === 'booked') patch.stage = 'call_booked';
  else if (outcome === 'dnc') patch.stage = 'dnc';
  else if (outcome === 'not_fit') patch.stage = 'lost';
  else if (outcome === 'wrong_number') { patch.in_calls = false; patch.tags = [...new Set([...(lead.tags || []), 'bad_number'])]; }
  else if (lead.stage === 'new') patch.stage = 'contacted';
  if (a.result === 'soft_no') patch.next_action_at = new Date(Date.now() + 45 * 86400000).toISOString();
  if (note) patch.notes = [lead.notes, `${now.toLocaleDateString()} ${label(DIAL, a.dial_result)}${a.result ? ` → ${label(RESULT, a.result)}` : ''}: ${note}`].filter(Boolean).join('\n');
  if ((lead.attempts || 0) + 1 >= 4 && !['booked', 'connected', 'gatekeeper'].includes(outcome)) patch.in_calls = false;   // 4 tries with no human → park it
  // Power: nobody picked up and the rep said "send the email" → the lead is queued for the Power sequence now.
  // (The DB trigger on sales_calls does the same on email_result = 'send'; this is belt and braces so the UI reflects it instantly.)
  if (a.email_result === 'send' && NO_PICKUP.includes(a.dial_result) && !['agency', 'fulfill', 'fulfilment'].includes(lead.source || '') && !lead.sequence && !lead.power_enrolled_at && !POWER_BLOCKED.includes(lead.stage || 'new')) {
    patch.sequence = 'power'; patch.enroll_at = now.toISOString();
    if (!lead.first_email_at) patch.first_email_at = now.toISOString();
  }
  // Reached-DM outcomes (send info / callback / soft no) are parked until Derek decides whether they go to Power (lead-approaches.md Q2). Nothing is enrolled from here.
  if (emailedNow && !lead.first_email_at) patch.first_email_at = now.toISOString();
  await supabase.from('sales_leads').update(patch).eq('id', lead.id);
  if (outcome === 'dnc' && lead.email) ownerFn({ action: 'smartlead_stop_lead', email: lead.email });
  // HubSpot gets the call + the contact answers right away (the 5-minute sync would catch it anyway)
  ownerFn({ action: 'hubspot_push_one', lead_id: lead.id }).catch(() => {});
  return outcome;
}

function Pick({ options, value, onChange, cols = 3 }) {
  return <div className="dbr-pick" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>{options.map(([k, l]) => <button key={k} type="button" className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{l}</button>)}</div>;
}

/** The modal. Quick path for no-answer / voicemail / bad number; full path when a human picked up. */
export function Debrief({ lead, seconds, note, setNote, emailedNow, onSave, onCancel }) {
  const [a, setA] = useState({ dial_result: '', picked_up: '', fit: '', not_fit_reason: '', not_fit_detail: '', orders_month: '', current_setup: '', pain: '', result: '', callback_at: '', email_result: '' });
  const set = (k) => (v) => setA((x) => ({ ...x, [k]: v }));
  const human = a.dial_result === 'gatekeeper' || a.dial_result === 'decision_maker';
  const quick = ['no_answer', 'voicemail', 'bad_number'].includes(a.dial_result);
  const askSend = !!lead.email && NO_PICKUP.includes(a.dial_result);
  const canSave = !!a.dial_result && (quick ? (!askSend || !!a.email_result) : (a.dial_result === 'gatekeeper' ? !!a.result : !!a.picked_up && !!a.fit && (a.fit !== 'not_fit' || !!a.not_fit_reason) && !!a.result));
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onCancel(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onCancel]);
  const showEmail = !!lead.email;
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
          {a.result === 'callback' && <div className="dbr-sub"><input type="datetime-local" value={a.callback_at} onChange={(e) => set('callback_at')(e.target.value)} /></div>}</section>}
        {askSend && <section><div className="dbr-q">2 · Send the email?</div><Pick options={SEND} value={a.email_result} onChange={set('email_result')} cols={2} />
          <span className="sm">{lead.sequence || lead.power_enrolled_at ? 'Already in a sequence — Power keeps going; this just logs the dial.' : 'Send = Power emails them from Derek\u2019s inbox within the minute and follows up four more times. A reply stops it.'}</span></section>}
        {showEmail && human && <section><div className="dbr-q">9 · Email (only if you emailed them yourself)</div><Pick options={EMAIL} value={a.email_result} onChange={set('email_result')} />{emailedNow && <span className="sm">You marked an email sent during this call — it counts.</span>}</section>}
        <section><textarea rows={2} placeholder="One line: who you spoke to, what they said, when to call back…" value={note} onChange={(e) => setNote(e.target.value)} /></section>
        <div className="row"><button className="btn-sm" type="button" onClick={onCancel}>Back to the call</button><div className="spacer" /><button className="btn-sm primary" type="button" disabled={!canSave} onClick={() => onSave(a)}>Close call</button></div>
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
