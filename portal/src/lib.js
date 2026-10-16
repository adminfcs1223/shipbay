import { createClient } from '@supabase/supabase-js';

export const STORAGE_KEY = 'shipbay-auth';

export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_KEY, {
  auth: { storageKey: STORAGE_KEY },
});

/** Forget the session in THIS browser origin only — no server call, so the session stays valid elsewhere (e.g. after handing it to dashboard.). */
export function forgetLocalSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
}
