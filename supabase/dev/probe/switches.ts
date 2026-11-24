// ONE-OFF SWITCH-STATUS PROBE. shipbay-nexus-dev ONLY. Read-only: it reads four environment names and answers with words, never
// with a value. No database call, no call to the bridge, no call to Nexus, no sign-in, no key read. It cannot write anything.
// As shipped the gate is closed (bare 404). At deploy: GATE.sha256 = SHA-256 of a fresh token, GATE.notAfter = 10 minutes ahead.
// Deployed with verify_jwt off into the "bridge-smoke" slot, called once (GET ?t=<token>), then replaced by the inert stub
// (supabase/dev/runner/stub.ts, verify_jwt on). Same method Derek approved on 2026-11-23 6:18 PM to confirm the P-02 hold.
const GATE = { sha256: 'CLOSED', notAfter: 0 };
const DEV_HOST = 'gdoaonsasbsperqjuurm.supabase.co';
const inert = () => new Response('{"ok":false}', { status: 404, headers: { 'content-type': 'application/json' } });
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
Deno.serve(async (req: Request) => {
  const u = new URL(req.url);
  if (req.method !== 'GET' || !/^[0-9a-f]{64}$/.test(GATE.sha256) || !(Date.now() < GATE.notAfter)) return inert();
  if ((await sha256(u.searchParams.get('t') || '')) !== GATE.sha256) return inert();
  let host = ''; try { host = new URL(String(Deno.env.get('SUPABASE_URL') || '')).host; } catch { /* none */ }
  if (host !== DEV_HOST) return new Response('{"ok":false,"error":"not_the_dev_database"}', { status: 503, headers: { 'content-type': 'application/json' } });
  const on = (n: string) => (Deno.env.get(n) === 'on' ? 'ON' : 'off');
  const mode = Deno.env.get('NEXUS_BRIDGE_MODE'); const modeWord = !mode || mode === 'off' ? 'off' : mode === 'staging' ? 'staging' : 'other';
  const body = { ok: true, at: new Date().toISOString(), database: host, bridge_mode: modeWord, NEXUS_PALLET_MOVES: on('NEXUS_PALLET_MOVES'), NEXUS_REGISTRY_WRITES: on('NEXUS_REGISTRY_WRITES'), NEXUS_CALENDAR_WRITES: on('NEXUS_CALENDAR_WRITES') };
  return new Response(JSON.stringify(body, null, 1), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
});
