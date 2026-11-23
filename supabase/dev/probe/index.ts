// ONE-OFF DISABLED-MODE PROBE. shipbay-nexus-dev ONLY. Not the movement runner: no suite, no stages, no database writes.
// It signs the three synthetic logins in through Supabase Auth and asks the DEPLOYED bridge questions that must all be refused
// while the bridge is switched off. It names only a pallet and a position that do not exist. It never reads the Nexus key.
// As shipped the gate is closed (bare 404). At deploy: GATE.sha256 = SHA-256 of a fresh token, GATE.notAfter = 15 minutes ahead.
// Deployed with verify_jwt off into the "bridge-smoke" slot, called three times (?part=1|2|3), then replaced by the inert stub.
// Three parts because Supabase allows one function about 30 calls to another function per request.
const GATE = { sha256: 'CLOSED', notAfter: 0 };
const DEV_HOST = 'gdoaonsasbsperqjuurm.supabase.co';
const PRODUCTION_REF = 'poxlczzkpztmoiixyrth';
const LOGINS: Record<string, [string, string]> = {
  floor: ['test-floor@example.test', '5b000000-0000-4000-8000-000000000002'],
  admin: ['test-admin@example.test', '5b000000-0000-4000-8000-000000000001'],
  client: ['test-client@example.test', '5b000000-0000-4000-8000-000000000004'],
};
const NO_PALLET = 'PSKU-999999', NO_POSITION = 'P-99';
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const inert = () => new Response('{"ok":false}', { status: 404, headers: { 'content-type': 'application/json' } });
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

