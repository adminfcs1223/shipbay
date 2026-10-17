// portal-access — ShipBay staff only. Creates (or resets) a client's dashboard login and emails them their details.
//   { action: 'create', org_id, email?, full_name? }  → creates the auth user from the org's contact email with a generated
//                                                      password (resets the password if the login already exists). Returns
//                                                      { email, password } ONCE — the password is never stored in plain text.
//   { action: 'send_welcome', org_id, email, password } → "Good news — your shipbay portal is ready" email via Resend.
// Secrets: SUPABASE_SERVICE_ROLE_KEY (auto), RESEND_API_KEY, optional FOUNDER_FROM.
import { createClient } from 'npm:@supabase/supabase-js@2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info' };
const LOGIN_URL = 'https://auth.shipbay3pl.com';
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: cors });

function genPassword(len = 14): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const buf = new Uint32Array(len); crypto.getRandomValues(buf);
  return Array.from(buf, (n) => alphabet[n % alphabet.length]).join('');
}

const SIG = `
  <p style="margin:26px 0 0;color:#101C2B"><b>Derek Harrison</b><br>
  <span style="color:#5A6473">Founder, shipbay</span><br>
  <span style="color:#5A6473;font-size:13px">115 Stryker Ln, Hillsborough Township, NJ · (610) 478-5432 · <a href="https://www.shipbay3pl.com" style="color:#D14E00">shipbay3pl.com</a></span></p>`;
const BTN = (href: string, label: string) =>
  `<p style="margin:22px 0"><a href="${href}" style="background:#FF6B15;color:#fff;text-decoration:none;padding:13px 24px;border-radius:9px;font-weight:bold;display:inline-block">${label}</a></p>`;
const wrap = (inner: string) => `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#101C2B;line-height:1.6">
    <div style="height:5px;background:#FF6B15;border-radius:3px;margin-bottom:22px"></div>${inner}${SIG}</div>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function welcome(first: string, brand: string, email: string, password: string) {
  const cred = (k: string, v: string) =>
    `<tr><td style="padding:9px 12px;color:#5A6473;font-size:13px;white-space:nowrap">${k}</td><td style="padding:9px 12px;font-family:Menlo,Consolas,monospace;font-size:14px"><b>${esc(v)}</b></td></tr>`;
  return {
    subject: `Good news — your shipbay portal is ready`,
    html: wrap(`
      <p style="font-size:12px;letter-spacing:.14em;color:#D14E00;margin:0 0 6px"><b>SHIPBAY.DASHBOARD</b></p>
      <h1 style="font-size:24px;margin:0 0 14px;color:#101C2B">Good news, ${esc(first)} — your portal is ready<span style="color:#FF6B15">.</span></h1>
      <p>${esc(brand)} now has a live login to shipbay.dashboard — your window into inventory, orders, shipments and itemized billing at our Hillsborough warehouse, synced straight from your store.</p>
      <table style="border-collapse:collapse;background:#F6F7F9;border:1px solid #E8E6E1;border-radius:10px;margin:18px 0;width:100%">
        ${cred('Sign in at', LOGIN_URL.replace('https://', ''))}
        ${cred('Email', email)}
        ${cred('Temporary password', password)}
      </table>
      ${BTN(LOGIN_URL, 'Sign in to shipbay.dashboard →')}
      <p style="font-size:13.5px;color:#5A6473">This password is temporary — use <b>Forgot password?</b> on the sign-in page any time to pick your own. Keep this email private; we'll never ask you for your password.</p>
      <p>As more of your onboarding wraps up, more lights up in the portal. If anything looks off, reply here and you'll get me directly.</p>`),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const auth = req.headers.get('Authorization') ?? '';
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: isStaff } = await userClient.rpc('is_shipbay');
  if (!isStaff) return json({ error: 'not authorized' }, 403);
  const { data: { user: staff } } = await userClient.auth.getUser();

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad request' }, 400); }
  const { data: org } = await admin.from('orgs').select('id, name, contact_name, contact_email, portal_user_id').eq('id', body.org_id).single();
  if (!org) return json({ error: 'account not found' }, 404);

  if (body.action === 'create') {
    const email = String(body.email ?? org.contact_email ?? '').trim().toLowerCase();
    const full_name = String(body.full_name ?? org.contact_name ?? '').trim() || null;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'A valid contact email is required.' }, 400);
    const password = genPassword();

    // existing login for this email? (profiles mirrors auth.users)
    const { data: existing } = await admin.from('profiles').select('id, org_id, role').eq('email', email).maybeSingle();
    let userId: string;
    if (existing) {
      if (existing.org_id && existing.org_id !== org.id) return json({ error: `${email} already has a login on another account.` }, 409);
      const { error } = await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true, user_metadata: { full_name, role: 'client_admin', org_id: org.id } });
      if (error) return json({ error: error.message }, 400);
      userId = existing.id;
      await admin.from('profiles').update({ org_id: org.id, role: 'client_admin', full_name: full_name ?? undefined, active: true }).eq('id', userId);
    } else {
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name, role: 'client_admin', org_id: org.id } });
      if (error) return json({ error: error.message }, 400);
      userId = data.user.id;
      // handle_new_user normally creates the profile; make sure it exists either way
      await admin.from('profiles').upsert({ id: userId, email, full_name, role: 'client_admin', org_id: org.id, active: true }, { onConflict: 'id' });
    }
    const patch: Record<string, unknown> = { portal_user_id: userId, portal_created_at: new Date().toISOString() };
    if (!org.contact_email) patch.contact_email = email;
    if (!org.contact_name && full_name) patch.contact_name = full_name;
    await admin.from('orgs').update(patch).eq('id', org.id);
    await admin.from('onboarding_tasks').update({ done: true, done_at: new Date().toISOString(), done_by: staff?.id ?? null }).eq('org_id', org.id).eq('key', 'portal_login');
    return json({ ok: true, email, password, reset: !!existing });
  }

  if (body.action === 'send_welcome') {
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (!email || !password) return json({ error: 'email and password are required' }, 400);
    const { data: sec } = await admin.from('platform_secrets').select('value').eq('key', 'RESEND_API_KEY').maybeSingle();
    const apiKey = sec?.value || Deno.env.get('RESEND_API_KEY');
    if (!apiKey) return json({ error: 'No Resend API key yet — paste it under Marketplaces → Email sending, then try again.' }, 500);
    const first = (org.contact_name ?? '').trim().split(/\s+/)[0] || 'there';
    const msg = welcome(first, org.name, email, password);
    const from = Deno.env.get('FOUNDER_FROM') ?? 'Derek Harrison — shipbay <derekh@shipbay3pl.com>';
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [email], reply_to: 'derekh@shipbay3pl.com', subject: msg.subject, html: msg.html }),
    });
    if (!res.ok) return json({ error: `Resend ${res.status}: ${await res.text()}` }, 502);
    await admin.from('orgs').update({ portal_invited_at: new Date().toISOString() }).eq('id', org.id);
    return json({ ok: true });
  }

  return json({ error: 'unknown action' }, 400);
});
