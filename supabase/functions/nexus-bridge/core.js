// ShipBay's server-side connection to Nexus. Plain JavaScript with no runtime imports, so the same file runs in the Edge
// Function (index.ts) and under `node --test`. The browser never talks to Nexus and never holds a Nexus key: the signed-in
// WMS calls this bridge with the user's own ShipBay login, and the bridge holds the key.
//
// What this build can connect to: Nexus STAGING and its test floor only.
//   NEXUS_BRIDGE_MODE       unset or "off": every route answers 503 and nothing is called. "staging": the staging service.
//                           Any other value (including "production") is refused: there is no production connection in this build.
//   NEXUS_STAGING_API_KEY   ShipBay's staging key. Read here, sent only to the fixed staging host, never logged or returned.
//   NEXUS_PALLET_MOVES      "on" to allow put-away, moves and releases. Anything else: those routes answer 503.
//   NEXUS_REGISTRY_WRITES   "on" to allow the position list to be written into ShipBay. Anything else: the sync route only reports.
//   NEXUS_CALENDAR_WRITES   "on" to allow calendar publishing. Anything else: the sync route only reports what it would send.
//   SUPABASE_URL            if it names ShipBay's production database, the staging connection refuses to run.
//   NEXUS_TEST_FAULTS       "on" AND the database is shipbay-nexus-dev: a signed-in staff request carrying the header
//                           x-nexus-test-fault: lose-answer has Nexus's answer to its one write thrown away after Nexus applied
//                           it, exactly as if the network had dropped it. For rehearsing recovery. On any other database the
//                           setting does nothing, and a request carrying the header is refused before anything is done. The
//                           header is not in the CORS allow-list, so a browser on the WMS site cannot send it.
export const STAGING_HOST = 'ankoqruedjujyefhrmtw.supabase.co';
export const TEST_FLOOR = 'HILLSBOROUGH-TEST';
export const PRODUCTION_DB_REF = 'poxlczzkpztmoiixyrth';
export const DEV_DB_HOST = 'gdoaonsasbsperqjuurm.supabase.co';
export const FAULT_HEADER = 'x-nexus-test-fault';
const hostOf = (u) => { try { return new URL(String(u)).host; } catch { return ''; } };

const no = (status, error, message) => ({ ok: false, status, error, message });
export function readConfig(env = {}) {
  const mode = env.NEXUS_BRIDGE_MODE || 'off';
  if (mode === 'off') return no(503, 'bridge_off', 'The Nexus connection is switched off here.');
  if (mode !== 'staging') return no(503, 'mode_not_available', 'Only the staging connection exists in this build. Production is not enabled.');
  if (String(env.SUPABASE_URL || '').includes(PRODUCTION_DB_REF)) return no(503, 'wrong_database', 'The staging connection does not run on the production database.');
  if (!env.NEXUS_STAGING_API_KEY) return no(503, 'not_configured', 'The Nexus staging key is not set.');
  return { ok: true, mode, base: `https://${STAGING_HOST}/functions/v1/nexus`, key: env.NEXUS_STAGING_API_KEY, floor: TEST_FLOOR,
    palletMoves: env.NEXUS_PALLET_MOVES === 'on', registryWrites: env.NEXUS_REGISTRY_WRITES === 'on', calendarWrites: env.NEXUS_CALENDAR_WRITES === 'on',
    testFaults: env.NEXUS_TEST_FAULTS === 'on' && hostOf(env.SUPABASE_URL) === DEV_DB_HOST };
}

