// wms-employees — ShipBay ADMINS only (role shipbay_admin). The people who sign in at wms.shipbay3pl.com with an
// employee number + 6-digit PIN. Role wms_employee opens the WMS and nothing else.
//   { action: 'create', full_name, employee_no, pin }     → new WMS-only login
//   { action: 'assign', user_id, employee_no, pin }       → give an existing admin / staff login a number + PIN
//   { action: 'update', user_id, full_name?, employee_no? }
//   { action: 'pin', user_id, pin }                       → new PIN (also clears a lock)
//   { action: 'set_active', user_id, active }             → switch a WMS-only login off / on
// PINs are stored hashed by the database function wms_set_pin; nothing here returns one.
// Deploy: supabase functions deploy wms-employees
import { createClient } from 'npm:@supabase/supabase-js@2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info' };
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: cors });
const empNo = (v: unknown) => { const n = Number(String(v ?? '').trim()); return Number.isInteger(n) && n >= 1 && n <= 999999 ? n : null; };
const pinOk = (v: unknown) => /^[0-9]{6}$/.test(String(v ?? ''));
const BAD_NO = 'The employee number is a whole number from 1 to 999999.';
const BAD_PIN = 'The PIN is 6 digits.';
const randomPassword = () => { const b = new Uint8Array(32); crypto.getRandomValues(b); return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); };
const noTaken = async (n: number, except?: string) => {
  const { data } = await admin.from('profiles').select('id, full_name').eq('employee_no', n).maybeSingle();
  return data && data.id !== except ? data : null;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const auth = req.headers.get('Authorization') ?? '';
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: { user: me } } = await userClient.auth.getUser();
  if (!me) return json({ error: 'not signed in' }, 401);
  const { data: mine } = await admin.from('profiles').select('role, active').eq('id', me.id).single();
  if (mine?.role !== 'shipbay_admin' || mine?.active === false) return json({ error: 'Only shipbay admins can manage employees.' }, 403);
  const b = await req.json().catch(() => ({}));

  if (b.action === 'create') {
    const full_name = String(b.full_name ?? '').trim();
    const n = empNo(b.employee_no);
    if (!full_name) return json({ error: 'Enter the employee’s name.' }, 400);
    if (!n) return json({ error: BAD_NO }, 400);
    if (!pinOk(b.pin)) return json({ error: BAD_PIN }, 400);
    const taken = await noTaken(n); if (taken) return json({ error: `Number ${n} already belongs to ${taken.full_name || 'another login'}.` }, 409);
    // the address is a placeholder: it is never used to sign in and nothing is ever sent to it
    const email = `emp-${crypto.randomUUID().slice(0, 13)}@wms.shipbay3pl.com`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: randomPassword(), email_confirm: true, user_metadata: { full_name, role: 'wms_employee' } });
    if (error || !data?.user) return json({ error: error?.message || 'Could not create the login.' }, 400);
    const { error: e2 } = await admin.from('profiles').upsert({ id: data.user.id, email, full_name, role: 'wms_employee', org_id: null, active: true, employee_no: n }, { onConflict: 'id' });
    const e3 = e2 ? null : (await admin.rpc('wms_set_pin', { p_user: data.user.id, p_pin: String(b.pin) })).error;
    if (e2 || e3) { await admin.auth.admin.deleteUser(data.user.id); return json({ error: (e2 || e3)!.message }, 400); }
    return json({ ok: true, user_id: data.user.id, employee_no: n });
  }

  if (b.action === 'assign') {
    const n = empNo(b.employee_no);
    if (!n) return json({ error: BAD_NO }, 400);
    if (!pinOk(b.pin)) return json({ error: BAD_PIN }, 400);
    const { data: p } = await admin.from('profiles').select('id, role').eq('id', b.user_id).maybeSingle();
    if (!p || !['shipbay_admin', 'shipbay_staff'].includes(p.role)) return json({ error: 'Only an admin or staff login can be given an employee number.' }, 400);
    const taken = await noTaken(n, p.id); if (taken) return json({ error: `Number ${n} already belongs to ${taken.full_name || 'another login'}.` }, 409);
    const { error } = await admin.from('profiles').update({ employee_no: n }).eq('id', p.id);
    if (error) return json({ error: error.message }, 400);
    const { error: e3 } = await admin.rpc('wms_set_pin', { p_user: p.id, p_pin: String(b.pin) });
    if (e3) return json({ error: e3.message }, 400);
    return json({ ok: true, employee_no: n });
  }

  // everything below acts on a login that already has an employee number
  const { data: emp } = await admin.from('profiles').select('id, role, employee_no').eq('id', b.user_id ?? '00000000-0000-0000-0000-000000000000').not('employee_no', 'is', null).maybeSingle();
  if (!emp) return json({ error: 'That login has no employee number.' }, 404);

  if (b.action === 'update') {
    const patch: Record<string, unknown> = {};
    if (b.full_name !== undefined) { const v = String(b.full_name).trim(); if (!v) return json({ error: 'Enter the employee’s name.' }, 400); patch.full_name = v; }
    if (b.employee_no !== undefined) {
      const n = empNo(b.employee_no); if (!n) return json({ error: BAD_NO }, 400);
      const taken = await noTaken(n, emp.id); if (taken) return json({ error: `Number ${n} already belongs to ${taken.full_name || 'another login'}.` }, 409);
      patch.employee_no = n;
    }
    if (!Object.keys(patch).length) return json({ ok: true });
    const { error } = await admin.from('profiles').update(patch).eq('id', emp.id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  if (b.action === 'pin') {
    if (!pinOk(b.pin)) return json({ error: BAD_PIN }, 400);
    const { error } = await admin.rpc('wms_set_pin', { p_user: emp.id, p_pin: String(b.pin) });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  if (b.action === 'set_active') {
    if (emp.role !== 'wms_employee') return json({ error: 'Switch admin and staff logins off under Users.' }, 400);
    const active = !!b.active;
    const { error } = await admin.auth.admin.updateUserById(emp.id, { ban_duration: active ? 'none' : '876000h' });
    if (error) return json({ error: error.message }, 400);
    await admin.from('profiles').update({ active }).eq('id', emp.id);
    return json({ ok: true, active });
  }

  return json({ error: 'unknown action' }, 400);
});
