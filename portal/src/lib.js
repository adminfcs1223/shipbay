import { createClient } from '@supabase/supabase-js';

export const STORAGE_KEY = 'shipbay-auth';
// A password-reset link lands with #…&type=recovery. Capture that BEFORE the client scrubs the URL, so the app can show
// the "choose a new password" screen instead of treating it as an ordinary sign-in.
export const RECOVERY_LANDING = typeof window !== 'undefined' && /[#&]type=recovery/.test(window.location.hash);
// Our own reset link (sent by the password-reset function): auth.shipbay3pl.com/?reset=<token>. Read it, then scrub the URL.
export const RESET_TOKEN = (() => {
  if (typeof window === 'undefined') return null;
  const t = new URLSearchParams(window.location.search).get('reset');
  if (t) history.replaceState(null, '', window.location.pathname);
  return t;
})();

// "View as client": an admin opens a brand's portal exactly as the brand sees it. While it is on, every read of a
// table that carries org_id is narrowed to that brand (an admin's own access would show every brand), and nothing can
// be changed: writes, function calls and uploads are refused here, before they leave the browser.
let viewAsOrg = null;
export const setViewAsOrg = (id) => { viewAsOrg = id || null; };
const ORG_TABLES = new Set(['documents', 'inbound_shipments', 'integrations', 'inventory_levels', 'inventory_list_items', 'inventory_lists', 'inventory_moves', 'invoices', 'onboarding_tasks', 'orders', 'org_integrations', 'profiles', 'quotes', 'rate_cards', 'returns', 'shipments', 'skus', 'storage_snapshots', 'tickets', 'ticket_messages', 'v_onboarding_progress', 'wms_cartons', 'wms_pallets', 'wms_pick_problems', 'wms_units']);
const VIEW_RPCS = new Set(['wms_org_connector']);   // read-only functions the client pages call
const refused = () => Promise.resolve(new Response(JSON.stringify({ message: 'You are viewing this as the client. Nothing can be changed from here.', code: 'VIEW_ONLY' }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
const guardedFetch = (input, init = {}) => {
  if (!viewAsOrg) return fetch(input, init);
  let url; try { url = new URL(typeof input === 'string' ? input : input.url); } catch { return fetch(input, init); }
  const read = ['GET', 'HEAD'].includes((init.method || 'GET').toUpperCase());
  const rest = /\/rest\/v1\/(rpc\/)?([^/?]+)/.exec(url.pathname);
  if (rest && rest[1]) return VIEW_RPCS.has(rest[2]) ? fetch(input, init) : refused();
  if (rest) {
    if (!read) return refused();
    if (ORG_TABLES.has(rest[2]) && !url.searchParams.has('org_id')) url.searchParams.append('org_id', `eq.${viewAsOrg}`);
    if (rest[2] === 'orgs' && !url.searchParams.has('id')) url.searchParams.append('id', `eq.${viewAsOrg}`);
    return fetch(url.toString(), init);
  }
  if (/\/functions\/v1\//.test(url.pathname)) return refused();
  if (/\/storage\/v1\/object\//.test(url.pathname) && !read && !/\/object\/(sign|list)\//.test(url.pathname)) return refused();
  return fetch(input, init);
};

export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_KEY, {
  auth: { storageKey: STORAGE_KEY },
  global: { fetch: guardedFetch },
});

/** Forget the session in THIS browser origin only — no server call, so the session stays valid elsewhere (e.g. after handing it to dashboard.). */
export function forgetLocalSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
}

/** Call an Edge Function and surface the JSON error it returned (FunctionsHttpError hides it in context). */
export async function fn(name, body, headers) {
  const { data, error } = await supabase.functions.invoke(name, { body, headers });
  if (error) {
    let msg = error.message; try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch { /* keep */ }
    return { error: msg };
  }
  return data || {};
}
