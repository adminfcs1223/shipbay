// Shared dock calendar rules. Synthetic data only.
import test from 'node:test'; import assert from 'node:assert/strict';
import { mergeCalendar, byDay, bookingIdFor, bookingFor, easternDay, easternWindow } from '../src/nexusCalendar.js';
import { demoData, ENABLED, loadCalendar } from '../src/nexusSource.js';

const ship = (o) => ({ id: 'aaaa-1111', brand: 'Synthetic Records', reference: 'SYN-PO-1', carrier: 'Example Freight', expected_at: '2026-12-04', pallets: 3, cartons: 30, status: 'expected', notes: null, ...o });
const mineEv = (o) => ({ id: 'SB-INB-AAAA-1111', mine: true, company: 'SHIPBAY', direction: 'inbound', starts_at: '2026-12-04T17:00:00+00:00', ends_at: '2026-12-04T19:00:00+00:00', pallets: 3, status: 'scheduled', reference: 'SYNTHETIC', note: 'x', ...o });
const other = (o) => ({ mine: false, company: 'SOULED', direction: 'inbound', starts_at: '2026-12-07T15:00:00+00:00', ends_at: '2026-12-07T17:00:00+00:00', pallets: 2, status: 'scheduled', ...o });

test('times are Eastern whatever the machine is set to, across both daylight rules', () => {
  assert.equal(easternDay('2026-12-08T04:30:00Z'), '2026-12-07', '11:30 PM Eastern belongs to the Eastern day, not the UTC day');
  assert.equal(easternWindow('2026-12-04T17:00:00Z', '2026-12-04T19:00:00Z'), '12:00 PM to 2:00 PM ET');
  assert.equal(easternWindow('2026-07-10T14:00:00Z', null), '10:00 AM ET', 'summer offset');
  assert.equal(easternWindow(null, null), null);
});
test('a shipment and its Nexus booking are one row; the id comes from the shipment, so it cannot be duplicated', () => {
  assert.equal(bookingIdFor({ id: 'aaaa-1111' }), 'SB-INB-AAAA-1111'); assert.equal(bookingIdFor({ id: 'aaaa-1111' }), bookingIdFor({ id: 'AAAA-1111' }));
  const rows = mergeCalendar([ship()], [mineEv(), other()], { today: '2026-12-01' });
  assert.equal(rows.length, 2); const r = rows[0];
  assert.deepEqual([r.kind, r.day, r.time_known, r.shared, r.booking_id], ['shipment', '2026-12-04', true, 'published', 'SB-INB-AAAA-1111']);
  assert.equal(easternWindow(r.starts_at, r.ends_at), '12:00 PM to 2:00 PM ET'); assert.equal(r.shipment.reference, 'SYN-PO-1', "ShipBay's own detail stays on ShipBay's row");
});
test('a date-only shipment keeps its date and gets no time; an undated one stays undated', () => {
  const rows = mergeCalendar([ship({ id: 'b', expected_at: '2026-12-05' }), ship({ id: 'c', expected_at: null })], [], { today: '2026-12-01' });
  const dated = rows.find((r) => r.shipment.id === 'b'); assert.deepEqual([dated.day, dated.time_known, dated.starts_at, dated.ends_at, dated.shared], ['2026-12-05', false, null, null, 'held_date_only']); assert.equal(dated.tentative, true);
  const { days, undated } = byDay(rows, '2026-12-01'); assert.equal(days.get('2026-12-05').length, 1); assert.equal(undated.length, 1); assert.equal(undated[0].day, null);
  assert.deepEqual(bookingFor(ship({ expected_at: '2026-12-05' }), null).reason, 'date_only_held'); assert.equal(bookingFor(ship({ expected_at: null }), null).reason, 'no_date');
  assert.equal(bookingFor(ship(), { starts_at: '2026-12-06T17:00:00Z' }).reason, 'day_mismatch');
  const b = bookingFor(ship(), { starts_at: '2026-12-04T17:00:00Z', ends_at: '2026-12-04T19:00:00Z' });
  assert.deepEqual(b, { ok: true, id: 'SB-INB-AAAA-1111', body: { direction: 'inbound', starts_at: '2026-12-04T17:00:00Z', ends_at: '2026-12-04T19:00:00Z', pallets: 3, status: 'scheduled' } });
  assert.ok(!('reference' in b.body) && !('note' in b.body), 'no ShipBay reference or note would be sent');
});
test("another company's appointment carries only what Nexus shares, even if an answer held more", () => {
  const leaky = other({ id: 'SOULED-PRIVATE-1', reference: 'PO-SECRET', note: 'customer name', brand: 'X', items: [1] });
  const [r] = mergeCalendar([], [leaky], { today: '2026-12-01' });
  assert.deepEqual(Object.keys(r).sort(), ['company', 'day', 'direction', 'ends_at', 'key', 'kind', 'pallets', 'starts_at', 'status', 'tentative', 'time_known'].sort());
  assert.ok(!JSON.stringify(r).includes('SECRET') && !JSON.stringify(r).includes('PRIVATE') && !JSON.stringify(r).includes('customer'));
  assert.equal(r.day, '2026-12-07');
});
test('updates and cancellations: a changed booking moves the time, a cancelled one removes the time and says so; own bookings with no shipment still show', () => {
  let [r] = mergeCalendar([ship()], [mineEv({ starts_at: '2026-12-04T18:00:00+00:00', ends_at: '2026-12-04T20:00:00+00:00' })], { today: '2026-12-01' });
  assert.equal(easternWindow(r.starts_at, r.ends_at), '1:00 PM to 3:00 PM ET');
  [r] = mergeCalendar([ship()], [mineEv({ status: 'cancelled' })], { today: '2026-12-01' });
  assert.deepEqual([r.time_known, r.starts_at, r.shared, r.day], [false, null, 'cancelled_in_nexus', '2026-12-04'], "the shipment keeps ShipBay's date and loses the cancelled time");
  const rows = mergeCalendar([], [mineEv({ id: 'DEV-SYNTH01', direction: 'outbound' }), other({ status: 'cancelled' })], { today: '2026-12-01' });
  assert.deepEqual(rows.map((x) => [x.kind, x.status]), [['own', 'scheduled'], ['other', 'cancelled']]);
});
test('an overdue ShipBay shipment shows on today; order within a day is by time, then the ones with no time', () => {
  const rows = mergeCalendar([ship({ id: 'late', expected_at: '2026-11-28' }), ship({ id: 'd', expected_at: '2026-12-07' })], [other(), other({ starts_at: '2026-12-07T13:00:00+00:00', ends_at: null })], { today: '2026-12-01' });
  const { days } = byDay(rows, '2026-12-01'); assert.equal(days.get('2026-12-01')[0].shipment.id, 'late'); assert.equal(days.get('2026-11-28'), undefined);
  assert.deepEqual(days.get('2026-12-07').map((x) => (x.time_known ? easternWindow(x.starts_at, x.ends_at) : 'none')), ['8:00 AM ET', '10:00 AM to 12:00 PM ET', 'none']);
});
test('the data source: off unless the build asks for the demonstration; demonstration data is synthetic and self-consistent', async () => {
  assert.equal(ENABLED, false, 'with no build setting the feature is off'); await assert.rejects(loadCalendar(), /not connected/);
  const d = demoData(Date.parse('2026-11-22T22:00:00Z')); assert.equal(d.today, '2026-11-22'); assert.equal(d.nexus.warehouse, 'HILLSBOROUGH-TEST');
  assert.ok(d.shipments.every((s) => /^Synthetic /.test(s.brand) && /^SYN-/.test(s.reference)));
  const rows = mergeCalendar(d.shipments, d.nexus.events, { today: d.today });
  assert.equal(rows.filter((r) => r.kind === 'shipment').length, 4); assert.equal(rows.filter((r) => r.kind === 'own').length, 1); assert.equal(rows.filter((r) => r.kind === 'other').length, 3);
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, 'no row twice');
  const lateNight = rows.find((r) => r.kind === 'other' && r.ends_at === null); assert.equal(lateNight.day, '2026-11-25', 'an 11:30 PM Eastern appointment stays on its Eastern day');
});

