// One wording for a booking's receiving progress. Same text function as portal/src/bookingProgress.js (kept identical by test).
const STATE = { not_received: 'Nothing received yet', partial: 'Partly received', partial_on_hold: 'Partly received · on HOLD', complete: 'Complete', closed_with_discrepancy: 'Closed with a discrepancy' };
const of = (got, want, what) => (want > 0 ? `${got} of ${want} ${what}` : `${got} ${what}`);
const diff = (n, what) => (n > 0 ? `${n} ${what} short` : `${-n} ${what} over`);
export const progressText = (b) => {
  if (!b) return '';
  const reason = b.hold_reason ?? b.last_hold_reason;
  const parts = [STATE[b.receiving_state] || b.receiving_state, of(b.received_pallets, b.expected_pallets, 'pallets'), of(b.received_cartons, b.expected_cartons, 'cartons')];
  if (b.held_pallets > 0) parts.push(`${b.held_pallets} on HOLD` + (reason ? `: ${reason}` : ''));
  if (b.released_pallets > 0) parts.push(`${b.released_pallets} released from HOLD`);
  if (b.voided_pallets > 0) parts.push(`${b.voided_pallets} voided`);
  const d = [b.short_pallets ? diff(b.short_pallets, 'pallets') : null, b.short_cartons ? diff(b.short_cartons, 'cartons') : null].filter(Boolean);
  if (d.length) parts.push(d.join(', '));
  return parts.join(' · ');
};
