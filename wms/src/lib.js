import { createClient } from '@supabase/supabase-js';

// Same Supabase project and the same logins as dashboard.shipbay3pl.com; the WMS keeps its own session on its own host.
export const STORAGE_KEY = 'shipbay-wms-auth';
// Embedded in the dashboard (?embed): no session of its own. The dashboard hands over the signed-in user's access token.
export const EMBED = new URLSearchParams(window.location.search).has('embed');
export const PARENT_ORIGINS = ['https://dashboard.shipbay3pl.com'];
let access = null; const subs = new Set();
export const setAccess = (a) => { access = a; subs.forEach((f) => f(a)); };
export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_KEY,
  EMBED ? { accessToken: async () => access?.token ?? null } : { auth: { storageKey: STORAGE_KEY } });
// the current access token and user, whichever way this WMS is signed in (used to hand the login on to the Nexus frame)
export async function getAccess() { if (EMBED) return access; const s = (await supabase.auth.getSession()).data.session; return s ? { token: s.access_token, user: s.user.id } : null; }
export function onAccess(fn) {
  if (EMBED) { subs.add(fn); return () => subs.delete(fn); }
  const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { if (s) fn({ token: s.access_token, user: s.user.id }); });
  return () => sub.subscription.unsubscribe();
}
export const signOut = () => (EMBED ? null : supabase.auth.signOut());
export const WMS_ROLES = ['shipbay_admin', 'shipbay_staff', 'wms_employee'];
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmtTime = (d) => new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
export const fmtDay = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
export const fmtStamp = (d) => `${fmtDay(d)} · ${fmtTime(d)}`;
export const sameDay = (a, b = new Date()) => new Date(a).toDateString() === new Date(b).toDateString();
