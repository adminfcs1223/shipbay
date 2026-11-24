// The WMS's only route to Nexus: ShipBay's own server-side bridge (supabase/functions/nexus-bridge). The browser sends the
// signed-in user's ShipBay login to the bridge and never holds, sees or sends a Nexus key.
//   VITE_NEXUS_BRIDGE unset: the feature is off. The WMS is exactly as it was: no Put-away tab, no bridge call.
//   VITE_NEXUS_BRIDGE=on:    the Put-away tab appears and talks to the bridge of the database this build points at.
// This build refuses to use the bridge of ShipBay's production database, whatever the setting says: the bridge it would
// find there is staging-only and would refuse too, and the floor must not be shown a put-away screen that cannot work.
//   VITE_NEXUS_BRIDGE=production: the same screen on ShipBay's production database (the real floor), and only there.
const FLAG = ((import.meta.env && import.meta.env.VITE_NEXUS_BRIDGE) || '');
const BASE = (import.meta.env && import.meta.env.VITE_SUPABASE_URL) || ''; const KEY = (import.meta.env && import.meta.env.VITE_SUPABASE_KEY) || '';
export const PRODUCTION_DB_REF = 'poxlczzkpztmoiixyrth';
const ON_PRODUCTION = BASE.includes(PRODUCTION_DB_REF);
export const BRIDGE = !!BASE && ((FLAG === 'on' && !ON_PRODUCTION) || (FLAG === 'production' && ON_PRODUCTION));

let tokenOf = async () => null;
/** The app tells the bridge client how to get the signed-in user's access token. */
export const useBridgeToken = (fn) => { tokenOf = fn; };

/** One call. Always resolves: { ok, status, error?, message?, ... }. status 0 = the WMS's own server gave no answer. */
export async function bridge(path, { method = 'GET', body } = {}) {
  if (!BRIDGE) return { ok: false, status: 0, error: 'bridge_off', message: 'The Nexus connection is not part of this build.' };
  const token = await tokenOf(); if (!token) return { ok: false, status: 401, error: 'sign_in', message: 'Sign in again.' };
  let r;
  try { r = await fetch(`${BASE}/functions/v1/nexus-bridge${path}`, { method, headers: { authorization: `Bearer ${token}`, apikey: KEY, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); }
  catch { return { ok: false, status: 0, error: 'no_answer', message: 'No answer from the WMS server. Nothing is confirmed. Check the connection, then check the pallet before scanning again.' }; }
  let j = null; try { j = await r.json(); } catch { /* not JSON */ }
  return j && typeof j === 'object' ? { ...j, status: r.status } : { ok: false, status: r.status, error: 'bad_answer', message: 'The WMS server gave an answer that could not be read. Nothing is confirmed.' };
}
