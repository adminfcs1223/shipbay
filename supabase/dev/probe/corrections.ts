// ONE-OFF CORRECTIONS PROBE. shipbay-nexus-dev ONLY. Not the movement runner: no suite, no stages, nothing sent to Nexus.
// It signs the four synthetic logins in through Supabase Auth and calls the three privileged correction functions over HTTP,
// the way any client holding that login's token would. EVERY call is one that must be refused or must fail its checks: the
// pallet, carton and wave stop it names do not exist, so no call can change a row whatever the answer is. The one direct
// ledger write it attempts names a product that does not exist, so it fails on that even if the access rule let it through.
// It also reads the bridge's /status once (read-only) to report the three switches. It never reads the Nexus key.
// As shipped the gate is closed (bare 404). At deploy: GATE.sha256 = SHA-256 of a fresh token, GATE.notAfter = 15 minutes ahead.
// Deployed with verify_jwt off into the "bridge-smoke" slot, called once, then replaced by the inert stub (runner/stub.ts).
const GATE = { sha256: 'CLOSED', notAfter: 0 };
const DEV_HOST = 'gdoaonsasbsperqjuurm.supabase.co';
const PRODUCTION_REF = 'poxlczzkpztmoiixyrth';
const LOGINS: Record<string, [string, string, string]> = {
  admin: ['test-admin@example.test', '5b000000-0000-4000-8000-000000000001', 'shipbay_admin'],
  staff: ['test-staff@example.test', '5b000000-0000-4000-8000-000000000003', 'shipbay_staff'],
  floor: ['test-floor@example.test', '5b000000-0000-4000-8000-000000000002', 'wms_employee'],
  client: ['test-client@example.test', '5b000000-0000-4000-8000-000000000004', 'client_admin'],
};
const NO_ID = '00000000-0000-4000-8000-00000000dead', NO_CARTON = 'C99999901', ORG = '5a000000-0000-4000-8000-0000000000a1';
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
  const checks: { ok: boolean; name: string; got?: unknown }[] = []; const secrets = [anon, service];
  const check = (name: string, ok: boolean, got?: unknown) => checks.push(ok ? { ok, name } : { ok, name, got });
  let out: Record<string, unknown>;
  try {
    const tok: Record<string, string> = {};
    for (const [who, [email, id, role]] of Object.entries(LOGINS)) {
      const g = await fetch(`${url}/auth/v1/admin/generate_link`, { method: 'POST', headers: { apikey: service, authorization: `Bearer ${service}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', email }) });
      const gj = await g.json().catch(() => ({})); const hash = gj.hashed_token || gj.properties?.hashed_token; if (!g.ok || !hash) throw new Error(`sign-in link for ${who} not issued (${g.status})`);
      const v = await fetch(`${url}/auth/v1/verify`, { method: 'POST', headers: { apikey: anon, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: hash }) });
      const vj = await v.json().catch(() => ({})); if (!v.ok || !vj.access_token) throw new Error(`sign-in for ${who} not accepted (${v.status})`);
      const me = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anon, authorization: `Bearer ${vj.access_token}` } }); const mj = await me.json().catch(() => ({}));
      tok[who] = vj.access_token; secrets.push(vj.access_token); if (vj.refresh_token) secrets.push(vj.refresh_token);
      const prof = await fetch(`${url}/rest/v1/profiles?select=role&id=eq.${id}`, { headers: { apikey: anon, authorization: `Bearer ${vj.access_token}` } }); const pj = await prof.json().catch(() => []);
      check(`Auth issued and confirmed a session for the ${who} login, and its profile role is ${role}`, me.ok && mj.id === id && mj.email === email && mj.role === 'authenticated' && vj.access_token !== service && vj.access_token !== anon && Array.isArray(pj) && pj[0]?.role === role, { status: me.status, role: Array.isArray(pj) ? pj[0]?.role : null });
    }
    const bearer = (who: string | null) => (who === null ? null : who === 'public' ? anon : who === 'garbage' ? 'not.a.token' : tok[who]);
    const send = async (who: string | null, path: string, body: unknown, method = 'POST') => {
      const b = bearer(who); const r = await fetch(`${url}/rest/v1/${path}`, { method, headers: { apikey: anon, ...(b ? { authorization: `Bearer ${b}` } : {}), 'content-type': 'application/json', prefer: 'return=representation' }, body: JSON.stringify(body) });
      const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { /* */ } return { status: r.status, message: (j && !Array.isArray(j) ? j.message : null) as string | null, code: (j && !Array.isArray(j) ? j.code : null) as string | null, rows: Array.isArray(j) ? j.length : null };
    };
    const units = (reason: string) => ({ p_pallet: NO_ID, p_item: null, p_units: 5, p_reason: reason });
    const box = (reason: string) => ({ p_carton_code: NO_CARTON, p_units: 3, p_location: null, p_reason: reason });
    const pick = (reason: string) => ({ p_kind: 'wave_stop', p_id: NO_ID, p_to_location: 'A-01', p_reason: reason });
    const staffOnly = /^Only ShipBay admin or staff/;

    // the logins that must be refused
    for (const who of ['floor', 'client']) {
      let r = await send(who, 'rpc/wms_correct_units', units('Probe: this must be refused')); check(`${who}: count correction refused as not admin or staff`, r.status === 400 && staffOnly.test(r.message || ''), r);
      r = await send(who, 'rpc/wms_open_box_correct', box('Probe: this must be refused')); check(`${who}: open box with a corrected count refused`, r.status === 400 && (who === 'floor' ? staffOnly.test(r.message || '') : /cannot open a box/.test(r.message || '')), r);
      r = await send(who, 'rpc/wms_pick_correct', pick('Probe: this must be refused')); check(`${who}: pick correction refused as not admin or staff`, r.status === 400 && staffOnly.test(r.message || ''), r);
      r = await send(who, 'rpc/_wms_open_box_do', box('Probe: this must be refused')); check(`${who}: the internal open-box function cannot be called`, [401, 403, 404].includes(r.status), r);
      r = await send(who, 'inventory_moves', { org_id: ORG, sku_id: NO_ID, qty: -1, reason: 'adjust', note: 'probe: must be refused' }); check(`${who}: a direct ledger write is refused by the access rule`, [401, 403].includes(r.status) && r.code === '42501', r);
      r = await send(who, `wms_cartons?code=eq.${NO_CARTON}`, { units_per_carton: 3 }, 'PATCH'); check(`${who}: a direct carton update touches no row`, r.status >= 400 || r.rows === 0, r);
    }
    for (const [who, label] of [[null, 'no token'], ['public', 'the public key'], ['garbage', 'a made-up token']] as [string | null, string][]) {
      const got: number[] = [];
      for (const [fn, body] of [['wms_correct_units', units('Probe: this must be refused')], ['wms_open_box_correct', box('Probe: this must be refused')], ['wms_pick_correct', pick('Probe: this must be refused')], ['_wms_open_box_do', box('Probe')]] as [string, unknown][]) got.push((await send(who, `rpc/${fn}`, body)).status);
      check(`${label}: the three corrections and the internal function are refused before they run`, got.every((s) => [401, 403, 404].includes(s)), got);
    }
    // admin and staff: past the role check, stopped by the reason rule, then by "not on file"
    for (const who of ['admin', 'staff']) {
      let r = await send(who, 'rpc/wms_correct_units', units('')); check(`${who}: count correction passes the role check and asks for the reason`, r.status === 400 && r.message === 'Say why the count is being corrected.', r);
      r = await send(who, 'rpc/wms_correct_units', units('Probe: no such pallet')); check(`${who}: with a reason it gets as far as looking for the pallet`, r.status === 400 && r.message === 'Pallet not found.', r);
      r = await send(who, 'rpc/wms_open_box_correct', box('x')); check(`${who}: open-box correction passes the role check and asks for a reason of substance`, r.status === 400 && r.message === 'Say why the count differs.', r);
      r = await send(who, 'rpc/wms_open_box_correct', box('Probe: no such carton')); check(`${who}: with a reason it gets as far as looking for the carton`, r.status === 400 && r.message === `${NO_CARTON} is not a carton label on file.`, r);
      r = await send(who, 'rpc/wms_pick_correct', pick('no')); check(`${who}: pick correction passes the role check and asks for the reason`, r.status === 400 && r.message === 'Say why this pick is being corrected.', r);
      r = await send(who, 'rpc/wms_pick_correct', pick('Probe: no such stop')); check(`${who}: with a reason it gets as far as looking for the stop`, r.status === 400 && r.message === 'That stop has no confirmed pick to correct.', r);
      r = await send(who, 'rpc/_wms_open_box_do', box('Probe')); check(`${who}: the internal open-box function cannot be called even by ${who}`, [401, 403, 404].includes(r.status), r);
    }
    // the bridge's switches, read once as the admin login (read-only)
    const sr = await fetch(`${url}/functions/v1/nexus-bridge/status`, { headers: { apikey: anon, authorization: `Bearer ${tok.admin}` } }); const s = await sr.json().catch(() => ({}));
    check('bridge /status: connection off, reason bridge_off', sr.status === 200 && s.connection === 'off' && s.reason === 'bridge_off', [sr.status, s.connection, s.reason]);
    check('bridge /status: pallet moves, registry writes, calendar writes and test faults all false', s.pallet_moves === false && s.registry_writes === false && s.calendar_writes === false && s.test_faults === false, s);
    const failed = checks.filter((c) => !c.ok);
    out = { ok: failed.length === 0, probe: 'corrections', at: new Date().toISOString(), passed: checks.length - failed.length, failed: failed.length, total: checks.length,
      bridge_status: { connection: s.connection, reason: s.reason, pallet_moves: s.pallet_moves, registry_writes: s.registry_writes, calendar_writes: s.calendar_writes, test_faults: s.test_faults, floor: s.floor ?? null },
      failures: failed, checks: checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`) };
  } catch (e) { out = { ok: false, probe: 'corrections', error: 'probe_failed', message: String((e as Error)?.message || e).slice(0, 300), checks }; }
  const text = JSON.stringify(out); if (secrets.some((s) => s.length >= 12 && text.includes(s))) out = { ok: false, error: 'withheld' };
  return json(out);
});
