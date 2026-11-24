// TEMPORARY TEST RUNNER for the hosted movement rehearsal. shipbay-nexus-dev ONLY. NOT DEPLOYED.
// It exists because the test machine cannot reach Supabase and the four synthetic logins have no passwords. Deployed (when
// Derek approves a run) into the existing "bridge-smoke" slot, used, then replaced by the inert stub again.
//
// What it does, per request:  GET ?t=<one-time token>&stage=<preflight|move|release|lost|partial|undo|picks|stops|final>
//   1. Refuses unless: the token matches the hash compiled in at deploy, the deploy-time expiry has not passed, and the
//      database it is attached to is shipbay-nexus-dev. Any other request gets a bare 404.
//   2. Records the start (dev_runner_begin). A stage that writes can be started once; a reload or retry is refused there.
//   3. Signs in the synthetic logins THROUGH SUPABASE AUTH (admin magic link, then the normal verify call), checks with
//      Auth that each token belongs to the login it was issued for, and uses those tokens as the callers. The service
//      login is never sent to the bridge as anyone's identity.
//   4. Runs the stage from tests/hosted/suite.js against the DEPLOYED bridge over HTTPS.
//   5. Stores the result (dev_runner_finish) and returns it.  GET ?t=...&read=<stage> reads stored results back.
//
// Lost answers are produced by the DEPLOYED bridge itself (its dev-only NEXUS_TEST_FAULTS setting, asked for with the header
// x-nexus-test-fault: lose-answer on a signed-in staff request). This runner holds no bridge code and never reads the Nexus key.
//
// The MVP rehearsal (supabase/dev/MVP-REHEARSAL.md):  GET ?t=<token>&stage=mvp[&position=P-49][&until=preflight|receive|putaway]
//   runs tests/hosted/mvp.js against the deployed bridge and answers with the result when it is done (no dev_runner_begin /
//   dev_runner_finish: those accept only the nine movement stages, and the MVP step is written to be run again safely after a
//   stop, so nothing here needs a schema change). Lost-answer faults are never asked for. It cannot change any switch.
//
// It never logs, returns or stores a key or a token: the result is searched for every secret it handled before it leaves.
import { postgrest } from '../../functions/nexus-bridge/postgrest.js';
import { runStage, STAGES } from '../../tests/hosted/suite.js';
import { runMvp } from '../../tests/hosted/mvp.js';

