// ShipBay WMS orders connector.
//   POST /api/orders                        create an order (safe to repeat)
//   POST /api/orders/{order_number}/close   the order was shipped or cancelled outside the WMS
// Called by an outside program, one per brand, with "Authorization: Bearer <brand key>". The WMS never fetches orders
// and never holds a brand's sales-channel key. All the rules (which fields are allowed, which brand a key belongs to,
// no duplicates) live in the database functions wms_api_create_order / wms_api_close_order; this file only routes.
// Deployed with verify_jwt = false: the brand key is the credential.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

Deno.serve(async (req) => {
  // path arrives as /wms-orders, /wms-orders/{n}/close, or with /functions/v1 or /api/orders in front
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  let at = parts.lastIndexOf('wms-orders');
  if (at < 0) at = parts.lastIndexOf('orders');
  const rest = parts.slice(at + 1).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });

  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed', message: 'Use POST.' });
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') || '');
  if (!m) return json(401, { error: 'unauthorized', message: 'Send Authorization: Bearer <key>.' });

  let body: unknown;
  try { body = JSON.parse(await req.text()); } catch { return json(400, { error: 'bad_request', message: 'The body is not valid JSON.' }); }

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  let res;
  if (rest.length === 0) res = await db.rpc('wms_api_create_order', { p_key: m[1], p_body: body });
  else if (rest.length === 2 && rest[1] === 'close') res = await db.rpc('wms_api_close_order', { p_key: m[1], p_order_number: rest[0], p_body: body });
  else return json(404, { error: 'not_found', message: 'Unknown path.' });

  if (res.error || !res.data) { console.error('wms-orders', res.error); return json(500, { error: 'server_error', message: 'The order could not be saved. Try again.' }); }
  return json(res.data.status, res.data.body);
});
