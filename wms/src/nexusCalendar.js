// Shared dock calendar: the rules for putting ShipBay's own shipment records and the Nexus shared calendar on one screen.
// Pure functions, no network and no React, so they can be tested on their own. The time and privacy rules are the ones
// proven on the shipbay-nexus-dev preview against Nexus staging (map version 4, API v1).
//
//  - Every time is America/New_York, whatever zone the browser is in.
//  - A ShipBay shipment that has only a date keeps only a date. No time is invented for it.
//  - A ShipBay shipment and its Nexus booking are one row: the booking id is derived from the shipment id, so the same
//    shipment can never be published or shown twice.
//  - Another company's appointment carries company, direction, time, pallets and status. Anything else in the answer is dropped here.
export const ZONE = 'America/New_York';
export const COMPANY = 'SHIPBAY';

const parts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
/** The Eastern calendar day (YYYY-MM-DD) an instant falls on. */
export const easternDay = (t) => { const q = parts(typeof t === 'number' ? t : Date.parse(t)); return `${q.year}-${q.month}-${q.day}`; };
/** "12:00 PM" in Eastern time. */
export const easternClock = (t) => new Date(t).toLocaleString('en-US', { timeZone: ZONE, hour: 'numeric', minute: '2-digit' });
/** "12:00 PM to 2:00 PM ET", "12:00 PM ET" when there is no end, or null when there is no start. */
export const easternWindow = (start, end) => (start ? `${easternClock(start)}${end ? ` to ${easternClock(end)}` : ''} ET` : null);

/** The one Nexus booking id a ShipBay inbound shipment may ever have. Deterministic: publishing twice changes the same booking. */
export const bookingIdFor = (shipment) => `SB-INB-${String(shipment.id).toUpperCase()}`;

const PUBLIC = ['company', 'direction', 'starts_at', 'ends_at', 'pallets', 'status', 'updated_at'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/**
 * One list of calendar rows from ShipBay's shipments and the Nexus calendar answer.
 *   shipments: rows as wms_today gives them ({id, brand, reference, carrier, expected_at (date or null), pallets, cartons, status, notes})
 *   events:    the `events` array of Nexus GET /v1/calendar
 * Row kinds: 'shipment' (ShipBay record, private detail kept), 'own' (a ShipBay booking in Nexus with no shipment record here),
 * 'other' (another company's appointment, public fields only).
 */
export function mergeCalendar(shipments, events, { today } = {}) {
  const mine = new Map(); const rows = [];
  for (const e of events || []) if (e.mine && e.id) mine.set(String(e.id).toUpperCase(), e);
  for (const s of shipments || []) {
    const id = bookingIdFor(s); const b = mine.get(id); if (b) mine.delete(id);
    const live = b && b.status !== 'cancelled';
    rows.push({ kind: 'shipment', key: `s:${s.id}`, company: COMPANY, direction: 'inbound', shipment: s, booking_id: id,
      // the day comes from ShipBay's own record; the time only from a booking ShipBay itself published
      day: s.expected_at || (live ? easternDay(b.starts_at) : null), late: !!(s.expected_at && today && s.expected_at < today),
      starts_at: live ? b.starts_at : null, ends_at: live ? b.ends_at ?? null : null, time_known: !!live,
      pallets: s.pallets ?? null, status: s.status, shared: b ? (live ? 'published' : 'cancelled_in_nexus') : 'not_published' });
  }
  for (const e of mine.values()) rows.push({ kind: 'own', key: `n:${e.id}`, company: COMPANY, direction: e.direction, booking_id: e.id, day: easternDay(e.starts_at),
    starts_at: e.starts_at, ends_at: e.ends_at ?? null, time_known: true, pallets: e.pallets ?? null, status: e.status, shared: 'published' });
  let n = 0;
  for (const e of events || []) {
    if (e.mine) continue; const p = pick(e, PUBLIC); if (!p.starts_at || !p.company) continue;
    rows.push({ kind: 'other', key: `o:${p.company}:${p.starts_at}:${n++}`, company: p.company, direction: p.direction, day: easternDay(p.starts_at),
      starts_at: p.starts_at, ends_at: p.ends_at ?? null, time_known: true, pallets: p.pallets ?? null, status: p.status });
  }
  // within a day: timed appointments in order, then the ones with no time set
  const t = (r) => (r.time_known ? Date.parse(r.starts_at) : Infinity);
  return rows.sort((a, b) => (a.day || '9999').localeCompare(b.day || '9999') || t(a) - t(b) || a.company.localeCompare(b.company) || a.key.localeCompare(b.key));
}

/** Rows by the day they show on. An overdue ShipBay shipment shows on today, as the dashboard has always done. Undated rows are returned apart. */
export function byDay(rows, today) {
  const days = new Map(); const undated = [];
  for (const r of rows) { if (!r.day) { undated.push(r); continue; } const k = r.kind === 'shipment' && r.late ? today : r.day; if (!days.has(k)) days.set(k, []); days.get(k).push(r); }
  return { days, undated };
}

/** What a ShipBay shipment would send to Nexus, or the reason it cannot be sent yet. Nothing here sends anything. */
export function bookingFor(shipment, window) {
  if (!shipment.expected_at) return { ok: false, reason: 'no_date', message: 'This shipment has no date yet.' };
  if (!window || !window.starts_at) return { ok: false, reason: 'no_time', message: 'This shipment has a date but no appointment time. Nexus needs a start time, and none is invented here.' };
  if (easternDay(window.starts_at) !== shipment.expected_at) return { ok: false, reason: 'day_mismatch', message: 'The appointment time is not on the shipment\'s date.' };
  return { ok: true, id: bookingIdFor(shipment), body: { direction: 'inbound', starts_at: window.starts_at, ...(window.ends_at ? { ends_at: window.ends_at } : {}), ...(shipment.pallets != null ? { pallets: shipment.pallets } : {}),
    status: shipment.status === 'cancelled' ? 'cancelled' : 'scheduled' } };   // reference and note stay in ShipBay
}
