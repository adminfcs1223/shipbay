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

export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_KEY, {
  auth: { storageKey: STORAGE_KEY },
});

/** Forget the session in THIS browser origin only — no server call, so the session stays valid elsewhere (e.g. after handing it to dashboard.). */
export function forgetLocalSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
}