Deno.serve(async (req: Request) => {
  const u = new URL(req.url);
  if (req.method !== 'GET' || !/^[0-9a-f]{64}$/.test(GATE.sha256) || !(Date.now() < GATE.notAfter)) return inert();
  if ((await sha256(u.searchParams.get('t') || '')) !== GATE.sha256) return inert();
  const url = String(Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, ''); const anon = Deno.env.get('SUPABASE_ANON_KEY') || '', service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  let host = ''; try { host = new URL(url).host; } catch { /* none */ }
  if (host !== DEV_HOST || url.includes(PRODUCTION_REF) || !anon || !service) return json({ ok: false, error: 'not_the_dev_database' }, 503);
  const part = u.searchParams.get('part'); if (!['1', '2', '3'].includes(part || '')) return json({ ok: false, error: 'part', parts: ['1', '2', '3'] }, 400);
  const bridge = `${url}/functions/v1/nexus-bridge`;
  const checks: { ok: boolean; name: string; got?: unknown }[] = []; const secrets = [anon, service];
  const check = (name: string, ok: boolean, got?: unknown) => checks.push(ok ? { ok, name } : { ok, name, got });
  let out: Record<string, unknown>;
  try {
    // genuine sessions, issued and confirmed by Auth
    const tok: Record<string, string> = {}; const sessions: Record<string, unknown> = {};
    for (const [who, [email, id]] of Object.entries(LOGINS)) {
      const g = await fetch(`${url}/auth/v1/admin/generate_link`, { method: 'POST', headers: { apikey: service, authorization: `Bearer ${service}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', email }) });
      const gj = await g.json().catch(() => ({})); const hash = gj.hashed_token || gj.properties?.hashed_token; if (!g.ok || !hash) throw new Error(`sign-in link for ${who} not issued (${g.status})`);
      const v = await fetch(`${url}/auth/v1/verify`, { method: 'POST', headers: { apikey: anon, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: hash }) });
      const vj = await v.json().catch(() => ({})); if (!v.ok || !vj.access_token) throw new Error(`sign-in for ${who} not accepted (${v.status})`);
      const me = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anon, authorization: `Bearer ${vj.access_token}` } }); const mj = await me.json().catch(() => ({}));
      const confirmed = me.ok && mj.id === id && mj.email === email && mj.role === 'authenticated' && vj.access_token !== service && vj.access_token !== anon;
      check(`Auth issued and confirmed a session for the ${who} login`, confirmed, { status: me.status });
      tok[who] = vj.access_token; secrets.push(vj.access_token); sessions[who] = { email, confirmed_by_auth: confirmed };
    }
    const bearer = (who: string | null) => (who === null ? null : who === 'public' ? anon : who === 'garbage' ? 'not.a.token' : tok[who]);
    const ask = async (who: string | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
      const b = bearer(who); const r = await fetch(bridge + path, { method, headers: { ...(b ? { authorization: `Bearer ${b}`, apikey: anon } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); let j: Record<string, unknown> = {}; try { j = t ? JSON.parse(t) : {}; } catch { /* not JSON */ } return { status: r.status, ...j } as Record<string, unknown>;
    };
    const rpc = async (who: string, fn: string) => { const r = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: anon, authorization: `Bearer ${bearer(who)}`, 'content-type': 'application/json' }, body: '{}' }); const t = await r.text(); let j: unknown = null; try { j = JSON.parse(t); } catch { /* */ } return { status: r.status, body: j }; };

    const body = { psku: NO_PALLET, location: NO_POSITION, to: NO_POSITION, reason: 'shipped_out', confirmed: true, apply: true };
    const posts = ['/putaway', '/move', '/release', '/pending/retry', '/reconcile/record', '/reconcile/undo', '/registry/sync', '/calendar/sync'];
    const gets = ['/floor', '/pending', '/reconcile', '/calendar?from=2026-11-23&to=2026-11-30'];
    const routesFor = async (who: string) => {
      for (const p of posts) { const r = await ask(who, 'POST', p, body); check(`${who}: POST ${p} refused 503 bridge_off`, r.status === 503 && r.error === 'bridge_off', [r.status, r.error]); }
      for (const p of gets) { const r = await ask(who, 'GET', p); check(`${who}: GET ${p} refused 503 bridge_off`, r.status === 503 && r.error === 'bridge_off', [r.status, r.error]); }
    };
    const statusOf: Record<string, unknown> = {};
    if (part === '1') {
    // 1. no authentication
    for (const [who, label] of [[null, 'no authorization header'], ['garbage', 'a made-up token']] as [string | null, string][]) {
      for (const [m, p] of [['GET', '/status'], ['POST', '/putaway'], ['POST', '/move'], ['POST', '/release']]) { const r = await ask(who, m, p, m === 'POST' ? { psku: NO_PALLET, location: NO_POSITION } : undefined); check(`${label}: ${m} ${p} is rejected with 401`, r.status === 401, r.status); }
    }
    // 2. health and status
    for (const who of ['floor', 'admin', 'client', 'public']) {
      const s = await ask(who, 'GET', '/status'); statusOf[who] = s;
      check(`${who}: /status answers 200`, s.status === 200 && s.ok === true, s.status);
      check(`${who}: connection off, reason bridge_off`, s.connection === 'off' && s.reason === 'bridge_off', [s.connection, s.reason]);
      check(`${who}: pallet moves, registry writes, calendar writes and test faults all false`, s.pallet_moves === false && s.registry_writes === false && s.calendar_writes === false && s.test_faults === false, s);
      check(`${who}: no floor named`, s.floor === null, s.floor);
    }
      await routesFor('floor');
    }
    if (part === '2') { await routesFor('admin'); await routesFor('client'); }
    if (part === '3') {
    await routesFor('public');
    for (const who of ['floor', 'admin', 'client']) {
      for (const p of ['/putaway', '/move', '/release']) {
        const r = await ask(who, 'POST', p, body, { 'x-nexus-test-fault': 'lose-answer' });
        check(`${who}: POST ${p} with the lost-answer header refused 503 bridge_off, no fault produced`, r.status === 503 && r.error === 'bridge_off' && !('test_fault' in r), [r.status, r.error, r.test_fault]);
      }
    }
    const sf = await ask('floor', 'GET', '/status', undefined, { 'x-nexus-test-fault': 'lose-answer' });
    check('floor: /status with the lost-answer header still reports test faults false', sf.status === 200 && sf.test_faults === false, sf);
    // 4. what the database says about each login (read-only calls)
    for (const [who, want] of [['floor', true], ['admin', true], ['client', false]] as [string, boolean][]) { const r = await rpc(who, 'is_wms_staff'); check(`${who}: is_wms_staff is ${want}`, r.status === 200 && r.body === want, r); }
    const ex = await rpc('client', 'wms_nexus_exceptions'); check('client: the exceptions report is refused by the database', ex.status >= 400, ex.status);
    const exPub = await rpc('public', 'wms_nexus_exceptions'); check('public key: the exceptions report is refused by the database', exPub.status >= 400, exPub.status);
    // the report is for ShipBay admin and staff; the floor login (wms_employee) is refused by design. As run on 2026-11-23 this probe wrongly expected the floor login to read it.
    const exFloor = await rpc('floor', 'wms_nexus_exceptions'); check('floor: the exceptions report is refused by the database', exFloor.status >= 400, exFloor.status);
    const exAdmin = await rpc('admin', 'wms_nexus_exceptions'); check('admin: the exceptions report is readable', exAdmin.status === 200, exAdmin.status);
    }
    const failed = checks.filter((c) => !c.ok);
    out = { ok: failed.length === 0, probe: 'disabled-mode', part, at: new Date().toISOString(), passed: checks.length - failed.length, failed: failed.length, total: checks.length, sessions, status_seen_by_floor: statusOf.floor, failures: failed, checks: checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`) };
  } catch (e) { out = { ok: false, probe: 'disabled-mode', error: 'probe_failed', message: String((e as Error)?.message || e).slice(0, 300), checks }; }
  const text = JSON.stringify(out); if (secrets.some((s) => s.length >= 12 && text.includes(s))) out = { ok: false, error: 'withheld' };
  return json(out);
});
