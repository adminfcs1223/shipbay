import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_KEY);

export const fmtMoney = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
export const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—');
export const monthStart = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;

export const STATUS = {
  new: ['info', 'New'], on_hold: ['warn', 'On hold'], backordered: ['bad', 'Backordered'],
  picked: ['info', 'Picked'], packed: ['info', 'Packed'], shipped: ['ok', 'Shipped'], cancelled: ['neutral', 'Cancelled'],
  expected: ['info', 'Expected'], in_transit: ['info', 'In transit'], received: ['ok', 'Received'], discrepancy: ['warn', 'Discrepancy'],
  requested: ['info', 'Requested'], inspected: ['info', 'Inspected'], restocked: ['ok', 'Restocked'], disposed: ['neutral', 'Disposed'], closed: ['neutral', 'Closed'],
  open: ['warn', 'Open'], pending: ['info', 'Pending'], draft: ['neutral', 'Draft'], sent: ['info', 'Sent'], paid: ['ok', 'Paid'], void: ['neutral', 'Void'],
  onboarding: ['info', 'Onboarding'], active: ['ok', 'Active'], paused: ['warn', 'Paused'], churned: ['neutral', 'Churned'],
};

/** Cutoff state for an unshipped order */
export function cutoffState(order) {
  if (!order.cutoff_at || order.status === 'shipped' || order.status === 'cancelled') return null;
  const ms = new Date(order.cutoff_at) - Date.now();
  if (ms < 0) return ['bad', 'Past cutoff'];
  if (ms < 2 * 3600e3) return ['warn', `Due ${fmtTime(order.cutoff_at)}`];
  return ['neutral', `Ships ${fmtDate(order.cutoff_at)}`];
}

export async function callFn(name, body) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}`, apikey: import.meta.env.VITE_SUPABASE_KEY },
    body: JSON.stringify(body),
  });
  return res.json();
}