test('tentative arrivals: a date with no confirmed time is tentative for either company and never gets a time; a confirmed appointment is not tentative', () => {
  const rows = mergeCalendar([ship({ id: 'd', expected_at: '2026-12-08', appt_starts_at: '2026-12-08T14:00:00Z', appt_ends_at: '2026-12-08T15:00:00Z' }), ship({ id: 'e', expected_at: '2026-12-08' })],
    [{ mine: false, company: 'SOULED', direction: 'inbound', date: '2026-12-08', time_confirmed: false, pallets: 4, status: 'scheduled', reference: 'PRIVATE' },
     { mine: false, company: 'SOULED', direction: 'inbound', starts_at: '2026-12-08T20:00:00Z', pallets: 1, status: 'scheduled' }], { today: '2026-12-01' });
  const d = rows.find((r) => r.shipment?.id === 'd'); assert.deepEqual([d.tentative, d.time_known, easternWindow(d.starts_at, d.ends_at), d.shared], [false, true, '9:00 AM to 10:00 AM ET', 'not_published']);
  const e = rows.find((r) => r.shipment?.id === 'e'); assert.deepEqual([e.tentative, e.time_known, e.starts_at, e.shared], [true, false, null, 'held_date_only']);
  const o = rows.filter((r) => r.kind === 'other'); assert.deepEqual(o.map((r) => [r.day, r.tentative, r.time_known, r.starts_at ? easternWindow(r.starts_at) : null]), [['2026-12-08', false, true, '3:00 PM ET'], ['2026-12-08', true, false, null]]);
  assert.ok(!JSON.stringify(o).includes('PRIVATE'));
  assert.deepEqual(rows.map((r) => r.time_known), [true, true, false, false], 'confirmed times first, tentative arrivals after them');
  const held = bookingFor(ship({ id: 'e', expected_at: '2026-12-08', pallets: 5 })); assert.equal(held.ok, false); assert.equal(held.body, undefined, 'nothing to send');
  assert.deepEqual(held.proposed, { direction: 'inbound', date: '2026-12-08', time_confirmed: false, pallets: 5, status: 'scheduled' });
  assert.deepEqual(bookingFor(ship({ id: 'd', expected_at: '2026-12-08', appt_starts_at: '2026-12-08T14:00:00Z', pallets: 5 })).body, { direction: 'inbound', starts_at: '2026-12-08T14:00:00Z', pallets: 5, status: 'scheduled' });
});
