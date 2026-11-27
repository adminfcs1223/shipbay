// ShipBay's server-side connection to Nexus. Plain JavaScript with no runtime imports, so the same file runs in the Edge
// Function (index.ts) and under `node --test`. The browser never talks to Nexus and never holds a Nexus key: the signed-in
// WMS calls this bridge with the user's own ShipBay login, and the bridge holds the key.
//
// What this build can connect to: the Nexus test floor (staging) or the real floor (production).
//   NEXUS_BRIDGE_MODE       unset or "off": every route answers 503 and nothing is called. "staging": the test floor
//                           HILLSBOROUGH-TEST, never from the production database. "production": the real floor HILLSBOROUGH,
//                           only from ShipBay's production database. Anything else: refused.
//   NEXUS_PRODUCTION_READ_KEY ShipBay's read key for the real floor: maps and occupancy (production mode only).
//   NEXUS_PRODUCTION_API_KEY  ShipBay's read + move key for the real floor: the ONLY key a placement, move or release is sent
//                           with (it also reads when no read key is set). Not set: every pallet write is refused here.
//                           In production the time window below does not apply: a placement needs the switch, this key, an
//                           employee's confirmation at the position, and ShipBay's own rules; Nexus then decides.
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
//   NEXUS_MOVES_UNTIL       REQUIRED for any pallet write, in addition to NEXUS_PALLET_MOVES: an absolute time with its zone
//                           (2026-11-24T17:30:00Z). Before it, writes may be sent; from it on, none is begun, whatever the switches
//                           say. Missing, unreadable, or more than 60 minutes ahead of the moment of use: no write is sent. It is
//                           read from the function's settings only; nothing a caller sends can set or extend it.
//   NEXUS_MOVES_POSITIONS   REQUIRED with it: the positions a write may name, comma-separated (P-50). A put-away's destination,
//                           a move's destination AND source, and a release's position must all be in it.
//   NEXUS_MOVES_PALLETS     optional: when set, the only pallets a write may name (PSKU-000101).
//   These three are checked twice: before ShipBay's journal is touched, and again immediately before each request to Nexus.
//   The settings themselves do not reset: the switches stay as they were set until someone removes them.
export const STAGING_HOST = 'ankoqruedjujyefhrmtw.supabase.co';
export const TEST_FLOOR = 'HILLSBOROUGH-TEST';
export const REAL_FLOOR = 'HILLSBOROUGH';   // the real floor; Nexus binds each key to one floor, and every write first checks the key's floor is this one
export const PRODUCTION_DB_REF = 'poxlczzkpztmoiixyrth';
export const DEV_DB_HOST = 'gdoaonsasbsperqjuurm.supabase.co';
export const FAULT_HEADER = 'x-nexus-test-fault';
export const MOVE_WINDOW_MAX_MS = 60 * 60000;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const listOf = (v, re, max) => { if (v === undefined || v === null || v === '') return null; const l = String(v).split(',').map((x) => x.trim().toUpperCase()); return l.length && l.length <= max && l.every((x) => re.test(x)) && new Set(l).size === l.length ? l : false; };
const pos = (v) => (v === null || v === undefined || v === '' ? null : String(v).trim().toUpperCase().replace(/^LOC-/, ''));
/** The time-limited movement authorization, from the function's settings only. */
export function readMoveWindow(env = {}) {
  const raw = String(env.NEXUS_MOVES_UNTIL || '').trim(); const until = AT.test(raw) ? Date.parse(raw) : NaN;
  const positions = listOf(env.NEXUS_MOVES_POSITIONS, /^(P|STG)-\d{2}$/, 80); const pallets = listOf(env.NEXUS_MOVES_PALLETS, /^PSKU-\d{6}$/, 20);
  const problem = !raw ? 'no movement authorization is set (NEXUS_MOVES_UNTIL)' : !Number.isFinite(until) ? 'the movement authorization time is not readable'
    : !positions ? 'the movement authorization names no positions (NEXUS_MOVES_POSITIONS)' : pallets === false ? 'the movement authorization pallet list is not readable' : null;
  return { until: Number.isFinite(until) ? until : null, positions: positions || null, pallets: pallets || null, problem };
}
/** null when a pallet write naming this pallet and these positions may be sent at this moment; otherwise why not. */
export function moveAuthorization(env, now, { pallet = null, positions = [], floorCodesOnly = false } = {}) {
  const no = (error, why) => ({ status: 503, error, message: `${why}. Nothing was sent to Nexus.` });
  if ((env.NEXUS_BRIDGE_MODE || 'off') === 'production') {
    // the real floor in daily use: only shared floor positions may be named; Nexus and ShipBay's rules decide the rest
    const shared = (x) => /^(P|STG)-\d{2}$/.test(x) || x === 'RCV-OUT';   // numbered positions, staging, and the shared Receiving / Outbound zone
    for (const x of positions.map(pos).filter(Boolean)) if (!shared(x)) return no('move_out_of_scope', `${x} is not a shared floor position`);
    return null;
  }
  const w = readMoveWindow(env); const t = now();
  if (w.problem) return no('move_not_authorized', w.problem[0].toUpperCase() + w.problem.slice(1));
  if (!(t < w.until)) return no('move_window_closed', 'The movement authorization has expired');
  if (w.until - t > MOVE_WINDOW_MAX_MS) return no('move_not_authorized', 'The movement authorization reaches more than 60 minutes ahead and is not accepted');
  const p = pallet ? String(pallet).trim().toUpperCase() : null;
  if (w.pallets && (!p || !w.pallets.includes(p))) return no('move_out_of_scope', `${p || 'This pallet'} is not covered by the movement authorization`);
  // floorCodesOnly (the early check, on what was scanned): a code that is not a shared floor position is left to ShipBay's own rule,
  // which refuses it before anything is written; the check before each request to Nexus always covers every position
  for (const x of positions.map(pos).filter(Boolean)) if (!(floorCodesOnly && !/^(P|STG)-\d{2}$/.test(x)) && !w.positions.includes(x)) return no('move_out_of_scope', `${x} is not covered by the movement authorization`);
  return null;
}
function windowStatus(env, now) {
  const w = readMoveWindow(env); const t = now(); const left = w.until === null ? 0 : Math.floor((w.until - t) / 1000);
  return { open: !w.problem && left > 0 && w.until - t <= MOVE_WINDOW_MAX_MS, closes_at: w.until === null ? null : new Date(w.until).toISOString(), seconds_left: Math.max(0, left), positions: w.positions, pallets: w.pallets, problem: w.problem };
}
const hostOf = (u) => { try { return new URL(String(u)).host; } catch { return ''; } };

