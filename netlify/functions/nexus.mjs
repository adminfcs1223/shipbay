// ShipBay development preview -> Nexus STAGING. Server side only (Netlify Function).
//
// What this is: the one place that holds ShipBay's Nexus staging key and talks to Nexus. The browser calls
// /api/nexus/<operation> with a preview passcode; this function adds the key and calls a fixed list of Nexus v1
// operations on a fixed staging host. It is not a proxy: a path, a method, a query value or a body field that is not
// written out below never reaches Nexus.
//
// Allowed:   health, map, occupancy, changes (feed), calendar read, calendar create/change/cancel of synthetic events.
// Never:     pallet assign / move / release (refused here before anything is sent), any other host, the live floor.
// Secrets:   NEXUS_STAGING_API_KEY and PREVIEW_PASSCODE, both read from this site's server-side environment only.
import { createHash, timingSafeEqual } from 'node:crypto';

export const NEXUS_HOST = 'ankoqruedjujyefhrmtw.supabase.co';                    // Nexus staging. Not configurable on purpose.
const NEXUS_BASE = `https://${NEXUS_HOST}/functions/v1/nexus`;
export const TEST_FLOOR = 'HILLSBOROUGH-TEST';
const EVENT_ID = /^DEV-[A-Z0-9-]{1,40}$/;                                        // synthetic calendar events only
const STATUSES = ['scheduled', 'arrived', 'completed', 'cancelled'];

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const refuse = (status, error, message) => json({ ok: false, error, message }, status);
const same = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());
const isTime = (v) => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v));

