// admin-users — ShipBay ADMINS only (role shipbay_admin). Manage every portal login: staff and client users.
//   { action: 'create', email, full_name?, role, org_id?, phone?, send_email? } → auth user + profile; returns { email, password } ONCE
//   { action: 'reset', user_id }                      → new generated password, returned once
//   { action: 'update', user_id, full_name?, role?, org_id?, phone? }
//   { action: 'set_active', user_id, active }         → bans / unbans the login
// Deploy: supabase functions deploy admin-users
import { createClient } from 'npm:@supabase/supabase-js@2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info' };
const LOGIN_URL = 'https://auth.shipbay3pl.com';
const ROLES = ['shipbay_admin', 'shipbay_staff', 'client_admin', 'client_user'];
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: cors });
const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function genPassword(len = 14): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const buf = new Uint32Array(len); crypto.getRandomValues(buf);
  return Array.from(buf, (n) => alphabet[n % alphabet.length]).join('');
}

async function sendWelcome(email: string, password: string, first: string, staff: boolean, brand?: string | null) {
  const { data: sec } = await admin.from('platform_secrets').select('value').eq('key', 'RESEND_API_KEY').maybeSingle();
  const apiKey = sec?.value || Deno.env.get('RESEND_API_KEY');
  if (!apiKey) return { error: 'No Resend API key — add it under Integrations → Email sending.' };
  const cred = (k: string, v: string) => `<tr><td style="padding:9px 12px;color:#5A6473;font-size:13px;white-space:nowrap">${k}</td><td style="padding:9px 12px;font-family:Menlo,Consolas,monospace;font-size:14px"><b>${esc(v)}</b></td></tr>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#101C2B;line-height:1.6">
    <div style="height:5px;background:#FF6B15;border-radius:3px;margin-bottom:22px"></div>
    <p style="font-size:12px;letter-spacing:.14em;color:#D14E00;margin:0 0 6px"><b>SHIPBAY.DASHBOARD</b></p>
    <h1 style="font-size:24px;margin:0 0 14px">${esc(first)}, your shipbay login is ready<span style="color:#FF6B15">.</span></h1>
    <p>${staff ? 'You now have a staff login to shipbay.dashboard — orders, receiving, the packing station and client accounts.' : `${esc(brand || 'Your brand')} now has a login to shipbay.dashboard — inventory, orders, shipments and documents at our Hillsborough warehouse.`}</p>
    <table style="border-collapse:collapse;background:#F6F7F9;border:1px solid #E8E6E1;border-radius:10px;margin:18px 0;width:100%">${cred('Sign in at', LOGIN_URL.replace('https://', ''))}${cred('Email', email)}${cred('Temporary password', password)}</table>
    <p style="margin:22px 0"><a href="${LOGIN_URL}" style="background:#FF6B15;color:#fff;text-decoration:none;padding:13px 24px;border-radius:9px;font-weight:bold;display:inline-block">Sign in to shipbay.dashboard →</a></p>
    <p style="font-size:13.5px;color:#5A6473">This password is temporary — use <b>Forgot password?</b> on the sign-in page any time to pick your own. Keep this email private; we'll never ask you for your password.</p>
    <p style="margin:26px 0 0"><b>Derek Harrison</b><br><span style="color:#5A6473">Founder, shipbay · 115 Stryker Ln, Hillsborough Township, NJ</span></p></div>`;
  const from = Deno.env.get('FOUNDER_FROM') ?? 'Derek Harrison — shipbay <derekh@shipbay3pl.com>';
  const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [email], reply_to: 'derekh@shipbay3pl.com', subject: 'Your shipbay.dashboard login', html }) });
  if (!res.ok) return { error: `Resend ${res.status}: ${await res.text()}` };
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const auth = req.headers.get('Authorization') ?? '';
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: { user: me } } = await userClient.auth.getUser();
  if (!me) return json({ error: 'not signed in' }, 401);
  const { data: myProfile } = await admin.from('profiles').select('role').eq('id', me.id).single();
  if (myProfile?.role !== 'shipbay_admin') return json({ error: 'Only shipbay admins can manage users.' }, 403);
  const b = await req.json().catch(() => ({}));

  if (b.action === 'create') {
    const email = String(b.email ?? '').trim().toLowerCase();
    const full_name = String(b.full_name ?? '').trim() || null;
    const role = ROLES.includes(b.role) ? b.role : 'shipbay_staff';
    const org_id = role.startsWith('client') ? (b.org_id || null) : null;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'A valid email is required.' }, 400);
    if (role.startsWith('client') && !org_id) return json({ error: 'Pick the brand this client user belongs to.' }, 400);
    const { data: existing } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
    if (existing) return json({ error: `${email} already has a login — reset their password instead.` }, 409);
    const password = genPassword();
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name, role, org_id } });
    if (error) return json({ error: error.message }, 400);
    await admin.from('profiles').upsert({ id: data.user.id, email, full_name, role, org_id, phone: b.phone || null, active: true }, { onConflict: 'id' });
    let brand: string | null = null;
    if (org_id) { const { data: o } = await admin.from('orgs').select('name').eq('id', org_id).single(); brand = o?.name ?? null; }
    let mail: any = { skipped: true };
    if (b.send_email) mail = await sendWelcome(email, password, (full_name || '').split(/\s+/)[0] || 'there', role.startsWith('shipbay'), brand);
    return json({ ok: true, user_id: data.user.id, email, password, mail });
  }

  if (b.action === 'reset') {
    const { data: p } = await admin.from('profiles').select('id, email, full_name, role, org_id').eq('id', b.user_id).single();
    if (!p) return json({ error: 'user not found' }, 404);
    const password = genPassword();
    const { error } = await admin.auth.admin.updateUserById(p.id, { password });
    if (error) return json({ error: error.message }, 400);
    let mail: any = { skipped: true };
    if (b.send_email) { let brand: string | null = null; if (p.org_id) { const { data: o } = await admin.from('orgs').select('name').eq('id', p.org_id).single(); brand = o?.name ?? null; } mail = await sendWelcome(p.email, password, (p.full_name || '').split(/\s+/)[0] || 'there', String(p.role).startsWith('shipbay'), brand); }
    return json({ ok: true, email: p.email, password, mail });
  }

  if (b.action === 'update') {
    if (b.user_id === me.id && b.role && b.role !== 'shipbay_admin') return json({ error: 'You can’t remove your own admin role.' }, 400);
    const patch: any = {};
    if (b.full_name !== undefined) patch.full_name = String(b.full_name).trim() || null;
    if (b.phone !== undefined) patch.phone = b.phone || null;
    if (b.role && ROLES.includes(b.role)) { patch.role = b.role; patch.org_id = b.role.startsWith('client') ? (b.org_id || null) : null; }
    else if (b.org_id !== undefined) patch.org_id = b.org_id || null;
    const { error } = await admin.from('profiles').update(patch).eq('id', b.user_id);
    if (error) return json({ error: error.message }, 400);
    await admin.auth.admin.updateUserById(b.user_id, { user_metadata: { ...(patch.role ? { role: patch.role, org_id: patch.org_id } : {}), ...(patch.full_name !== undefined ? { full_name: patch.full_name } : {}) } });
    return json({ ok: true });
  }

  if (b.action === 'set_active') {
    if (b.user_id === me.id) return json({ error: 'You can’t deactivate yourself.' }, 400);
    const active = !!b.active;
    const { error } = await admin.auth.admin.updateUserById(b.user_id, { ban_duration: active ? 'none' : '876000h' });
    if (error) return json({ error: error.message }, 400);
    await admin.from('profiles').update({ active }).eq('id', b.user_id);
    return json({ ok: true, active });
  }

  return json({ error: 'unknown action' }, 400);
});
