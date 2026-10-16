// Hostname layout:
//   auth.shipbay3pl.com       → sign-in only; hands the session to the dashboard host after login
//   dashboard.shipbay3pl.com  → the app; bounces to auth. when there is no session
//   anything else (localhost, *.netlify.app, deploy previews) → single-host mode: sign-in and app on the same origin
export const AUTH_HOST = 'auth.shipbay3pl.com';
export const APP_HOST = 'dashboard.shipbay3pl.com';

const h = typeof window !== 'undefined' ? window.location.hostname : '';
export const isAuthHost = h === AUTH_HOST;
export const isAppHost = h === APP_HOST;
export const splitMode = isAuthHost || isAppHost;

export const authUrl = () => (splitMode ? `https://${AUTH_HOST}/` : '/');
export const appUrl = () => (splitMode ? `https://${APP_HOST}/` : '/');

/** After sign-in on auth., carry the session to the app host in the URL fragment (never the query string, so it is not logged). */
export function handoffToApp(session) {
  // keys deliberately differ from Supabase's own implicit-flow names so its URL detector ignores this fragment
  const p = new URLSearchParams({ sb_at: session.access_token, sb_rt: session.refresh_token });
  window.location.replace(`${appUrl()}#${p.toString()}`);
}

/** On the app host: pick up a handed-off session from the fragment, then scrub it from the URL. Returns tokens or null. */
export function takeHandoff() {
  if (!window.location.hash.includes('sb_at=')) return null;
  const p = new URLSearchParams(window.location.hash.slice(1));
  const t = { access_token: p.get('sb_at'), refresh_token: p.get('sb_rt') };
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return t.access_token && t.refresh_token ? t : null;
}