export function makeHandler({ env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  let floorOkUntil = 0;   // when the key was last confirmed to belong to the test floor

  async function nexus(method, path, { query, body, auth = true } = {}) {
    const url = new URL(NEXUS_BASE + path);
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetchImpl(url, { method, signal: ctl.signal, redirect: 'error',
        headers: { accept: 'application/json', ...(auth ? { authorization: `Bearer ${env.NEXUS_STAGING_API_KEY}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      let data = null; try { data = await res.json(); } catch { /* not JSON */ }
      if (!data || typeof data !== 'object') return { status: 502, data: { ok: false, error: 'nexus_bad_answer', message: 'Nexus staging did not answer with JSON.' } };
      return { status: res.status, data };
    } catch {
      return { status: 502, data: { ok: false, error: 'nexus_unreachable', message: 'Nexus staging could not be reached. Nothing was changed.' } };   // the cause is not passed on
    } finally { clearTimeout(timer); }
  }
  // An answer that names a floor must name the test floor. Anything else is withheld.
  const wrongFloor = (d) => d && d.ok && 'warehouse' in d && (d.warehouse !== TEST_FLOOR || d.test === false);
  const pass = (r) => (wrongFloor(r.data) ? refuse(502, 'not_the_test_floor', 'This key is not bound to the Nexus test floor. Nothing is shown.') : json(r.data, r.status));
  async function floorChecked() {
    if (now() < floorOkUntil) return true;
    const r = await nexus('GET', '/v1/map');
    if (r.status === 200 && r.data.ok && r.data.warehouse === TEST_FLOOR && r.data.test === true) { floorOkUntil = now() + 5 * 60 * 1000; return true; }
    return false;
  }

  return async function handle(req) {
    const url = new URL(req.url); const m = req.method;
    const sub = url.pathname.replace(/^\/api\/nexus/, '').replace(/\/+$/, '') || '/';
    const ready = typeof env.NEXUS_STAGING_API_KEY === 'string' && env.NEXUS_STAGING_API_KEY.length >= 16 && typeof env.PREVIEW_PASSCODE === 'string' && env.PREVIEW_PASSCODE.length >= 12;
    if (m === 'GET' && sub === '/status') return json({ ok: true, ready, target: 'nexus-staging', floor: TEST_FLOOR, pallet_operations: 'disabled' });
    if (/pallets/i.test(url.pathname)) return refuse(403, 'pallet_operations_disabled', 'Assign, move and release are switched off in this preview.');
    if (!['GET', 'PUT', 'DELETE'].includes(m)) return refuse(405, 'method_not_allowed', 'This preview reads the map, occupancy, feed and calendar, and writes synthetic calendar events.');
    if (!ready) return refuse(503, 'not_configured', 'The preview is not configured yet: its server-side secrets are missing.');
    if ([...url.searchParams.keys()].some((k) => /key|token|secret|pass/i.test(k))) return refuse(400, 'bad_request', 'A key or passcode never goes in the address.');
    const given = req.headers.get('x-preview-passcode') || '';
    if (!given || !same(given, env.PREVIEW_PASSCODE)) return refuse(401, 'passcode_required', 'Enter the preview passcode.');

    if (m === 'GET' && sub === '/health') return pass(await nexus('GET', '/v1/health', { auth: false }));
    if (m === 'GET' && sub === '/map') return pass(await nexus('GET', '/v1/map'));
    if (m === 'GET' && sub === '/occupancy') return pass(await nexus('GET', '/v1/occupancy'));
    if (m === 'GET' && sub === '/changes') {
      const after = url.searchParams.get('after') ?? '0'; const limit = url.searchParams.get('limit') ?? '50';
      if (!/^\d{1,15}$/.test(after) || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 500) return refuse(400, 'bad_request', 'after is a whole number; limit is 1 to 500.');
      if (!(await floorChecked())) return refuse(502, 'not_the_test_floor', 'The test floor could not be confirmed. Nothing is shown.');
      return pass(await nexus('GET', '/v1/changes', { query: { after, limit } }));
    }
    if (m === 'GET' && sub === '/calendar') {
      const from = url.searchParams.get('from'), to = url.searchParams.get('to');
      if (!isTime(from) || !isTime(to)) return refuse(400, 'bad_request', 'from and to are dates and times with their offset.');
      return pass(await nexus('GET', '/v1/calendar', { query: { from, to } }));
    }
    const ev = sub.match(/^\/calendar\/([^/]+)$/)?.[1];
    if (ev && (m === 'PUT' || m === 'DELETE')) {
      let id; try { id = decodeURIComponent(ev); } catch { id = ''; }
      if (!EVENT_ID.test(id)) return refuse(400, 'bad_request', 'This preview only writes synthetic events whose id starts with DEV-.');
      const floorRefusal = async () => ((await floorChecked()) ? null : refuse(502, 'not_the_test_floor', 'The test floor could not be confirmed. Nothing was sent.'));
      if (m === 'DELETE') return (await floorRefusal()) || pass(await nexus('DELETE', `/v1/calendar/${encodeURIComponent(id)}`));
      const text = await req.text(); if (text.length > 2048) return refuse(400, 'bad_request', 'The request body is too large.');
      let b; try { b = JSON.parse(text || '{}'); } catch { return refuse(400, 'bad_request', 'The body is not valid JSON.'); }
      if (!b || typeof b !== 'object' || Array.isArray(b)) return refuse(400, 'bad_request', 'The body is a JSON object.');
      if (!['inbound', 'outbound'].includes(b.direction) || !isTime(b.starts_at) || (b.ends_at != null && !isTime(b.ends_at))
        || (b.pallets != null && !(Number.isInteger(b.pallets) && b.pallets >= 0 && b.pallets <= 200)) || (b.status != null && !STATUSES.includes(b.status)))
        return refuse(400, 'bad_request', 'direction is inbound or outbound; starts_at and ends_at are dates and times with their offset; pallets is 0 to 200; status is scheduled, arrived, completed or cancelled.');
      // Only these fields go to Nexus. reference and note are fixed here so no real ShipBay reference can be typed into staging.
      const out = { direction: b.direction, starts_at: b.starts_at, ...(b.ends_at != null ? { ends_at: b.ends_at } : {}), ...(b.pallets != null ? { pallets: b.pallets } : {}), ...(b.status != null ? { status: b.status } : {}),
        reference: 'SYNTHETIC', note: 'ShipBay development preview' };
      return (await floorRefusal()) || pass(await nexus('PUT', `/v1/calendar/${encodeURIComponent(id)}`, { body: out }));
    }
    return refuse(404, 'not_found', 'This preview does not offer that operation.');
  };
}

export default makeHandler();
export const config = { path: '/api/nexus/*' };
