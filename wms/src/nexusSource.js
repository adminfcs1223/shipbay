// Where the shared calendar's data comes from, chosen at build time by VITE_NEXUS_CALENDAR:
//   (unset)   the feature is off: the WMS is exactly as it was, with no Calendar tab.
//   "demo"    synthetic data bundled in this file. No network call of any kind. For demonstrations.
//   "bridge"  ShipBay's own server-side bridge (see nexusBridge.js; needs VITE_NEXUS_BRIDGE=on and a non-production database).
//             The bridge reads ShipBay's shipments as the signed-in user and the Nexus calendar with ShipBay's key.
//   anything else is refused. A browser never holds a Nexus key, and nothing here can reach Nexus production.
// The answer has the same shape in every mode, and `nexus.events` is exactly the `events` array of Nexus GET /v1/calendar.
import { easternDay } from './nexusCalendar.js';
import { bridge, BRIDGE } from './nexusBridge.js';

export const MODE = (import.meta.env && import.meta.env.VITE_NEXUS_CALENDAR) || '';
export const ENABLED = MODE === 'demo' || (MODE === 'bridge' && BRIDGE);

// An Eastern wall-clock time on the day `plus` days from today, as the instant Nexus would hold.
function eastern(today, plus, hh, mm = 0) {
  const [y, m, d] = today.split('-').map(Number); const want = Date.UTC(y, m - 1, d + plus, hh, mm); let ms = want;
  for (let i = 0; i < 3; i++) { const q = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    ms += want - Date.UTC(+q.year, +q.month - 1, +q.day, +q.hour, +q.minute); }
  return new Date(ms).toISOString();
}
const dayPlus = (today, plus) => easternDay(Date.parse(eastern(today, plus, 12)));

/** Synthetic shipments and a synthetic Nexus answer. Invented names and references only. */
export function demoData(now = Date.now()) {
  const today = easternDay(now);
  const shipments = [
    { id: 'syn-0001', brand: 'Synthetic Records', reference: 'SYN-PO-1001', carrier: 'Example Freight', expected_at: dayPlus(today, 1), pallets: 6, cartons: 175, status: 'expected', notes: 'Synthetic: appointment published to the shared calendar' },
    { id: 'syn-0002', brand: 'Synthetic Mailers', reference: 'SYN-PO-1002', carrier: null, expected_at: dayPlus(today, 3), pallets: 16, cartons: 0, status: 'expected', notes: 'Synthetic: date only, no appointment time yet' },
    { id: 'syn-0003', brand: 'Synthetic Leather', reference: 'SYN-PO-1003', carrier: 'Example LTL', expected_at: null, pallets: 2, cartons: 40, status: 'expected', notes: 'Synthetic: approved, no date yet' },
    { id: 'syn-0004', brand: 'Synthetic Records', reference: 'SYN-PO-1004', carrier: 'Example Freight', expected_at: dayPlus(today, 8), pallets: 4, cartons: 90, status: 'in_transit', notes: 'Synthetic: its shared booking was cancelled' },
  ];
  const events = [
    { id: 'SB-INB-SYN-0001', mine: true, company: 'SHIPBAY', direction: 'inbound', starts_at: eastern(today, 1, 12), ends_at: eastern(today, 1, 14), pallets: 6, status: 'scheduled', reference: 'SYNTHETIC', note: 'ShipBay development preview', updated_at: new Date(now).toISOString() },
    { id: 'SB-INB-SYN-0004', mine: true, company: 'SHIPBAY', direction: 'inbound', starts_at: eastern(today, 8, 9), ends_at: eastern(today, 8, 11), pallets: 4, status: 'cancelled', reference: 'SYNTHETIC', note: 'ShipBay development preview', updated_at: new Date(now).toISOString() },
    { id: 'DEV-SYNTH01', mine: true, company: 'SHIPBAY', direction: 'outbound', starts_at: eastern(today, 2, 15), ends_at: eastern(today, 2, 16), pallets: 3, status: 'scheduled', reference: 'SYNTHETIC', note: 'ShipBay development preview', updated_at: new Date(now).toISOString() },
    { mine: false, company: 'SOULED', direction: 'inbound', starts_at: eastern(today, 1, 10), ends_at: eastern(today, 1, 12), pallets: 2, status: 'scheduled', updated_at: new Date(now).toISOString() },
    { mine: false, company: 'SOULED', direction: 'inbound', starts_at: eastern(today, 3, 23, 30), ends_at: null, pallets: 1, status: 'scheduled', updated_at: new Date(now).toISOString() },
    { mine: false, company: 'SOULED', direction: 'outbound', starts_at: eastern(today, 5, 13), ends_at: eastern(today, 5, 14), pallets: 5, status: 'cancelled', updated_at: new Date(now).toISOString() },
  ];
  return { mode: 'demo', today, shipments, nexus: { warehouse: 'HILLSBOROUGH-TEST', events, fetched_at: new Date(now).toISOString() } };
}

const shift = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** Load the calendar: the demonstration data, or ShipBay's shipments and the Nexus calendar through the bridge. */
export async function loadCalendar(now = Date.now()) {
  if (MODE === 'demo') return demoData(now);
  if (MODE === 'bridge' && BRIDGE) {
    const today = easternDay(now); const r = await bridge(`/calendar?from=${shift(today, -7)}&to=${shift(today, 42)}`);
    if (!r.ok) throw new Error(r.message || 'The calendar could not be loaded.');
    return { mode: 'bridge', today, shipments: r.shipments || [], nexus: { ok: !!r.nexus?.ok, warehouse: r.nexus?.warehouse || null, events: r.nexus?.events || [], fetched_at: new Date(now).toISOString() } };
  }
  throw new Error('The shared calendar is not connected in this build.');
}