/** Calls to Nexus. status 0 means no answer arrived (network failure or timeout): the request may or may not have been applied. */
export function nexusClient(cfg, fetchImpl, { timeoutMs = 8000, now = Date.now } = {}) {
  let floorAt = 0;
  async function call(method, path, { body, idem, lose } = {}) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(cfg.base + path, { method, signal: ctl.signal, body: body ? JSON.stringify(body) : undefined,
        headers: { authorization: `Bearer ${cfg.key}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) } });
      let j = null; try { j = await r.json(); } catch { /* not JSON */ }
      if (lose) return { status: 0, body: { ok: false, error: 'no_answer' }, lost: true };   // test fault: Nexus answered (and applied it); the answer is dropped here
      return { status: r.status, body: j && typeof j === 'object' ? j : { ok: false, error: 'bad_answer' } };
    } catch { return { status: 0, body: { ok: false, error: 'no_answer' } }; } finally { clearTimeout(timer); }
  }
  /** True only when Nexus itself says this key is bound to the floor this build expects. Checked before anything is written. */
  async function floorIsExpected() {
    if (now() - floorAt < 300000) return true;
    const r = await call('GET', '/v1/map'); if (r.status !== 200 || r.body.warehouse !== cfg.floor) return r.status === 200 ? false : null;
    floorAt = now(); return true;
  }
  return { call, floorIsExpected };
}

const json = (body, status, cors) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors } });

/**
 * The bridge: a web Request in, a web Response out.
 *   env        the settings above
 *   fetchImpl  how Nexus is reached
 *   db         { user(token).rpc(fn, args), service.rpc(fn, args) }: ShipBay's own database, as the signed-in user or as the bridge
 *   routes     [{ method, match: RegExp, run(ctx) }] from calendar.js and pallets.js
 */
export function makeBridge({ env, fetchImpl, db, routes, now = Date.now, timeoutMs = 8000 }) {
  const origins = String(env.BRIDGE_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  let nx = null;
  return async function handle(req) {
    const url = new URL(req.url); const origin = req.headers.get('origin');
    const cors = origin && origins.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info', 'access-control-allow-methods': 'GET, POST, OPTIONS' } : {};
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const send = (body, status = 200) => json(body, status, cors); const fail = (status, error, message, extra = {}) => send({ ok: false, error, message, ...extra }, status);
    const path = url.pathname.replace(/^.*\/nexus-bridge/, '').replace(/\/+$/, '') || '/';
    const cfg = readConfig(env);
    if (req.method === 'GET' && path === '/status') return send({ ok: true, connection: cfg.ok ? cfg.mode : 'off', reason: cfg.ok ? null : cfg.error, floor: cfg.ok ? cfg.floor : null, pallet_moves: !!cfg.palletMoves, registry_writes: !!cfg.registryWrites, calendar_writes: !!cfg.calendarWrites, test_faults: !!cfg.testFaults });
    if (!cfg.ok) return fail(cfg.status, cfg.error, cfg.message);
    const token = (req.headers.get('authorization') || '').match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) return fail(401, 'sign_in', 'Sign in to the WMS first.');
    const user = db.user(token);
    let staff = false; try { staff = (await user.rpc('is_wms_staff', {})) === true; } catch { return fail(401, 'sign_in', 'Your WMS sign-in was not accepted. Sign in again.'); }
    if (!staff) return fail(403, 'not_staff', 'This login cannot use the warehouse floor tools.');
    const route = routes.find((r) => r.method === req.method && r.match.test(path));
    if (!route) return fail(404, 'not_found', 'Unknown path.');
    // a test fault is asked for by header, by a signed-in staff login, and only where the setting allows it; anywhere else the request is not run at all
    const asked = req.headers.get(FAULT_HEADER); let fault = null;
    if (asked !== null) {
      if (!cfg.testFaults) return fail(403, 'test_faults_off', 'Test faults are not available here. Nothing was done.');
      if (asked !== 'lose-answer' || req.method !== 'POST') return fail(400, 'bad_request', 'Unknown test fault. Nothing was done.');
      fault = { lose: true };
    }
    let body = {};
    if (req.method === 'POST') {
      const text = await req.text(); if (text.length > 4096) return fail(400, 'bad_request', 'The request is too large.');
      try { body = text ? JSON.parse(text) : {}; } catch { return fail(400, 'bad_request', 'The request is not valid JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'bad_request', 'The request is a JSON object.');
    }
    nx = nx || nexusClient(cfg, fetchImpl, { timeoutMs, now });
    try { return await route.run({ cfg, nx, user, service: db.service, body, query: url.searchParams, send, fail, now, fault }); }
    catch { return fail(500, 'bridge_error', 'The request could not be completed. Nothing further was sent.'); }   // the cause is not returned or logged
  };
}

/** Plain words for the floor, for each Nexus refusal. Nexus's own message is not passed on. */
export function inWords(error, { pallet, to } = {}) {
  return ({
    location_full: `${to} is taken in Nexus. Pick another position.`,
    location_blocked: `${to} is blocked in Nexus.`,
    location_unavailable: `${to} is not available in Nexus.`,
    location_not_found: `Nexus does not know position ${to}.`,
    pallet_elsewhere: `Nexus has ${pallet} at a different position than ShipBay does. Stop and tell an admin.`,
    pallet_not_placed: `Nexus does not have ${pallet} on the floor. Stop and tell an admin.`,
    pallet_not_found: `Nexus does not know ${pallet}.`,
    already_there: `Nexus already has ${pallet} at ${to}.`,
    occupancy_not_initialized: 'The shared floor is not open for put-away yet: its starting occupancy has not been verified in Nexus.',
    forbidden: 'ShipBay\'s Nexus key is not allowed to place pallets.',
    unauthorized: 'Nexus did not accept ShipBay\'s key.',
    idempotency_key_reused: 'Nexus has seen this request with different details. Stop and tell an admin.',
  })[error] || 'Nexus refused the request.';
}
