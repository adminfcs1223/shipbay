// ONE-OFF SWITCH-STATUS PROBE. shipbay-nexus-dev ONLY. Read-only: it reads environment names and answers with words, never
// with a value. No database call, no call to the bridge, no call to Nexus, no sign-in. It cannot write anything.
// The installed Nexus key is identified only by the first 8 hex of its SHA-256 (the prefix Nexus shows for nexus.integrations
// key_hash), so it can be matched to its integration without the key ever being shown.
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
  const on = (n: string) => (Deno.env.get(n) === 'on' ? 'ON' : Deno.env.get(n) ? 'set, not on' : 'off (unset)');
  const set = (n: string) => (Deno.env.get(n) ? 'SET' : 'unset');
  const mode = Deno.env.get('NEXUS_BRIDGE_MODE'); const modeWord = !mode ? 'off (unset)' : mode === 'off' ? 'off' : mode === 'staging' ? 'staging' : 'other';
  const key = Deno.env.get('NEXUS_STAGING_API_KEY') || '';
  const body = { ok: true, at: new Date().toISOString(), database: host, NEXUS_BRIDGE_MODE: modeWord,
    NEXUS_PALLET_MOVES: on('NEXUS_PALLET_MOVES'), NEXUS_REGISTRY_WRITES: on('NEXUS_REGISTRY_WRITES'), NEXUS_CALENDAR_WRITES: on('NEXUS_CALENDAR_WRITES'),
    NEXUS_TEST_FAULTS: on('NEXUS_TEST_FAULTS'), NEXUS_MOVES_UNTIL: set('NEXUS_MOVES_UNTIL'), NEXUS_MOVES_POSITIONS: set('NEXUS_MOVES_POSITIONS'),
    NEXUS_MOVES_PALLETS: set('NEXUS_MOVES_PALLETS'), NEXUS_STAGING_API_KEY: key ? `set, key_hash prefix ${(await sha256(key)).slice(0, 8)}` : 'unset',
    BRIDGE_ALLOWED_ORIGINS: Deno.env.get('BRIDGE_ALLOWED_ORIGINS') || 'unset' };
  return new Response(JSON.stringify(body, null, 1), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
});
