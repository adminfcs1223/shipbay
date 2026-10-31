// owner — the owner-only area of shipbay.dashboard (Derek). Everything here requires a signed-in user whose profile
// has is_owner = true; data actions also require the second passphrase to have been entered this session.
//   POST { action:'status' }                                  → { passphrase_set, unlocked, qbo, smartlead_key_set, qbo_keys_set }
//   POST { action:'set_passphrase', passphrase, current? }    → first time: sets it; later: needs the current one
//   POST { action:'unlock', passphrase }                      → { ok, token } token is sent as `x-owner-token` on data actions
//   POST { action:'save_secret', key, value }                 → QBO_CLIENT_ID | QBO_CLIENT_SECRET | SMARTLEAD_API_KEY | SMARTLEAD_CAMPAIGNS
//   POST { action:'smartlead_sync' }                          → pulls every campaign in SMARTLEAD_CAMPAIGNS into sales_email_sends + sales_leads
//   POST { action:'qbo_connect' }                             → { url } Intuit consent screen
//   GET  /owner/qbo-callback?code&realmId&state               → stores tokens, redirects to the dashboard
//   POST { action:'qbo_sync' }                                → P&L by month (this year), balance sheet, last 90 days of transactions → fin_qbo_reports
//   POST { action:'qbo_disconnect' }
// Deploy with verify_jwt=false (the callback has no JWT); every POST verifies the user itself.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const admin = createClient(SB_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info, x-owner-token' };
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: cors });
const DASH = 'https://dashboard.shipbay3pl.com/';
const QBO_REDIRECT = 'https://dashboard.shipbay3pl.com/oauth/qbo';
const QBO_API = 'https://quickbooks.api.intuit.com';
const SECRET_KEYS = new Set(['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'SMARTLEAD_API_KEY', 'SMARTLEAD_CAMPAIGNS']);
const enc = new TextEncoder();

// ---------- secrets ----------
async function secret(key: string): Promise<string> {
  const { data } = await admin.from('platform_secrets').select('value').eq('key', key).maybeSingle();
  return data?.value || Deno.env.get(key) || '';
}
async function setSecret(key: string, value: string, by: string) {
  await admin.from('platform_secrets').upsert({ key, value, updated_by: by, updated_at: new Date().toISOString() }, { onConflict: 'key' });
}

// ---------- passphrase: PBKDF2-SHA256, 120k rounds, random salt ----------
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function pbkdf2(pass: string, salt: Uint8Array, iters: number) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: iters }, key, 256);
  return new Uint8Array(bits);
}
async function hashPass(pass: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16)); const iters = 120000;
  return `pbkdf2$${iters}$${b64(salt)}$${b64(await pbkdf2(pass, salt, iters))}`;
}
async function verifyPass(pass: string, stored: string) {
  const [, it, s, h] = stored.split('$'); if (!it || !s || !h) return false;
  const got = await pbkdf2(pass, unb64(s), Number(it)); const want = unb64(h);
  if (got.length !== want.length) return false;
  let diff = 0; for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}
// unlock token: HMAC(uid|day) with the service key — proves this browser entered the passphrase today
async function hmac(msg: string) {
  const k = await crypto.subtle.importKey('raw', enc.encode(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg))));
}
const day = () => new Date().toISOString().slice(0, 10);
async function tokenFor(uid: string) { return `${day()}.${await hmac(`${uid}|${day()}`)}`; }
async function tokenOk(uid: string, t: string | null) {
  if (!t) return false; const [d, sig] = t.split('.'); if (d !== day()) return false;
  return sig === (await hmac(`${uid}|${d}`));
}

// ---------- settings helpers ----------
async function getSetting(key: string) { const { data } = await admin.from('fin_settings').select('value').eq('key', key).maybeSingle(); return data?.value ?? null; }
async function setSetting(key: string, value: unknown) { await admin.from('fin_settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' }); }

