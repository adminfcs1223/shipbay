// password-reset — shipbay-branded "Forgot password?" flow, independent of Supabase's mailer, Site URL and templates.
//   POST { action: 'request', email } → if a portal login exists, generates a recovery token (no Supabase email) and sends
//   our own email via Resend with a link to https://auth.shipbay3pl.com/?reset=<token>. The sign-in page verifies that token
//   (verifyOtp) and shows "Choose a new password". Always answers ok so the form never reveals which emails have logins.
// Public endpoint (no JWT) — guarded by: existence check, 60s per-address throttle, 1-hour token expiry.
import { createClient } from 'npm:@supabase/supabase-js@2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info' };
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: cors });
const AUTH_URL = 'https://auth.shipbay3pl.com';
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const SIG = `
  <p style="margin:26px 0 0;color:#101C2B"><b>shipbay</b><br>
  <span style="color:#5A6473;font-size:13px">115 Stryker Ln, Unit 10, Hillsborough Township, NJ · (610) 478-5432 · <a href="https://www.shipbay3pl.com" style="color:#D14E00">shipbay3pl.com</a></span></p>`;
const wrap = (inner: string) => `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#101C2B;line-height:1.6">
    <div style="height:5px;background:#FF6B15;border-radius:3px;margin-bottom:22px"></div>${inner}${SIG}</div>`;

function resetEmail(first: string, link: string) {
  return {
    subject: 'Reset your shipbay.dashboard password',
    html: wrap(`
      <p style="font-size:12px;letter-spacing:.14em;color:#D14E00;margin:0 0 6px"><b>SHIPBAY.DASHBOARD</b></p>
      <h1 style="font-size:24px;margin:0 0 14px;color:#101C2B">Reset your password<span style="color:#FF6B15">.</span></h1>
      <p>Hi ${esc(first)}, someone asked to reset the password for your shipbay.dashboard login. If that was you, the button below takes you straight to a page where you choose a new one.</p>
      <p style="margin:22px 0"><a href="${link}" style="background:#FF6B15;color:#fff;text-decoration:none;padding:13px 24px;border-radius:9px;font-weight:bold;display:inline-block">Choose a new password →</a></p>
      <p style="font-size:13.5px;color:#5A6473">This link works once and expires in 1 hour. If you didn't ask for a reset, you can ignore this email — your password hasn't changed.</p>
      <p style="font-size:12.5px;color:#8A93A3;word-break:break-all">If the button doesn't work, paste this into your browser:<br>${link}</p>`),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'bad request' }, 400); }
  if (body.action !== 'request') return json({ error: 'unknown action' }, 400);

  const email = String(body.email ?? '').trim().toLowerCase();
  const ok = { ok: true, message: 'If that email has a shipbay login, a reset link is on its way.' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(ok);

  // only active portal users; banned/unknown addresses get the same neutral answer
  const { data: prof } = await admin.from('profiles').select('id, full_name, active').eq('email', email).maybeSingle();
  if (!prof || prof.active === false) return json(ok);
  const { data: au } = await admin.auth.admin.getUserById(prof.id);
  const u = au?.user as any;
  if (!u || (u.banned_until && new Date(u.banned_until) > new Date())) return json(ok);
  if (u.recovery_sent_at && Date.now() - new Date(u.recovery_sent_at).getTime() < 60_000) return json(ok); // throttle

  const { data: link, error } = await admin.auth.admin.generateLink({ type: 'recovery', email });
  if (error || !link?.properties?.hashed_token) { console.error('generateLink failed', error); return json(ok); }
  const url = `${AUTH_URL}/?reset=${encodeURIComponent(link.properties.hashed_token)}`;

  const { data: sec } = await admin.from('platform_secrets').select('value').eq('key', 'RESEND_API_KEY').maybeSingle();
  const apiKey = sec?.value || Deno.env.get('RESEND_API_KEY');
  if (!apiKey) { console.error('No RESEND_API_KEY — reset email not sent to', email); return json(ok); }
  const first = String(prof.full_name ?? '').trim().split(/\s+/)[0] || 'there';
  const msg = resetEmail(first, url);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'shipbay <derekh@shipbay3pl.com>', to: [email], reply_to: 'derekh@shipbay3pl.com', subject: msg.subject, html: msg.html }),
  });
  if (!res.ok) console.error('Resend error', res.status, await res.text());
  return json(ok);
});