export const DEV_HOST = 'gdoaonsasbsperqjuurm.supabase.co';
const PRODUCTION_DB_REF = 'poxlczzkpztmoiixyrth';
const FAULT_HEADER = 'x-nexus-test-fault';
const LOGINS = {
  floor: ['test-floor@example.test', '5b000000-0000-4000-8000-000000000002'],
  admin: ['test-admin@example.test', '5b000000-0000-4000-8000-000000000001'],
  client: ['test-client@example.test', '5b000000-0000-4000-8000-000000000004'],
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const inert = () => new Response('{"ok":false}', { status: 404, headers: { 'content-type': 'application/json' } });
const sha256 = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const equal = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

/**
 *   env        the function's settings (Deno.env)
 *   fetchImpl  fetch
 *   gate       { sha256, notAfter }: set in index.ts at deploy. Left as shipped, every request gets 404.
 *   defer      how a started stage keeps running after the answer is sent (EdgeRuntime.waitUntil)
 */
export function makeRunner({ env, fetchImpl, gate, defer = (_work) => {}, now = Date.now }) {
  const url = String(env.SUPABASE_URL || '').replace(/\/+$/, ''); const anonKey = env.SUPABASE_ANON_KEY, serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const bridge = `${url}/functions/v1/nexus-bridge`;
  const db = postgrest({ url, anonKey, serviceKey, fetchImpl });

  async function signIn() {
    const tokens = {}; const proof = {};
    for (const [who, [email, id]] of Object.entries(LOGINS)) {
      const g = await fetchImpl(`${url}/auth/v1/admin/generate_link`, { method: 'POST', headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', email }) });
      const gj = await g.json().catch(() => ({})); const hash = gj.hashed_token || gj.properties?.hashed_token; if (!g.ok || !hash) throw new Error(`sign-in link for ${who} was not issued (${g.status})`);
      const v = await fetchImpl(`${url}/auth/v1/verify`, { method: 'POST', headers: { apikey: anonKey, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: hash }) });
      const vj = await v.json().catch(() => ({})); if (!v.ok || !vj.access_token) throw new Error(`sign-in for ${who} was not accepted (${v.status})`);
      // Auth itself confirms whose token this is
      const u = await fetchImpl(`${url}/auth/v1/user`, { headers: { apikey: anonKey, authorization: `Bearer ${vj.access_token}` } }); const uj = await u.json().catch(() => ({}));
      if (!u.ok || uj.id !== id || uj.email !== email || uj.role !== 'authenticated') throw new Error(`Auth did not confirm the session for ${who}`);
      tokens[who] = vj.access_token; proof[who] = { email, issued_by_auth: true, role: uj.role, is_service_login: vj.access_token === serviceKey };
    }
    return { tokens, proof };
  }

  function makeIo(tokens, count) {
    const bearer = (who) => (who === null ? null : who === 'public' ? anonKey : tokens[who]);
    const headers = (who, body, extra = {}) => { const b = bearer(who); if (who !== null && !b) throw new Error(`no session for ${who}`); return { ...(b ? { authorization: `Bearer ${b}`, apikey: anonKey } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...extra }; };
    const read = async (r) => { const text = await r.text(); let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { /* not JSON */ } return { ...(j && typeof j === 'object' ? j : {}), status: r.status }; };
    // the deployed bridge, over HTTPS
    const send = async (who, method, path, body, extra) => read(await fetchImpl(bridge + path, { method, headers: headers(who, body, extra), body: body ? JSON.stringify(body) : undefined }));
    const call = (who, method, path, body) => { count.deployed++; return send(who, method, path, body); };
    // the same deployed bridge, asked to drop Nexus's answer to this one write (it says so in its reply)
    const lossy = async (who, method, path, body) => { count.lossy++; const r = await send(who, method, path, body, { [FAULT_HEADER]: 'lose-answer' }); return { ...r, lost: r.test_fault === 'answer_lost' }; };
    // two table steps the MVP rehearsal takes as the signed-in login (row security applies), over the same REST interface
    const table = async (who, method, path, body) => { count.rpc++;
      const r = await fetchImpl(`${url}/rest/v1/${path}`, { method, headers: { ...headers(who, body), ...(method === 'GET' ? {} : { prefer: 'return=representation' }) }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text(); let j = null; try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (!r.ok) throw new Error((j && typeof j.message === 'string' && j.message) || `The database refused the request (${r.status}).`); return j; };
    const uuid = (v) => { if (!/^[0-9a-f-]{36}$/.test(String(v))) throw new Error('not an id'); return v; };
    const product = async (who, row) => {
      const have = await table(who, 'GET', `skus?select=id,sku,org_id&org_id=eq.${uuid(row.org_id)}&sku=eq.${encodeURIComponent(row.sku)}`);
      if (!Array.isArray(have) || have.length > 1) throw new Error('The product list could not be read.'); if (have.length === 1) return have[0];
      const made = await table(who, 'POST', 'skus?select=id,sku,org_id', { org_id: row.org_id, sku: row.sku, name: row.name, barcode: row.barcode });
      if (!Array.isArray(made) || made.length !== 1) throw new Error('The product was not created.'); return made[0]; };
    const cancelOrder = async (who, id) => {
      const r = await table(who, 'PATCH', `orders?id=eq.${uuid(id)}&select=id,status`, { status: 'cancelled' });
      if (!Array.isArray(r) || r.length !== 1 || r[0].status !== 'cancelled') throw new Error('The cancel did not change exactly one order.'); };
    return { call, lossy, product, cancelOrder, rpc: (who, fn, args) => { count.rpc++; return db.user(bearer(who)).rpc(fn, args); },
      snapshot: () => db.service.rpc('dev_movement_snapshot', {}), faultHold: (psku, reason) => db.service.rpc('dev_fault_hold', { p_psku: psku, p_reason: reason }) };
  }

  return async function handle(req) {
    const u = new URL(req.url);
    if (req.method !== 'GET' || !gate || !/^[0-9a-f]{64}$/.test(String(gate.sha256)) || !(now() < Number(gate.notAfter))) return inert();
    if (!equal(await sha256(u.searchParams.get('t') || ''), gate.sha256)) return inert();
    let host = ''; try { host = new URL(url).host; } catch { /* no address */ }
    if (host !== DEV_HOST || url.includes(PRODUCTION_DB_REF) || !anonKey || !serviceKey) return json({ ok: false, error: 'not_the_dev_database', message: 'This runner only works on shipbay-nexus-dev. Nothing was done.' }, 503);

    if (u.searchParams.has('read')) { try { return json({ ok: true, runs: await db.service.rpc('dev_runner_read', { p_stage: u.searchParams.get('read') || null }) }); } catch (e) { return json({ ok: false, error: 'not_read', message: String(e?.message || e).slice(0, 200) }, 500); } }
    if (u.searchParams.get('stage') === 'mvp') {
      const started = now(); const count = { deployed: 0, lossy: 0, rpc: 0 }; const secrets = [serviceKey, anonKey].filter(Boolean); let out;
      const until = u.searchParams.get('until'); if (until && !['preflight', 'receive', 'putaway'].includes(until)) return json({ ok: false, error: 'unknown_until' }, 400);
      try {
        const { tokens, proof } = await signIn(); secrets.push(...Object.values(tokens));
        const result = await runMvp(makeIo(tokens, count), { position: u.searchParams.get('position') || 'P-50', stopAfter: until || null, faults: false });
        out = { ...result, sessions: proof, calls: count, elapsed_ms: now() - started };
      } catch (e) { out = { ok: false, runner: 'mvp', error: 'runner_failed', message: String(e?.message || e).slice(0, 300), calls: count, elapsed_ms: now() - started }; }
      const text = JSON.stringify(out); if (secrets.some((s) => s.length >= 12 && text.includes(s))) out = { ok: false, runner: 'mvp', error: 'withheld', message: 'The result contained a key or a token and was not returned.' };
      return json(out);
    }
    const stage = u.searchParams.get('stage'); if (!STAGES.includes(stage)) return json({ ok: false, error: 'unknown_stage', stages: STAGES }, 400);
    let run; try { run = await db.service.rpc('dev_runner_begin', { p_stage: stage }); } catch (e) { return json({ ok: false, error: 'not_started', message: String(e?.message || e).slice(0, 200) }, 409); }

    const work = (async () => {
      const started = now(); const count = { deployed: 0, lossy: 0, rpc: 0 }; let out; const secrets = [serviceKey, anonKey].filter(Boolean);
      try {
        const { tokens, proof } = await signIn(); secrets.push(...Object.values(tokens));
        const result = await runStage(makeIo(tokens, count), stage);
        out = { ...result, runner: 'movement', run, sessions: proof, calls: count, elapsed_ms: now() - started };
      } catch (e) { out = { ok: false, stage, runner: 'movement', run, error: 'runner_failed', message: String(e?.message || e).slice(0, 300), calls: count, elapsed_ms: now() - started }; }
      const text = JSON.stringify(out); if (secrets.some((s) => s.length >= 12 && text.includes(s))) out = { ok: false, stage, runner: 'movement', run, error: 'withheld', message: 'The result contained a key or a token and was not returned or stored.' };
      try { await db.service.rpc('dev_runner_finish', { p_run: run, p_ok: out.ok === true, p_result: out }); } catch { out = { ...out, stored: false }; }
      return out;
    })();
    if (u.searchParams.get('wait') === '1') return json(await work);
    defer(work); return json({ ok: true, started: true, run, stage, read: `?read=${stage}` });
  };
}
