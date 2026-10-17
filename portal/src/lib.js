import { createClient } from '@supabase/supabase-js';

export const STORAGE_KEY = 'shipbay-auth';
// A password-reset link lands with #…&type=recovery. Capture that BEFORE the client scrubs the URL, so the app can show
// the "choose a new password" screen instead of treating it as an ordinary sign-in.
export const RECOVERY_LANDING = typeof window !== 'undefined' && /[#&]type=recovery/.test(window.location.hash);

export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_KEY, {
  auth: { storageKey: STORAGE_KEY },
});

/** Forget the session in THIS browser origin only — no server call, so the session stays valid elsewhere (e.g. after handing it to dashboard.). */
export function forgetLocalSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
}
