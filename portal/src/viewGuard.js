// "View as client": an admin opens a brand's portal exactly as the brand sees it. An admin's own access would show
// every brand, so while it is on every request is checked here, before it leaves the browser, and anything that is not
// provably limited to the chosen brand is refused (fail closed):
//   • a table or view that carries org_id is read only with org_id = the brand; a request naming another brand is refused;
//   • orgs is read only for the brand itself;
//   • order lines and wave orders (no org_id of their own) are read only for one order already shown to this view;
//   • any other table or view, every write, every edge function and every RPC except the read-only ones listed here
//     (called for this brand only) is refused;
//   • stored files are opened only under the brand's own folder.
let viewAsOrg = null;
let viewAsOrders = new Set();   // order ids this view has been shown, from brand-limited reads of orders / v_orders_queue
export const setViewAsOrg = (id) => { viewAsOrg = id || null; viewAsOrders = new Set(); };
// Every relation with an org_id column (development and production schemas), tables and views alike.
const ORG_TABLES = new Set(['documents', 'events', 'inbound_shipments', 'integrations', 'inventory_levels', 'inventory_list_items', 'inventory_lists',
  'inventory_moves', 'invoices', 'nexus_count_lines', 'nexus_counts', 'onboarding_tasks', 'orders', 'org_integrations', 'profiles', 'quotes',
  'rate_cards', 'returns', 'shipments', 'skus', 'storage_snapshots', 'tickets', 'ticket_messages', 'v_daily_ops', 'v_inbound_receiving',
  'v_nexus_pallets', 'v_onboarding_progress', 'v_open_queue', 'v_orders_queue', 'v_org_month', 'wms_activity', 'wms_api_keys', 'wms_cartons',
  'wms_packages', 'wms_pallets', 'wms_pick_problems', 'wms_picks', 'wms_receipt_links', 'wms_units', 'wms_waves']);
const ORDER_SOURCES = new Set(['orders', 'v_orders_queue']);   // reads whose rows are this brand's orders
const ORDER_CHILDREN = new Set(['order_lines', 'wms_wave_orders']);   // no org_id: one order at a time, and only an order shown here
const VIEW_RPCS = { wms_org_connector: 'p_org' };   // read-only functions the client pages call, and the argument naming the brand
const refused = (why) => Promise.resolve(new Response(JSON.stringify({ message: why || 'You are viewing this as the client. Nothing can be changed from here.', code: 'VIEW_ONLY' }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
const NOT_SHOWN = 'Not available while viewing as the client.';
const remember = async (res) => {
  try { const rows = await res.clone().json(); (Array.isArray(rows) ? rows : [rows]).forEach((r) => { if (r && r.id) viewAsOrders.add(String(r.id)); }); } catch { /* not JSON rows */ }
  return res;
};
export const viewGuard = (input, init = {}, doFetch = fetch) => {
  if (!viewAsOrg) return doFetch(input, init);
  let url; try { url = new URL(typeof input === 'string' ? input : input.url); } catch { return refused(NOT_SHOWN); }
  const method = (init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
  const read = ['GET', 'HEAD'].includes(method);
  const p = url.pathname;
  if (/\/auth\/v1\//.test(p)) return doFetch(input, init);   // the admin's own session
  const rest = /\/rest\/v1\/(rpc\/)?([^/?]+)/.exec(p);
  if (rest && rest[1]) {
    const arg = VIEW_RPCS[rest[2]];
    if (!arg) return refused();
    let body = {}; try { body = typeof init.body === 'string' ? JSON.parse(init.body) : {}; } catch { return refused(NOT_SHOWN); }
    return body && body[arg] === viewAsOrg ? doFetch(input, init) : refused(NOT_SHOWN);
  }
  if (rest) {
    if (!read) return refused();
    const t = decodeURIComponent(rest[2]); const q = url.searchParams; const mine = `eq.${viewAsOrg}`;
    if (ORG_TABLES.has(t)) {
      const given = q.getAll('org_id');
      if (given.some((v) => v !== mine)) return refused(NOT_SHOWN);
      if (!given.length) q.append('org_id', mine);
      const go = doFetch(url.toString(), { ...init, method });
      return ORDER_SOURCES.has(t) && method === 'GET' ? go.then(remember) : go;
    }
    if (t === 'orgs') {
      const given = q.getAll('id');
      if (given.some((v) => v !== mine)) return refused(NOT_SHOWN);
      if (!given.length) q.append('id', mine);
      return doFetch(url.toString(), { ...init, method });
    }
    if (ORDER_CHILDREN.has(t)) {
      const given = q.getAll('order_id');
      const ok = given.length === 1 && /^eq\./.test(given[0]) && viewAsOrders.has(given[0].slice(3));
      return ok ? doFetch(url.toString(), { ...init, method }) : refused(NOT_SHOWN);
    }
    return refused(NOT_SHOWN);
  }
  if (/\/functions\/v1\//.test(p)) return refused();
  const obj = /\/storage\/v1\/object\/(sign\/|public\/|authenticated\/)?([^/]+)\/(.+)$/.exec(p);
  if (obj && (read || obj[1] === 'sign/')) {
    const path = decodeURIComponent(obj[3]);
    return path.startsWith(`${viewAsOrg}/`) && !path.includes('..') ? doFetch(input, init) : refused(NOT_SHOWN);
  }
  return refused(read ? NOT_SHOWN : undefined);
};
