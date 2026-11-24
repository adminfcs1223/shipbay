// When the store sync (Shopify or Veeqo) must leave an order alone (ShipBay MVP, 2026-11-24).
//  - In the warehouse's hands: the order is picked, packed or shipped here, or has a live pick, a place on a wave being picked
//    or packed, a package or a shipment. The sync then changes nothing on it (no status, address, units or lines) and reports
//    it, so a person decides (for example: undo the pick, then cancel). The database refuses the same changes on its own
//    (dev_036 revision 2); this check keeps one locked order from stopping the whole sync with an error.
//  - Stale: the event is older than the version of the order already on file (a retry or an out-of-order webhook).
// Fails closed: if the check itself cannot run (for example dev_036 is not installed), the order is treated as in the
// warehouse's hands, so the sync updates no existing order until it can tell.
export const WAREHOUSE_STATUSES = ['picked', 'packed', 'shipped'];

export async function inWarehouseHands(supabase: any, orderId: string, status: string): Promise<string | null> {
  if (WAREHOUSE_STATUSES.includes(status)) return status;
  // the database's own answer (dev_036): picked units, packages, a shipment, or a wave being picked or packed. The wave and
  // package tables are closed to the API, so the sync asks this read-only function instead of the tables.
  try {
    const { data, error } = await supabase.rpc('_order_commitment', { p_order: orderId });
    if (error) return 'unknown (check failed)';
    return data ? String(data) : null;
  } catch { return 'unknown (check failed)'; }
}

/** true when `incoming` is strictly older than `onFile` (both ISO timestamps; a missing one never counts as stale). */
export function isStale(incoming: unknown, onFile: unknown): boolean {
  const a = Date.parse(String(incoming ?? '')), b = Date.parse(String(onFile ?? ''));
  return Number.isFinite(a) && Number.isFinite(b) && a < b;
}