const no = (status, error, message) => ({ ok: false, status, error, message });
export function readConfig(env = {}) {
  const mode = env.NEXUS_BRIDGE_MODE || 'off';
  if (mode === 'off') return no(503, 'bridge_off', 'The Nexus connection is switched off here.');
  const onProduction = String(env.SUPABASE_URL || '').includes(PRODUCTION_DB_REF);
  let key, floor, moveKey = null;
  if (mode === 'staging') {
    if (onProduction) return no(503, 'wrong_database', 'The staging connection does not run on the production database.');
    if (!env.NEXUS_STAGING_API_KEY) return no(503, 'not_configured', 'The Nexus staging key is not set.');
    key = env.NEXUS_STAGING_API_KEY; floor = TEST_FLOOR;
  } else if (mode === 'production') {
    // the real floor: only from ShipBay's production database, only with the production key (never the staging key)
    if (!onProduction) return no(503, 'not_production_database', 'The production connection runs only on ShipBay\'s production database.');
    const readKey = String(env.NEXUS_PRODUCTION_READ_KEY || env.NEXUS_PRODUCTION_API_KEY || '').trim();   // ShipBay's company-scoped keys for the real floor
    if (!readKey) return no(503, 'not_configured', 'The Nexus production key is not set.');
    key = readKey; moveKey = String(env.NEXUS_PRODUCTION_API_KEY || '').trim() || null; floor = REAL_FLOOR;
  } else return no(503, 'mode_not_available', 'Unknown connection mode. Use staging or production.');
  if (mode === 'staging') moveKey = key;
  return { ok: true, mode, base: `https://${STAGING_HOST}/functions/v1/nexus`, key, moveKey, floor,
    palletMoves: env.NEXUS_PALLET_MOVES === 'on' && !!moveKey, registryWrites: env.NEXUS_REGISTRY_WRITES === 'on', calendarWrites: env.NEXUS_CALENDAR_WRITES === 'on',
    testFaults: env.NEXUS_TEST_FAULTS === 'on' && hostOf(env.SUPABASE_URL) === DEV_DB_HOST };
}

