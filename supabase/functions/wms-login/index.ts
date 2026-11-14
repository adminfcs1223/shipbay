// wms-login — sign in to the WMS with an employee number + 6-digit PIN (no email, no password).
//   POST { employee_no, pin } → { access_token, refresh_token } | 401 { error } | 423 { error, minutes }
// The PIN is checked in the database (wms_pin_login: hashed PIN, five wrong tries lock the number for 15 minutes; it
// never says whether a number exists). On a match this function opens a session for that login with a one-time
// token that never leaves the server. Public endpoint (verify_jwt = false): the PIN check is the gate.
// Deploy: supabase functions deploy wms-login --no-verify-jwt
import { createClient } from 'npm:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const admin = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: cors });
const NO_MATCH = 'That employee number and PIN don’t match.';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const b = await req.json().catch(() => ({}));
  const no = Number(String(b.employee_no ?? '').trim());
  const pin = String(b.pin ?? '').trim();
  if (!Number.isInteger(no) || no < 1 || no > 999999 || !/^[0-9]{6}$/.test(pin)) return json({ error: NO_MATCH }, 401);

  const { data: res, error } = await admin.rpc('wms_pin_login', { p_no: no, p_pin: pin });
  if (error) return json({ error: 'Sign-in is unavailable right now. Try again in a minute.' }, 500);
  if (res?.locked) return json({ error: `Too many wrong PINs. This number is locked for ${res.minutes} minute${res.minutes === 1 ? '' : 's'}.`, minutes: res.minutes }, 423);
  if (!res?.ok || !res.email) return json({ error: NO_MATCH }, 401);

  // one-time token for this login, exchanged for a session right here
  const { data: link, error: e1 } = await admin.auth.admin.generateLink({ type: 'magiclink', email: res.email });
  const token_hash = link?.properties?.hashed_token;
  if (e1 || !token_hash) return json({ error: 'Could not start a session. Tell an admin.' }, 500);
  const anon = createClient(URL_, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
  let { data: v, error: e2 } = await anon.auth.verifyOtp({ token_hash, type: 'magiclink' });
  if (e2 || !v?.session) ({ data: v, error: e2 } = await anon.auth.verifyOtp({ token_hash, type: 'email' }));
  if (e2 || !v?.session) return json({ error: 'Could not start a session. Tell an admin.' }, 500);
  return json({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
});