// ---------- QuickBooks ----------
async function qboTokens() {
  const { data } = await admin.from('fin_qbo_tokens').select('*').limit(1).maybeSingle();
  if (!data) return null;
  if (new Date(data.access_expires_at).getTime() - Date.now() > 120000) return data;
  // refresh
  const [id, sec] = [await secret('QBO_CLIENT_ID'), await secret('QBO_CLIENT_SECRET')];
  const r = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', { method: 'POST', headers: { Authorization: `Basic ${btoa(`${id}:${sec}`)}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: data.refresh_token }) });
  const j = await r.json();
  if (!r.ok || !j.access_token) { await admin.from('fin_qbo_status').update({ last_error: `Token refresh failed: ${JSON.stringify(j).slice(0, 200)}` }).eq('id', 1); return null; }
  const upd = { access_token: j.access_token, refresh_token: j.refresh_token, access_expires_at: new Date(Date.now() + j.expires_in * 1000).toISOString(), refresh_expires_at: new Date(Date.now() + j.x_refresh_token_expires_in * 1000).toISOString(), updated_at: new Date().toISOString() };
  await admin.from('fin_qbo_tokens').update(upd).eq('realm_id', data.realm_id);
  return { ...data, ...upd };
}
async function qboGet(tok: any, path: string) {
  const r = await fetch(`${QBO_API}/v3/company/${tok.realm_id}${path}${path.includes('?') ? '&' : '?'}minorversion=75`, { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' } });
  const text = await r.text(); let data: any = null; try { data = JSON.parse(text); } catch { /* keep text */ }
  if (!r.ok) throw new Error(`QuickBooks ${r.status} on ${path}: ${text.slice(0, 200)}`);
  return data;
}
function ymd(d: Date) { return d.toISOString().slice(0, 10); }

// ---------- Smartlead ----------
async function smartleadSync(uid: string) {
  const key = await secret('SMARTLEAD_API_KEY'); if (!key) return { error: 'Add the Smartlead API key under Owner → Settings first.' };
  const campaigns = (await secret('SMARTLEAD_CAMPAIGNS') || '4039101').split(',').map((s) => s.trim()).filter(Boolean);
  const base = 'https://server.smartlead.ai/api/v1';
  const out: Record<string, unknown> = {};
  for (const cid of campaigns) {
    const camp = await (await fetch(`${base}/campaigns/${cid}?api_key=${key}`)).json().catch(() => ({}));
    const label = `${cid} ${camp?.name || ''}`.trim();
    // leads → sales_leads
    const leads: any[] = [];
    for (let off = 0; off < 20000; off += 100) {
      const j = await (await fetch(`${base}/campaigns/${cid}/leads?api_key=${key}&offset=${off}&limit=100`)).json().catch(() => ({}));
      const d = j?.data || []; leads.push(...d); if (d.length < 100) break;
    }
    const byEmail = new Map<string, string>();
    for (const x of leads) {
      const l = x.lead || {}; const email = String(l.email || '').toLowerCase(); if (!email) continue;
      const domain = String(l.website || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase() || null;
      const cf = l.custom_fields || {};
      const row: any = { source: 'cold_email', filter_id: cf.list_source || null, company: l.company_name || null, domain, contact_name: [l.first_name, l.last_name].filter(Boolean).join(' ') || null, email, phone: l.phone_number || null, title: cf.title || null, orders_est: cf.orders_est || null, in_email: true };
      // find existing by domain then email
      let ex: any = null;
      if (domain) ({ data: ex } = await admin.from('sales_leads').select('id, in_calls, stage').ilike('domain', domain).maybeSingle());
      if (!ex) ({ data: ex } = await admin.from('sales_leads').select('id, in_calls, stage').ilike('email', email).maybeSingle());
      if (ex) { await admin.from('sales_leads').update({ in_email: true, email, contact_name: row.contact_name, title: row.title, filter_id: row.filter_id ?? undefined }).eq('id', ex.id); byEmail.set(email, ex.id); }
      else { const { data: ins } = await admin.from('sales_leads').insert(row).select('id').single(); if (ins) byEmail.set(email, ins.id); }
    }
    // statistics → sales_email_sends
    const stats: any[] = [];
    for (let off = 0; off < 50000; off += 100) {
      const j = await (await fetch(`${base}/campaigns/${cid}/statistics?api_key=${key}&offset=${off}&limit=100`)).json().catch(() => ({}));
      const d = j?.data || []; stats.push(...d); if (d.length < 100) break;
    }
    const { data: existing } = await admin.from('sales_email_sends').select('external_id, reply_type').eq('campaign', label);
    const keep = new Map((existing || []).map((e: any) => [e.external_id, e.reply_type]));
    const tags: Record<string, string> = (await getSetting('reply_tags')) || {};   // email → reply type, set from the Email tab; survives re-syncs and label changes
    const rows = stats.map((s) => {
      const sent = new Date(s.sent_time); const rt = s.reply_time ? new Date(s.reply_time) : null;
      const bounced = s.is_bounced === true || s.is_bounced === 'true';
      const bounceBack = !!rt && (bounced || rt.getTime() - sent.getTime() < 60000);
      const prev = keep.get(s.stats_id);
      return { external_id: s.stats_id, lead_id: byEmail.get(String(s.lead_email).toLowerCase()) || null, lead_email: s.lead_email, lead_name: s.lead_name, campaign: label, step: s.sequence_number, variant: String(s.seq_variant_id), subject: s.email_subject, sent_at: sent.toISOString(), opened: !!s.open_time, open_count: Number(s.open_count || 0), replied: !!rt && !bounceBack, bounced, reply_type: prev ?? (rt && tags[String(s.lead_email).toLowerCase()]) ?? (bounceBack ? 'Bounce-back' : null) };
    });
    for (let i = 0; i < rows.length; i += 200) await admin.from('sales_email_sends').upsert(rows.slice(i, i + 200), { onConflict: 'external_id' });
    // stages: contacted if sent, replied if a real reply and not already further along
    const touched = [...new Set(rows.map((r) => r.lead_id).filter(Boolean))] as string[];
    for (let i = 0; i < touched.length; i += 200) await admin.from('sales_leads').update({ stage: 'contacted', last_touch_at: new Date().toISOString() }).in('id', touched.slice(i, i + 200)).eq('stage', 'new');
    const replied = [...new Set(rows.filter((r) => r.replied).map((r) => r.lead_id).filter(Boolean))] as string[];
    if (replied.length) await admin.from('sales_leads').update({ stage: 'replied' }).in('id', replied).in('stage', ['new', 'contacted']);
    const neg = [...new Set(rows.filter((r) => r.reply_type === 'Negative').map((r) => r.lead_id).filter(Boolean))] as string[];
    if (neg.length) await admin.from('sales_leads').update({ stage: 'dnc' }).in('id', neg);
    out[label] = { leads: leads.length, sends: rows.length, analytics: await (await fetch(`${base}/campaigns/${cid}/analytics?api_key=${key}`)).json().catch(() => null) };
  }
  await setSetting('smartlead_last_sync', { at: new Date().toISOString(), by: uid, out });
  return { ok: true, campaigns: out };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const u = new URL(req.url);

  // ----- QuickBooks OAuth return leg (no JWT) -----
  if (req.method === 'GET' && u.pathname.endsWith('/qbo-callback')) {
    const q = u.searchParams; const back = (ok: boolean, msg: string) => Response.redirect(`${DASH}#owner=qbo|${ok ? 'ok' : 'error'}|${encodeURIComponent(msg)}`, 302);
    const st = await getSetting('qbo_state');
    if (!st || st.state !== q.get('state') || Date.now() - new Date(st.at).getTime() > 15 * 60 * 1000) return back(false, 'That connect link expired — start again from Financials.');
    if (q.get('error')) return back(false, q.get('error') || 'QuickBooks declined');
    const [id, sec] = [await secret('QBO_CLIENT_ID'), await secret('QBO_CLIENT_SECRET')];
    const r = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', { method: 'POST', headers: { Authorization: `Basic ${btoa(`${id}:${sec}`)}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: q.get('code') || '', redirect_uri: QBO_REDIRECT }) });
    const j = await r.json();
    if (!r.ok || !j.access_token) return back(false, `Token exchange failed: ${JSON.stringify(j).slice(0, 160)}`);
    const realm = q.get('realmId') || '';
    await admin.from('fin_qbo_tokens').upsert({ realm_id: realm, access_token: j.access_token, refresh_token: j.refresh_token, access_expires_at: new Date(Date.now() + j.expires_in * 1000).toISOString(), refresh_expires_at: new Date(Date.now() + j.x_refresh_token_expires_in * 1000).toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'realm_id' });
    let company = '';
    try { const info = await qboGet({ realm_id: realm, access_token: j.access_token }, `/companyinfo/${realm}`); company = info?.CompanyInfo?.CompanyName || ''; } catch { /* fine */ }
    await admin.from('fin_qbo_status').update({ realm_id: realm, company_name: company, connected_at: new Date().toISOString(), last_error: null }).eq('id', 1);
    await setSetting('qbo_state', null);
    return back(true, company ? `Connected to ${company}` : 'Connected');
  }

  // ----- everything else: signed-in owner -----
  const auth = req.headers.get('Authorization') ?? '';
  const userClient = createClient(SB_URL, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: { user: me } } = await userClient.auth.getUser();
  if (!me) return json({ error: 'not signed in' }, 401);
  const { data: prof } = await admin.from('profiles').select('is_owner, role').eq('id', me.id).single();
  if (!prof?.is_owner) return json({ error: 'This area is for the owner only.' }, 403);
  const b = await req.json().catch(() => ({}));
  const stored = await secret('OWNER_PASSPHRASE');
  const unlocked = await tokenOk(me.id, req.headers.get('x-owner-token'));

  if (b.action === 'status') {
    const { data: qbo } = await admin.from('fin_qbo_status').select('*').eq('id', 1).maybeSingle();
    return json({ passphrase_set: !!stored, unlocked, qbo, smartlead_key_set: !!(await secret('SMARTLEAD_API_KEY')), smartlead_campaigns: await secret('SMARTLEAD_CAMPAIGNS'), qbo_keys_set: !!(await secret('QBO_CLIENT_ID')) && !!(await secret('QBO_CLIENT_SECRET')), smartlead_last_sync: await getSetting('smartlead_last_sync') });
  }

  if (b.action === 'set_passphrase') {
    const pass = String(b.passphrase || ''); if (pass.length < 8) return json({ error: 'Use at least 8 characters.' }, 400);
    if (stored && !(await verifyPass(String(b.current || ''), stored))) return json({ error: 'Current passphrase is wrong.' }, 403);
    await setSecret('OWNER_PASSPHRASE', await hashPass(pass), me.id);
    await setSetting('unlock_fail', null);
    return json({ ok: true, token: await tokenFor(me.id) });
  }

  if (b.action === 'unlock') {
    if (!stored) return json({ error: 'No passphrase set yet.' }, 400);
    const f = (await getSetting('unlock_fail')) || { n: 0, until: null };
    if (f.until && new Date(f.until).getTime() > Date.now()) return json({ error: `Too many tries — locked until ${new Date(f.until).toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET.` }, 429);
    if (!(await verifyPass(String(b.passphrase || ''), stored))) {
      const n = (f.n || 0) + 1; await setSetting('unlock_fail', { n, until: n >= 5 ? new Date(Date.now() + 10 * 60 * 1000).toISOString() : null });
      return json({ error: n >= 5 ? 'Five wrong tries — locked for 10 minutes.' : 'Wrong passphrase.' }, 403);
    }
    await setSetting('unlock_fail', null);
    return json({ ok: true, token: await tokenFor(me.id) });
  }

  if (!unlocked) return json({ error: 'Enter the owner passphrase first.' }, 403);

  if (b.action === 'save_secret') {
    if (!SECRET_KEYS.has(b.key)) return json({ error: 'Unknown setting.' }, 400);
    await setSecret(b.key, String(b.value || '').trim(), me.id); return json({ ok: true });
  }
  if (b.action === 'smartlead_sync') { try { return json(await smartleadSync(me.id)); } catch (e) { return json({ error: String(e) }, 500); } }

  if (b.action === 'qbo_connect') {
    const id = await secret('QBO_CLIENT_ID'); if (!id) return json({ error: 'Paste the QuickBooks app Client ID and Client Secret first (Owner → Settings).' }, 400);
    const state = crypto.randomUUID(); await setSetting('qbo_state', { state, at: new Date().toISOString() });
    const url = `https://appcenter.intuit.com/connect/oauth2?${new URLSearchParams({ client_id: id, response_type: 'code', scope: 'com.intuit.quickbooks.accounting', redirect_uri: QBO_REDIRECT, state })}`;
    return json({ url });
  }
  if (b.action === 'qbo_disconnect') {
    const { data: t } = await admin.from('fin_qbo_tokens').select('realm_id').limit(1).maybeSingle();
    if (t) await admin.from('fin_qbo_tokens').delete().eq('realm_id', t.realm_id);
    await admin.from('fin_qbo_status').update({ realm_id: null, company_name: null, connected_at: null, last_sync_at: null, last_error: null }).eq('id', 1);
    return json({ ok: true });
  }
  if (b.action === 'qbo_sync') {
    const tok = await qboTokens(); if (!tok) return json({ error: 'QuickBooks is not connected (or the token expired). Connect it from Financials.' }, 400);
    try {
      const now = new Date(); const y = now.getFullYear();
      const pl = await qboGet(tok, `/reports/ProfitAndLoss?start_date=${y}-01-01&end_date=${ymd(now)}&summarize_column_by=Month&accounting_method=Accrual`);
      const bs = await qboGet(tok, `/reports/BalanceSheet?start_date=${ymd(now)}&end_date=${ymd(now)}&accounting_method=Accrual`);
      const since = new Date(now.getTime() - 90 * 86400000);
      const tl = await qboGet(tok, `/reports/TransactionList?start_date=${ymd(since)}&end_date=${ymd(now)}&columns=tx_date,txn_type,doc_num,name,memo,account_name,subt_nat_amount`);
      const ar = await qboGet(tok, `/reports/AgedReceivables?report_date=${ymd(now)}`).catch(() => null);
      const rows = [
        { report: 'ProfitAndLoss', period_start: `${y}-01-01`, period_end: ymd(now), data: pl },
        { report: 'BalanceSheet', period_start: ymd(now), period_end: ymd(now), data: bs },
        { report: 'TransactionList', period_start: ymd(since), period_end: ymd(now), data: tl },
      ];
      if (ar) rows.push({ report: 'AgedReceivables', period_start: ymd(now), period_end: ymd(now), data: ar });
      await admin.from('fin_qbo_reports').insert(rows);
      await admin.from('fin_qbo_status').update({ last_sync_at: new Date().toISOString(), last_error: null }).eq('id', 1);
      return json({ ok: true, reports: rows.map((r) => r.report) });
    } catch (e) { await admin.from('fin_qbo_status').update({ last_error: String(e).slice(0, 300) }).eq('id', 1); return json({ error: String(e) }, 500); }
  }
  return json({ error: 'unknown action' }, 400);
});