/** Calls to Nexus. status 0 means no answer arrived (network failure or timeout): the request may or may not have been applied. */
export function nexusClient(cfg, fetchImpl, { timeoutMs = 8000, now = Date.now, guardWrite = () => ({ error: 'move_not_authorized' }) } = {}) {
  let floorAt = 0;
  async function call(method, path, { body, idem, lose } = {}) {
    // last line of defence: no pallet write leaves this client unless the movement authorization covers it at this moment
    if (method !== 'GET' && path.startsWith('/v1/pallets')) { const stop = guardWrite(path, body || {}); if (stop) throw new Error(`pallet write blocked here: ${stop.error}`); }
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(cfg.base + path, { method, signal: ctl.signal, body: body ? JSON.stringify(body) : undefined,
        headers: { authorization: `Bearer ${method !== 'GET' && path.startsWith('/v1/pallets') ? cfg.moveKey : cfg.key}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) } });
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
    if (req.method === 'GET' && path === '/status') return send({ ok: true, connection: cfg.ok ? cfg.mode : 'off', reason: cfg.ok ? null : cfg.error, floor: cfg.ok ? cfg.floor : null, pallet_moves: !!cfg.palletMoves, move_key: cfg.ok ? !!cfg.moveKey : false, registry_writes: !!cfg.registryWrites, calendar_writes: !!cfg.calendarWrites, test_faults: !!cfg.testFaults, move_window: cfg.ok && cfg.mode === 'production' ? null : windowStatus(env, now) });
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
    nx = nx || nexusClient(cfg, fetchImpl, { timeoutMs, now, guardWrite: (_p, b) => (readConfig(env).palletMoves ? moveAuthorization(env, now, { pallet: b.pallet, positions: [b.to, b.from] }) : { error: 'pallet_moves_off' }) });
    const authorize = (scope) => moveAuthorization(env, now, scope);
    try { return await route.run({ cfg, nx, user, service: db.service, body, query: url.searchParams, send, fail, now, fault, authorize }); }
    catch { return fail(500, 'bridge_error', 'The request could not be completed. Nothing further was sent.'); }   // the cause is not returned or logged
  };
}

/** Plain words for the floor, for each Nexus refusal. Nexus's own message is not passed on. Unknown codes name the code,
 *  the HTTP status and the request id, so an admin can find the exact request in ShipBay's journal and in Nexus. */
export function inWords(error, { pallet, to, http, request } = {}) {
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
    zone_status_required: 'Nexus needs to know whether the pallet in Receiving / Outbound is inbound or outbound. Nothing was recorded. Choose one and send it again.',
    location_not_confirmed: `Nexus did not receive the confirmation that ${to} is physically empty, so nothing was placed. Confirm at the position and try again; if it repeats, tell an admin.`,
    location_not_a_destination: `${to} cannot take a pallet in Nexus. Pick a pallet or staging position.`,
    floor_not_ready: 'The shared floor is not open for placements in Nexus yet. Nothing was placed. Tell an admin.',
    floor_not_empty: 'Nexus refused because the floor is not in the state it expects. Nothing was placed. Tell an admin.',
    capacity_below_occupancy: `${to} holds more pallets in Nexus than its capacity allows. Tell an admin.`,
    bad_request: 'Nexus could not read the request. Nothing was placed. Tell an admin.',
    not_found: 'Nexus does not offer this action. Nothing was placed. Tell an admin.',
  })[error] || `Nexus refused the request${[error, http && `HTTP ${http}`].filter(Boolean).length ? ` (${[error, http && `HTTP ${http}`].filter(Boolean).join(', ')})` : ''}. Nothing was placed.${request ? ` Request ${request}.` : ''} Tell an admin.`;
}
