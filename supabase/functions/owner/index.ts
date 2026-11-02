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
const SECRET_KEYS = new Set(['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'SMARTLEAD_API_KEY', 'SMARTLEAD_CAMPAIGNS', 'CALENDLY_TOKEN', 'GCAL_ICS_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'HUBSPOT_TOKEN', 'CRON_KEY']);
const GOOGLE_REDIRECT = 'https://dashboard.shipbay3pl.com/oauth/google';
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email';
const SL = 'https://server.smartlead.ai/api/v1';
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
// 'SL-A1-selfship-NJmetro-v1' → 'A1'
const listCode = (v: unknown) => { const m = String(v || '').match(/^SL-([A-Z]\d+)-/); return m ? m[1] : (String(v || '') || null); };
// reply HTML → readable text, quoted history cut off
function replyText(html: string) {
  let t = String(html || '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '');
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\r/g, '');
  const lines = t.split('\n').map((l) => l.trimEnd());
  const cut = lines.findIndex((l, i) => /^>/.test(l.trim()) || /^On .{5,160}wrote:?$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()) || (/^From:/.test(l.trim()) && i > 0));
  return (cut > 0 ? lines.slice(0, cut) : lines).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
}
async function smartleadSync(uid: string) {
  const key = await secret('SMARTLEAD_API_KEY'); if (!key) return { error: 'Add the Smartlead API key under Owner → Settings first.' };
  const campaigns = (await secret('SMARTLEAD_CAMPAIGNS') || '4039101').split(',').map((s) => s.trim()).filter(Boolean);
  const base = SL;
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
    const byEmail = new Map<string, string>(); const slId = new Map<string, string>();
    // one read of every lead we already have, instead of two lookups per Smartlead lead
    const byDomain = new Map<string, any>(); const byMail = new Map<string, any>();
    for (let off = 0; ; off += 1000) {
      const { data: page } = await admin.from('sales_leads').select('id, domain, email, in_email, contact_name, title, filter_id').range(off, off + 999);
      for (const r of page || []) { if (r.domain) byDomain.set(String(r.domain).toLowerCase(), r); if (r.email) byMail.set(String(r.email).toLowerCase(), r); }
      if (!page || page.length < 1000) break;
    }
    const inserts: any[] = []; const updates: { id: string; patch: any }[] = [];
    for (const x of leads) {
      const l = x.lead || {}; const email = String(l.email || '').toLowerCase(); if (!email) continue;
      if (l.id) slId.set(email, String(l.id));
      const domain = String(l.website || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase() || null;
      const cf = l.custom_fields || {};
      const row: any = { source: 'cold_email', filter_id: listCode(cf.list_source), company: l.company_name || null, domain, contact_name: [l.first_name, l.last_name].filter(Boolean).join(' ') || null, email, phone: l.phone_number || null, title: cf.title || null, orders_est: cf.orders_est || null, in_email: true };
      const ex = (domain && byDomain.get(domain)) || byMail.get(email);
      if (ex) { byEmail.set(email, ex.id); if (!ex.in_email || ex.email !== email || ex.contact_name !== row.contact_name) updates.push({ id: ex.id, patch: { in_email: true, email, contact_name: row.contact_name, title: row.title, filter_id: row.filter_id ?? undefined } }); }
      else if (!inserts.some((r) => r.email === email || (domain && r.domain === domain))) inserts.push(row);
    }
    for (const u of updates) await admin.from('sales_leads').update(u.patch).eq('id', u.id);
    for (let i = 0; i < inserts.length; i += 200) { const { data: ins } = await admin.from('sales_leads').insert(inserts.slice(i, i + 200)).select('id, email'); for (const r of ins || []) byEmail.set(String(r.email).toLowerCase(), r.id); }
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
      return { external_id: s.stats_id, lead_id: byEmail.get(String(s.lead_email).toLowerCase()) || null, sl_lead_id: slId.get(String(s.lead_email).toLowerCase()) || (s.lead_id ? String(s.lead_id) : null), lead_email: s.lead_email, lead_name: s.lead_name, campaign: label, step: s.sequence_number, variant: String(s.seq_variant_id), subject: s.email_subject, sent_at: sent.toISOString(), opened: !!s.open_time, open_count: Number(s.open_count || 0), replied: !!rt && !bounceBack, bounced, reply_type: prev ?? (rt && tags[String(s.lead_email).toLowerCase()]) ?? (bounceBack ? 'Bounce-back' : null) };
    });
    for (let i = 0; i < rows.length; i += 200) await admin.from('sales_email_sends').upsert(rows.slice(i, i + 200), { onConflict: 'external_id' });
    // reply bodies: one message-history call per lead that replied and has no text stored yet (max 40 per sync)
    const { data: need } = await admin.from('sales_email_sends').select('id, sl_lead_id, lead_email, sent_at').eq('campaign', label).eq('replied', true).is('reply_body', null).not('sl_lead_id', 'is', null).limit(40);
    let bodies = 0;
    for (const n of need || []) {
      try {
        const h = await (await fetch(`${base}/campaigns/${cid}/leads/${n.sl_lead_id}/message-history?api_key=${key}`)).json();
        const sentAt = new Date(n.sent_at).getTime();
        const rep = (h?.history || []).filter((m: any) => m.type === 'REPLY' && new Date(m.time).getTime() >= sentAt - 60000).sort((a: any, b: any) => new Date(a.time).getTime() - new Date(b.time).getTime())[0];
        if (rep) { await admin.from('sales_email_sends').update({ reply_body: replyText(rep.email_body), reply_subject: rep.subject || null, reply_at: rep.time ? new Date(rep.time).toISOString() : null }).eq('id', n.id); bodies++; }
      } catch { /* next */ }
    }
    // stages: contacted if sent, replied if a real reply and not already further along
    const touched = [...new Set(rows.map((r) => r.lead_id).filter(Boolean))] as string[];
    for (let i = 0; i < touched.length; i += 200) await admin.from('sales_leads').update({ stage: 'contacted', last_touch_at: new Date().toISOString() }).in('id', touched.slice(i, i + 200)).eq('stage', 'new');
    const replied = [...new Set(rows.filter((r) => r.replied).map((r) => r.lead_id).filter(Boolean))] as string[];
    if (replied.length) await admin.from('sales_leads').update({ stage: 'replied' }).in('id', replied).in('stage', ['new', 'contacted']);
    // round-robin: every reply that nobody owns yet goes to the next rep in the rotation
    if (replied.length) {
      const rr = (await getSetting('round_robin')) || { members: [], next: 0 };
      const members: string[] = (rr.members || []).filter(Boolean);
      if (members.length) {
        const { data: unowned } = await admin.from('sales_leads').select('id').in('id', replied).is('assigned_to', null);
        let n = Number(rr.next || 0);
        for (const l of unowned || []) { await admin.from('sales_leads').update({ assigned_to: members[n % members.length] }).eq('id', l.id); n++; }
        if ((unowned || []).length) await setSetting('round_robin', { ...rr, members, next: n % members.length });
      }
    }
    const neg = [...new Set(rows.filter((r) => r.reply_type === 'Negative').map((r) => r.lead_id).filter(Boolean))] as string[];
    if (neg.length) await admin.from('sales_leads').update({ stage: 'dnc' }).in('id', neg);
    out[label] = { leads: leads.length, sends: rows.length, reply_bodies: bodies, analytics: await (await fetch(`${base}/campaigns/${cid}/analytics?api_key=${key}`)).json().catch(() => null) };
  }
  await setSetting('smartlead_last_sync', { at: new Date().toISOString(), by: uid, out });
  return { ok: true, campaigns: out };
}

// ---------- Smartlead: campaign control, stop a lead, push leads ----------
async function slCampaigns(key: string) { return (await secret('SMARTLEAD_CAMPAIGNS') || '4039101').split(',').map((x) => x.trim()).filter(Boolean); }
async function smartleadCampaignStatus() {
  const key = await secret('SMARTLEAD_API_KEY'); if (!key) return { error: 'No Smartlead key.' };
  const out: any[] = [];
  const dayStart = new Date(); dayStart.setUTCHours(4, 0, 0, 0); if (dayStart.getTime() > Date.now()) dayStart.setUTCDate(dayStart.getUTCDate() - 1);   // midnight ET ≈ 04:00 UTC
  for (const cid of await slCampaigns(key)) {
    const camp = await (await fetch(`${SL}/campaigns/${cid}?api_key=${key}`)).json().catch(() => ({}));
    const an = await (await fetch(`${SL}/campaigns/${cid}/analytics?api_key=${key}`)).json().catch(() => null);
    const label = `${cid} ${camp?.name || ''}`.trim();
    const { count: sentToday } = await admin.from('sales_email_sends').select('id', { count: 'exact', head: true }).eq('campaign', label).gte('sent_at', dayStart.toISOString());
    const { count: repliedToday } = await admin.from('sales_email_sends').select('id', { count: 'exact', head: true }).eq('campaign', label).eq('replied', true).gte('sent_at', dayStart.toISOString());
    out.push({ id: cid, name: camp?.name || cid, status: camp?.status || 'UNKNOWN', daily_limit: camp?.max_leads_per_day ?? null, days: camp?.scheduler_cron_value?.days || null, hours: camp?.scheduler_cron_value ? `${camp.scheduler_cron_value.startHour}–${camp.scheduler_cron_value.endHour} ${camp.scheduler_cron_value.tz || ''}` : null, sent_today: sentToday || 0, replied_today: repliedToday || 0, analytics: an ? { sent: an.sent_count, unique_sent: an.unique_sent_count, replies: an.reply_count, bounces: an.bounce_count, total_leads: an.campaign_lead_stats?.total, completed: an.campaign_lead_stats?.completed, in_progress: an.campaign_lead_stats?.inprogress, not_started: an.campaign_lead_stats?.notStarted, stopped: an.campaign_lead_stats?.stopped } : null });
  }
  return { ok: true, campaigns: out };
}
async function smartleadSetStatus(cid: string, status: string) {
  const key = await secret('SMARTLEAD_API_KEY'); if (!key) return { error: 'No Smartlead key.' };
  if (!['START', 'PAUSED', 'STOPPED'].includes(status)) return { error: 'status must be START, PAUSED or STOPPED' };
  const r = await fetch(`${SL}/campaigns/${cid}/status?api_key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
  const j = await r.json().catch(() => ({})); if (!r.ok || j.ok === false) return { error: `Smartlead said: ${JSON.stringify(j).slice(0, 160)}` };
  return { ok: true, status };
}
// Do-not-contact: unsubscribe from every campaign + global block list, and park the lead here.
async function smartleadStopLead(email: string) {
  const key = await secret('SMARTLEAD_API_KEY'); const e = email.toLowerCase().trim(); const done: string[] = [];
  if (key) {
    const found = await (await fetch(`${SL}/leads/?api_key=${key}&email=${encodeURIComponent(e)}`)).json().catch(() => null);
    const slid = found?.id;
    for (const cid of await slCampaigns(key)) {
      if (slid) { const r = await fetch(`${SL}/campaigns/${cid}/leads/${slid}/unsubscribe?api_key=${key}`, { method: 'POST' }); if (r.ok) done.push(`unsubscribed ${cid}`); }
    }
    const b = await fetch(`${SL}/leads/add-domain-block-list?api_key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain_block_list: [e], client_id: null }) });
    if (b.ok) done.push('block list');
  }
  await admin.from('sales_leads').update({ stage: 'dnc', in_calls: false, in_email: false, next_action_at: null }).ilike('email', e);
  const tags = (await getSetting('reply_tags')) || {}; tags[e] = 'Negative'; await setSetting('reply_tags', tags);
  return { ok: true, done };
}
async function smartleadAddLeads(ids: string[], cid?: string) {
  const key = await secret('SMARTLEAD_API_KEY'); if (!key) return { error: 'No Smartlead key.' };
  const campaign = cid || (await slCampaigns(key))[0];
  const { data: leads } = await admin.from('sales_leads').select('id, email, contact_name, company, domain, phone, filter_id, city, state').in('id', ids.slice(0, 2000));
  const rows = (leads || []).filter((l) => l.email).map((l) => { const [first, ...rest] = String(l.contact_name || '').split(' '); return { email: l.email, first_name: first || '', last_name: rest.join(' '), company_name: l.company || '', website: l.domain ? `https://${l.domain}` : '', phone_number: l.phone || '', location: [l.city, l.state].filter(Boolean).join(', '), custom_fields: { list_source: l.filter_id || '' } }; });
  let added = 0, dup = 0, blocked = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const r = await fetch(`${SL}/campaigns/${campaign}/leads?api_key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lead_list: rows.slice(i, i + 100), settings: { ignore_global_block_list: false, ignore_unsubscribe_list: false, ignore_duplicate_leads_in_other_campaign: false } }) });
    const j = await r.json().catch(() => ({}));
    added += Number(j.upload_count || 0); dup += Number(j.duplicate_count || 0); blocked += Number(j.block_count || 0) + Number(j.unsubscribed_lead_count || 0);
  }
  await admin.from('sales_leads').update({ in_email: true }).in('id', (leads || []).filter((l) => l.email).map((l) => l.id));
  return { ok: true, added, dup, blocked, skipped_no_email: ids.length - rows.length };
}

// weekend sending on/off, keeping the campaign's own hours and timezone
async function smartleadSchedule(cid: string, weekends: boolean) {
  const key = await secret('SMARTLEAD_API_KEY'); if (!key) return { error: 'No Smartlead key.' };
  const camp = await (await fetch(`${SL}/campaigns/${cid}?api_key=${key}`)).json().catch(() => ({}));
  const cron = camp?.scheduler_cron_value || {};
  const body = { timezone: cron.tz || 'America/New_York', days_of_the_week: weekends ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5], start_hour: cron.startHour || '09:00', end_hour: cron.endHour || '17:00', min_time_btw_emails: camp?.min_time_btwn_emails || 10, max_new_leads_per_day: camp?.max_leads_per_day || 100, schedule_start_time: new Date().toISOString() };
  const r = await fetch(`${SL}/campaigns/${cid}/schedule?api_key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok || j.ok === false) return { error: `Smartlead said: ${JSON.stringify(j).slice(0, 160)}` };
  return { ok: true, days: body.days_of_the_week };
}

// ---------- Google Calendar (secret iCal address) ----------
function icsUnfold(t: string) { return t.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, ''); }
function icsDate(v: string, params: string): string | null {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/); if (!m) return null;
  if (!m[4]) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).toISOString();           // all-day → noon UTC
  if (m[7] === 'Z') return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))).toISOString();
  // floating / TZID: treat as America/New_York (the team's zone)
  const tz = /TZID=([^;:]+)/.exec(params)?.[1] || 'America/New_York';
  const guess = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
  const offMin = (() => { try { const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(guess).find((p) => p.type === 'timeZoneName')?.value || 'GMT-5'; const mm = f.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/); return mm ? (mm[1] === '-' ? -1 : 1) * (+mm[2] * 60 + +(mm[3] || 0)) : -300; } catch { return -300; } })();
  return new Date(guess.getTime() - offMin * 60000).toISOString();
}
async function gcalSync(uid: string) {
  const url = await secret('GCAL_ICS_URL'); if (!url) return { error: 'Paste the Google Calendar secret iCal address under Settings first.' };
  const r = await fetch(url); if (!r.ok) return { error: `Google Calendar feed ${r.status}` };
  const text = icsUnfold(await r.text());
  const blocks = text.split('BEGIN:VEVENT').slice(1).map((b) => b.split('END:VEVENT')[0]);
  const lo = Date.now() - 30 * 86400000, hi = Date.now() + 120 * 86400000; let n = 0;
  for (const b of blocks) {
    const get = (k: string) => { const m = b.match(new RegExp(`^${k}([^:\n]*):(.*)$`, 'm')); return m ? { params: m[1], value: m[2].trim() } : null; };
    const ds = get('DTSTART'); if (!ds) continue; const starts = icsDate(ds.value, ds.params); if (!starts) continue;
    const t = new Date(starts).getTime(); if (t < lo || t > hi) continue;
    const de = get('DTEND'); const ends = de ? icsDate(de.value, de.params) : null;
    const uidv = get('UID')?.value || `${starts}-${get('SUMMARY')?.value}`;
    const attendees = [...b.matchAll(/^ATTENDEE([^:\n]*):mailto:(.+)$/gim)].map((m) => ({ params: m[1], email: m[2].trim().toLowerCase() }));
    const organizer = /^ORGANIZER[^:\n]*:mailto:(.+)$/im.exec(b)?.[1]?.trim().toLowerCase();
    const guest = attendees.find((a) => a.email !== organizer && !a.email.endsWith('@shipbay3pl.com'));
    const cn = guest ? /CN=([^;]+)/.exec(guest.params)?.[1]?.replace(/^"|"$/g, '') : null;
    const desc = (get('DESCRIPTION')?.value || '').replace(/\\n/g, '\n').replace(/\\,/g, ',');
    const link = /https?:\/\/(meet\.google\.com|[a-z0-9.]*zoom\.us|teams\.microsoft\.com)[^\s"<>]*/i.exec(desc + ' ' + (get('LOCATION')?.value || ''))?.[0] || null;
    const row: any = { external_id: `gcal:${uidv}`, source: 'google', name: (get('SUMMARY')?.value || '(no title)').replace(/\\,/g, ','), starts_at: starts, ends_at: ends, status: /^STATUS:CANCELLED/m.test(b) ? 'canceled' : undefined, invitee_name: cn || null, invitee_email: guest?.email || null, location: link || (get('LOCATION')?.value || null), description: desc.slice(0, 2000) || null, all_day: !ds.value.includes('T') };
    if (guest?.email) { const { data: l } = await admin.from('sales_leads').select('id').ilike('email', guest.email).maybeSingle(); if (l) row.lead_id = l.id; }
    const { data: ex } = await admin.from('sales_meetings').select('id').eq('external_id', row.external_id).maybeSingle();
    if (!ex) { row.assigned_to = uid; row.status = row.status || 'active'; }
    Object.keys(row).forEach((k) => row[k] === undefined && delete row[k]);
    await admin.from('sales_meetings').upsert(row, { onConflict: 'external_id' }); n++;
  }
  await setSetting('gcal_last_sync', { at: new Date().toISOString(), events: n });
  return { ok: true, events: n };
}

// ---------- Gmail (per staff user) ----------
async function googleAccess(uid: string) {
  const { data } = await admin.from('gmail_accounts').select('*').eq('user_id', uid).maybeSingle(); if (!data) return null;
  if (new Date(data.expires_at).getTime() - Date.now() > 60000) return data;
  const [id, sec] = [await secret('GOOGLE_CLIENT_ID'), await secret('GOOGLE_CLIENT_SECRET')];
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: id, client_secret: sec, grant_type: 'refresh_token', refresh_token: data.refresh_token || '' }) });
  const j = await r.json(); if (!r.ok || !j.access_token) { await admin.from('gmail_accounts').update({ last_error: `Token refresh failed: ${JSON.stringify(j).slice(0, 160)}` }).eq('user_id', uid); return null; }
  const upd = { access_token: j.access_token, expires_at: new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString(), last_error: null };
  await admin.from('gmail_accounts').update(upd).eq('user_id', uid); return { ...data, ...upd };
}
const b64url = (s: string) => { try { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))); } catch { return ''; } };
function gmailBody(payload: any): string {
  const parts: any[] = []; const walk = (p: any) => { if (!p) return; parts.push(p); (p.parts || []).forEach(walk); }; walk(payload);
  const plain = parts.find((p) => p.mimeType === 'text/plain' && p.body?.data); if (plain) return replyText(b64url(plain.body.data).replace(/\n/g, '<br>'));
  const html = parts.find((p) => p.mimeType === 'text/html' && p.body?.data); if (html) return replyText(b64url(html.body.data));
  return '';
}
const addr = (h: string) => (h || '').toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
const hdrs = (m: any) => Object.fromEntries((m.payload?.headers || []).map((h: any) => [h.name.toLowerCase(), h.value]));
const fromName = (h: string) => (h || '').replace(/<.*$/, '').replace(/"/g, '').trim() || null;
/** pull the whole mailbox (inbound + sent, no spam/trash/promotions) into gmail_messages; link to leads by address */
async function gmailSync(uid: string, all: boolean) {
  const { data: accts } = all ? await admin.from('gmail_accounts').select('user_id, email, last_sync_at') : await admin.from('gmail_accounts').select('user_id, email, last_sync_at').eq('user_id', uid);
  if (!accts?.length) return { error: 'No Gmail connected yet.' };
  const byMail = new Map<string, any>();
  for (let off = 0; ; off += 1000) { const { data: page } = await admin.from('sales_leads').select('id, email, stage, assigned_to, company').not('email', 'is', null).range(off, off + 999); for (const l of page || []) byMail.set(String(l.email).toLowerCase(), l); if (!page || page.length < 1000) break; }
  const out: Record<string, unknown> = {};
  for (const a of accts) {
    const tok = await googleAccess(a.user_id); if (!tok) { out[a.email] = 'token problem'; continue; }
    const H = { Authorization: `Bearer ${tok.access_token}` }; const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
    const me = String(a.email || '').toLowerCase();
    // first run: 21 days; after that: since the last check minus a day of slack
    const since = a.last_sync_at ? Math.floor((new Date(a.last_sync_at).getTime() - 86400000) / 1000) : Math.floor((Date.now() - 21 * 86400000) / 1000);
    const ids: string[] = []; let pageToken = '';
    for (let n = 0; n < 5; n++) { const j = await (await fetch(`${G}/messages?${new URLSearchParams({ q: `after:${since} -in:spam -in:trash -category:promotions -category:social`, maxResults: '100', ...(pageToken ? { pageToken } : {}) })}`, { headers: H })).json(); if (j.error) { out[a.email] = `Gmail: ${j.error.message}`; break; } ids.push(...(j.messages || []).map((m: any) => m.id)); pageToken = j.nextPageToken || ''; if (!pageToken) break; }
    const { data: have } = await admin.from('gmail_messages').select('gmail_id').eq('user_id', a.user_id).in('gmail_id', ids.length ? ids : ['-']); const seen = new Set((have || []).map((h: any) => h.gmail_id));
    let added = 0, linked = 0;
    for (const id of ids) {
      if (seen.has(id)) continue;
      const m = await (await fetch(`${G}/messages/${id}?format=full`, { headers: H })).json(); if (!m?.id) continue;
      const hd = hdrs(m); const labels: string[] = m.labelIds || []; const isSent = labels.includes('SENT') || addr(hd.from)[0] === me;
      const from = addr(hd.from)[0] || null; const tos = addr(hd.to); const other = isSent ? tos.find((t) => t !== me) || tos[0] || null : from;
      const when = new Date(Number(m.internalDate || Date.now())).toISOString();
      const l = other ? byMail.get(other) : null;
      const body = gmailBody(m.payload) || m.snippet || '';
      const { error } = await admin.from('gmail_messages').upsert({ user_id: a.user_id, gmail_id: id, thread_id: m.threadId || null, message_id_hdr: hd['message-id'] || null, from_email: from, from_name: fromName(hd.from), to_email: tos.join(', ') || null, subject: hd.subject || '(no subject)', snippet: (m.snippet || '').slice(0, 300), body: body.slice(0, 20000), at: when, is_sent: isSent, lead_id: l?.id || null, read_at: isSent || !labels.includes('UNREAD') ? when : null }, { onConflict: 'user_id,gmail_id' });
      if (error) continue; added++;
      if (!l) continue; linked++;
      if (isSent) {
        const { data: dup } = await admin.from('sales_touches').select('id').eq('lead_id', l.id).eq('note', `gmail:${id}`).maybeSingle();
        if (!dup) await admin.from('sales_touches').insert({ lead_id: l.id, kind: 'email_sent', note: `gmail:${id}`, at: when, by_user: a.user_id });
        await admin.from('sales_leads').update({ last_touch_at: when, last_outcome: 'email_sent', ...(l.stage === 'new' ? { stage: 'contacted' } : {}), ...(l.assigned_to ? {} : { assigned_to: a.user_id }) }).eq('id', l.id);
      } else {
        await admin.from('sales_email_sends').upsert({ external_id: `gmail:${id}`, lead_id: l.id, lead_email: other, lead_name: fromName(hd.from), campaign: `Gmail · ${a.email}`, mailbox: a.email, step: 0, subject: hd.subject || '(no subject)', sent_at: when, replied: true, reply_at: when, reply_body: body.slice(0, 4000), reply_subject: hd.subject || null, bounced: false }, { onConflict: 'external_id' });
        await admin.from('sales_leads').update({ ...(['new', 'contacted'].includes(l.stage) ? { stage: 'replied' } : {}), last_touch_at: when, ...(l.assigned_to ? {} : { assigned_to: a.user_id }) }).eq('id', l.id);
      }
    }
    if (!out[a.email]) { await admin.from('gmail_accounts').update({ last_sync_at: new Date().toISOString(), last_error: null }).eq('user_id', a.user_id); out[a.email] = { scanned: ids.length, added, linked }; }
    else await admin.from('gmail_accounts').update({ last_error: String(out[a.email]) }).eq('user_id', a.user_id);
  }
  return { ok: true, accounts: out };
}
const b64urlEnc = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rfc2047 = (s: string) => (/^[\x00-\x7F]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`);
/** send an email from the rep's own Gmail (reply into a thread when thread_id is given) */
async function gmailSend(uid: string, b: any) {
  const tok = await googleAccess(uid); if (!tok) return { error: 'Gmail is not connected.' };
  if (!String(tok.scopes || '').includes('gmail.send')) return { error: 'Reconnect Gmail (Sales → Settings) to allow sending from here.', reconnect: true };
  const to = String(b.to || '').trim(); const subject = String(b.subject || '').trim() || '(no subject)'; const body = String(b.body || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { error: 'That "to" address does not look right.' };
  const lines = [`From: ${tok.email}`, `To: ${to}`, `Subject: ${rfc2047(subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit'];
  if (b.in_reply_to) { lines.push(`In-Reply-To: ${b.in_reply_to}`, `References: ${b.in_reply_to}`); }
  const raw = b64urlEnc(lines.join('\r\n') + '\r\n\r\n' + body);
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw, ...(b.thread_id && !String(b.thread_id).startsWith('sl:') ? { threadId: b.thread_id } : {}) }) });
  const j = await r.json(); if (!r.ok) return { error: `Gmail refused: ${j.error?.message || r.status}`, reconnect: r.status === 403 };
  const when = new Date().toISOString(); const leadId = b.lead_id || null;
  await admin.from('gmail_messages').upsert({ user_id: uid, gmail_id: j.id, thread_id: j.threadId || b.thread_id || null, from_email: tok.email, from_name: null, to_email: to, subject, snippet: body.slice(0, 300), body: body.slice(0, 20000), at: when, is_sent: true, lead_id: leadId, read_at: when }, { onConflict: 'user_id,gmail_id' });
  if (leadId) {
    await admin.from('sales_touches').insert({ lead_id: leadId, kind: 'email_sent', note: `gmail:${j.id}`, at: when, by_user: uid });
    const { data: l } = await admin.from('sales_leads').select('stage, assigned_to').eq('id', leadId).maybeSingle();
    await admin.from('sales_leads').update({ last_touch_at: when, last_outcome: 'email_sent', ...(l?.stage === 'new' ? { stage: 'contacted' } : {}), ...(l?.assigned_to ? {} : { assigned_to: uid }) }).eq('id', leadId);
  }
  return { ok: true, id: j.id, thread_id: j.threadId };
}


// ============================================================ HubSpot: the system of record ============================================================
// Portal ↔ HubSpot, both ways. Accounts (sales_leads) ↔ company + contact + deal; calls / touches / meetings / mailbox ↔ engagements.
// The cold list stays out: only accounts that were worked (stage past New) or came from a non-cold channel are pushed.
const HS = 'https://api.hubapi.com';
const HS_STAGES: [string, string, number][] = [['contacted', 'Contacted', 0.1], ['replied', 'Replied', 0.25], ['call_booked', 'Call booked', 0.4], ['quoted', 'Quoted', 0.6], ['signed', 'Closed won', 1], ['lost', 'Closed lost', 0]];
const HS_LEAD_STATUS: Record<string, string> = { new: 'NEW', contacted: 'ATTEMPTED_TO_CONTACT', replied: 'OPEN', call_booked: 'IN_PROGRESS', quoted: 'OPEN_DEAL', signed: 'CONNECTED', lost: 'UNQUALIFIED', dnc: 'UNQUALIFIED' };
const HS_OUTCOME: Record<string, string> = { connected: 'Connected', voicemail: 'Left voicemail', no_answer: 'No answer', gatekeeper: 'Left live message', booked: 'Connected', not_fit: 'Connected', wrong_number: 'Wrong number', busy: 'Busy' };
let hsDispositions: Record<string, string> | null = null;
async function hs(path: string, init: RequestInit = {}, tok?: string) {
  const token = tok || await secret('HUBSPOT_TOKEN'); if (!token) throw new Error('HubSpot token is missing — paste it under Admin → Connections.');
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${HS}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 1100 * (attempt + 1))); continue; }
    const text = await r.text(); let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text }; }
    if (!r.ok) { const e: any = new Error(`HubSpot ${r.status} on ${path}: ${(j?.message || text || '').slice(0, 220)}`); e.status = r.status; e.body = j; throw e; }
    return j;
  }
  throw new Error('HubSpot rate limit — try again in a minute.');
}
const hsCfg = async () => (await getSetting('hubspot')) || {};
const saveHsCfg = (c: unknown) => setSetting('hubspot', c);
const hsPortal = async () => { const c = await hsCfg(); return c.portal_id ? `https://app.hubspot.com/contacts/${c.portal_id}` : null; };

const CALL_DEBRIEF_PROPS: [string, string][] = [['shipbay_dial_result', 'Dial result'], ['shipbay_picked_up', 'Who picked up'], ['shipbay_fit', 'Fit'], ['shipbay_not_fit_reason', 'Not a fit — reason'], ['shipbay_not_fit_detail', 'Not a fit — detail'], ['shipbay_orders_month', 'Orders / month (said on the call)'], ['shipbay_current_setup', 'Current setup'], ['shipbay_pain', 'Pain named'], ['shipbay_result', 'Call result'], ['shipbay_callback_at', 'Callback date'], ['shipbay_hour_block', 'Hour block (ET)'], ['shipbay_email_result', 'Email result'], ['shipbay_list', 'ShipBay list']];
const CONTACT_DEBRIEF_PROPS: [string, string][] = [['shipbay_orders_month', 'Orders / month (said on a call)'], ['shipbay_current_setup', 'Current setup'], ['shipbay_pain', 'Pain named'], ['shipbay_not_fit_reason', 'Not a fit — reason'], ['shipbay_picked_up', 'Who picks up']];
const debriefBody = (c: any) => [c.note, c.dial_result && `Dial: ${c.dial_result}`, c.picked_up && `Picked up: ${c.picked_up}`, c.fit && `Fit: ${c.fit}${c.not_fit_reason ? ` (${c.not_fit_reason}${c.not_fit_detail ? ` — ${c.not_fit_detail}` : ''})` : ''}`, c.orders_month != null && `Orders/mo: ${c.orders_month}`, c.current_setup && `Setup: ${c.current_setup}`, c.pain && `Pain: ${c.pain}`, c.result && `Result: ${c.result}${c.callback_at ? ` (${c.callback_at.slice(0, 10)})` : ''}`, c.email_result && `Email: ${c.email_result}`].filter(Boolean).join('\n');
/** one-time: pipeline with the portal's stages, custom properties, owner map, portal id */
async function hubspotSetup() {
  const cfg = await hsCfg();
  const acct = await hs('/account-info/v3/details'); cfg.portal_id = acct.portalId; cfg.timezone = acct.timeZone;
  // pipeline
  const pipes = await hs('/crm/v3/pipelines/deals');
  let pipe = (pipes.results || []).find((p: any) => p.id === cfg.pipeline_id) || (pipes.results || []).find((p: any) => p.label === 'ShipBay Sales');
  if (!pipe) pipe = await hs('/crm/v3/pipelines/deals', { method: 'POST', body: JSON.stringify({ label: 'ShipBay Sales', displayOrder: 0, stages: HS_STAGES.map(([, label, p], i) => ({ label, displayOrder: i, metadata: { probability: String(p) } })) }) });
  const have = new Map<string, string>((pipe.stages || []).map((st: any) => [st.label, st.id]));
  for (const [k, label, p] of HS_STAGES) if (!have.has(label)) { const st = await hs(`/crm/v3/pipelines/deals/${pipe.id}/stages`, { method: 'POST', body: JSON.stringify({ label, displayOrder: have.size, metadata: { probability: String(p) } }) }); have.set(label, st.id); }
  cfg.pipeline_id = pipe.id; cfg.stage_ids = Object.fromEntries(HS_STAGES.map(([k, label]) => [k, have.get(label)])); cfg.stage_keys = Object.fromEntries(HS_STAGES.map(([k, label]) => [have.get(label), k]));
  // custom properties so a record always points back at its portal row
  const ensureProp = async (obj: string, name: string, label: string, group: string) => { try { await hs(`/crm/v3/properties/${obj}/${name}`); } catch (e: any) { if (e.status !== 404) throw e; await hs(`/crm/v3/properties/${obj}`, { method: 'POST', body: JSON.stringify({ name, label, type: 'string', fieldType: 'text', groupName: group }) }); } };
  await ensureProp('contacts', 'shipbay_account_id', 'ShipBay account id', 'contactinformation');
  await ensureProp('contacts', 'shipbay_source', 'ShipBay channel', 'contactinformation');
  await ensureProp('contacts', 'shipbay_list', 'ShipBay list', 'contactinformation');
  await ensureProp('companies', 'shipbay_account_id', 'ShipBay account id', 'companyinformation');
  await ensureProp('deals', 'shipbay_account_id', 'ShipBay account id', 'dealinformation');
  // post-call debrief (Derek, 2026-11-02): the nine answers live on the call, the durable ones also on the contact
  for (const [name, label] of CALL_DEBRIEF_PROPS) await ensureProp('calls', name, label, 'call');
  for (const [name, label] of CONTACT_DEBRIEF_PROPS) await ensureProp('contacts', name, label, 'contactinformation');
  // owners ↔ staff by email
  const { data: staff } = await admin.from('profiles').select('id, email, role, hs_owner_id').like('role', 'shipbay%');
  cfg.owners = cfg.owners || {}; cfg.owner_users = cfg.owner_users || {};
  for (const p of staff || []) if (p.hs_owner_id) { cfg.owners[p.id] = String(p.hs_owner_id); cfg.owner_users[String(p.hs_owner_id)] = p.id; }
  let owners: any = { results: [] }; try { owners = await hs('/crm/v3/owners?limit=100'); cfg.owners_error = null; } catch (e) { cfg.owners_error = `Owners not readable (add the crm.objects.owners.read scope to the private app): ${String((e as Error).message).slice(0, 120)}`; }
  for (const o of owners.results || []) { const p = (staff || []).find((x: any) => String(x.email).toLowerCase() === String(o.email).toLowerCase()); if (p) { cfg.owners[p.id] = String(o.id); cfg.owner_users[String(o.id)] = p.id; await admin.from('profiles').update({ hs_owner_id: String(o.id) }).eq('id', p.id); } }
  // unassigned accounts land on the owner (first shipbay_owner with a HubSpot owner id)
  const ownerProfile = (staff || []).find((x: any) => x.role === 'shipbay_owner' && cfg.owners[x.id]) || (staff || []).find((x: any) => cfg.owners[x.id]);
  if (ownerProfile) cfg.default_owner = cfg.owners[ownerProfile.id];
  cfg.setup_at = new Date().toISOString(); await saveHsCfg(cfg); return cfg;
}
const hsMoney = (v: unknown) => (v == null || v === '' ? undefined : String(Math.round(Number(v) || 0)));
const splitName = (n: string) => { const parts = String(n || '').trim().split(/\s+/); return { firstname: parts.shift() || '', lastname: parts.join(' ') }; };
const pushable = (l: any) => l.stage !== 'new' || !['cold_email', 'cold_call'].includes(l.source);
/** portal → HubSpot for one account: company (by domain), contact (by email), deal (stage past New) */
async function hsPushLead(l: any, cfg: any) {
  const owner = (l.assigned_to && cfg.owners?.[l.assigned_to]) || cfg.default_owner || undefined;
  const patch: any = { hs_synced_at: new Date().toISOString(), hs_error: null };
  // company
  if (l.company || l.domain) {
    const props: any = { name: l.company || l.domain, domain: l.domain || undefined, phone: l.phone || undefined, city: l.city || undefined, state: l.state || undefined, shipbay_account_id: l.id, hubspot_owner_id: owner, description: l.notes ? String(l.notes).slice(0, 5000) : undefined };
    let cid = l.hs_company_id;
    if (!cid && l.domain) { const f = await hs('/crm/v3/objects/companies/search', { method: 'POST', body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: l.domain.toLowerCase() }] }], limit: 1 }) }); cid = f.results?.[0]?.id; }
    if (!cid) { const f = await hs('/crm/v3/objects/companies/search', { method: 'POST', body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'shipbay_account_id', operator: 'EQ', value: l.id }] }], limit: 1 }) }); cid = f.results?.[0]?.id; }
    if (cid) await hs(`/crm/v3/objects/companies/${cid}`, { method: 'PATCH', body: JSON.stringify({ properties: props }) }); else cid = (await hs('/crm/v3/objects/companies', { method: 'POST', body: JSON.stringify({ properties: props }) })).id;
    patch.hs_company_id = String(cid);
  }
  // contact
  if (l.email || l.contact_name) {
    const props: any = { ...splitName(l.contact_name || ''), email: l.email || undefined, phone: l.phone || undefined, jobtitle: l.title || undefined, city: l.city || undefined, state: l.state || undefined, company: l.company || undefined, website: l.domain || undefined, hs_lead_status: HS_LEAD_STATUS[l.stage] || 'NEW', lifecyclestage: l.stage === 'signed' ? 'customer' : ['quoted', 'call_booked'].includes(l.stage) ? 'opportunity' : l.stage === 'replied' ? 'salesqualifiedlead' : 'lead', shipbay_account_id: l.id, shipbay_source: l.source, shipbay_list: l.filter_id || undefined, hubspot_owner_id: owner, shipbay_orders_month: l.orders_month_actual != null ? String(l.orders_month_actual) : undefined, shipbay_current_setup: l.current_setup || undefined, shipbay_pain: l.pain || undefined, shipbay_not_fit_reason: l.not_fit_reason || undefined, shipbay_picked_up: l.picked_up || undefined };
    let pid = l.hs_contact_id;
    if (!pid && l.email) { const f = await hs('/crm/v3/objects/contacts/search', { method: 'POST', body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: l.email.toLowerCase() }] }], limit: 1 }) }); pid = f.results?.[0]?.id; }
    try { if (pid) await hs(`/crm/v3/objects/contacts/${pid}`, { method: 'PATCH', body: JSON.stringify({ properties: props }) }); else pid = (await hs('/crm/v3/objects/contacts', { method: 'POST', body: JSON.stringify({ properties: props }) })).id; }
    catch (e: any) { const m = String(e.message).match(/Existing ID:\s*(\d+)/); if (!m) throw e; pid = m[1]; await hs(`/crm/v3/objects/contacts/${pid}`, { method: 'PATCH', body: JSON.stringify({ properties: props }) }); }
    patch.hs_contact_id = String(pid);
    if (patch.hs_company_id) await hs(`/crm/v4/objects/contacts/${pid}/associations/default/companies/${patch.hs_company_id}`, { method: 'PUT' }).catch(() => {});
  }
  // deal
  const stageId = cfg.stage_ids?.[l.stage];
  if (stageId && cfg.pipeline_id) {
    const { data: q } = await admin.from('quotes').select('inputs, rates, model, status, internal_only').eq('lead_id', l.id).eq('internal_only', false).neq('status', 'superseded').order('updated_at', { ascending: false }).limit(1).maybeSingle();
    const monthly = l.deal_value != null ? Number(l.deal_value) : null;
    const props: any = { dealname: `${l.company || l.email} — fulfillment`, pipeline: cfg.pipeline_id, dealstage: stageId, amount: monthly != null ? hsMoney(monthly * 12) : undefined, hubspot_owner_id: owner, shipbay_account_id: l.id, closedate: l.won_at || undefined, description: monthly != null ? `Expected services ${Math.round(monthly)}/mo (annualized amount)${q ? ' · quote in the portal' : ''}` : undefined };
    let did = l.hs_deal_id;
    if (!did) { const f = await hs('/crm/v3/objects/deals/search', { method: 'POST', body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'shipbay_account_id', operator: 'EQ', value: l.id }] }], limit: 1 }) }); did = f.results?.[0]?.id; }
    // adopt an open deal the website trigger already made for this contact (moves it into the ShipBay pipeline)
    if (!did && patch.hs_contact_id) {
      const a = await hs(`/crm/v4/objects/contacts/${patch.hs_contact_id}/associations/deals?limit=20`).catch(() => null);
      const ids = (a?.results || []).map((x: any) => String(x.toObjectId));
      if (ids.length) { const b = await hs('/crm/v3/objects/deals/batch/read', { method: 'POST', body: JSON.stringify({ properties: ['dealstage', 'pipeline'], inputs: ids.map((id: string) => ({ id })) }) }).catch(() => null); const open = (b?.results || []).find((d: any) => !/closed/.test(d.properties.dealstage || '') && d.properties.dealstage !== cfg.stage_ids?.lost); if (open) did = open.id; }
    }
    if (did) await hs(`/crm/v3/objects/deals/${did}`, { method: 'PATCH', body: JSON.stringify({ properties: props }) }); else did = (await hs('/crm/v3/objects/deals', { method: 'POST', body: JSON.stringify({ properties: props }) })).id;
    patch.hs_deal_id = String(did);
    if (patch.hs_contact_id) await hs(`/crm/v4/objects/deals/${did}/associations/default/contacts/${patch.hs_contact_id}`, { method: 'PUT' }).catch(() => {});
    if (patch.hs_company_id) await hs(`/crm/v4/objects/deals/${did}/associations/default/companies/${patch.hs_company_id}`, { method: 'PUT' }).catch(() => {});
  }
  await admin.from('sales_leads').update(patch).eq('id', l.id);
  return { ...l, ...patch };
}
const assoc = (cid?: string, did?: string, kind = 'contacts') => [...(cid ? [{ to: { id: cid }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: kind === 'notes' ? 202 : kind === 'calls' ? 194 : kind === 'emails' ? 198 : kind === 'meetings' ? 200 : 202 }] }] : []), ...(did ? [{ to: { id: did }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: kind === 'notes' ? 214 : kind === 'calls' ? 206 : kind === 'emails' ? 210 : kind === 'meetings' ? 212 : 214 }] }] : [])];
/** portal → HubSpot engagements for an account */
async function hsPushActivity(l: any, cfg: any, since: string | null) {
  const owner = (l.assigned_to && cfg.owners?.[l.assigned_to]) || cfg.default_owner || undefined; let n = 0;
  const { data: calls } = await admin.from('sales_calls').select('*').eq('lead_id', l.id).is('hs_id', null);
  for (const c of calls || []) {
    const debrief: Record<string, string> = {};
    for (const [k, col] of [['shipbay_dial_result', 'dial_result'], ['shipbay_picked_up', 'picked_up'], ['shipbay_fit', 'fit'], ['shipbay_not_fit_reason', 'not_fit_reason'], ['shipbay_not_fit_detail', 'not_fit_detail'], ['shipbay_orders_month', 'orders_month'], ['shipbay_current_setup', 'current_setup'], ['shipbay_pain', 'pain'], ['shipbay_result', 'result'], ['shipbay_callback_at', 'callback_at'], ['shipbay_hour_block', 'hour_block'], ['shipbay_email_result', 'email_result'], ['shipbay_list', 'list_id']]) if (c[col] != null && c[col] !== '') debrief[k] = String(c[col]);
    const r = await hs('/crm/v3/objects/calls', { method: 'POST', body: JSON.stringify({ properties: { hs_timestamp: c.started_at, hs_call_title: `Call — ${(c.result || c.dial_result || c.outcome).replace(/_/g, ' ')}`, hs_call_body: debriefBody(c), hs_call_duration: String((c.seconds || 0) * 1000), hs_call_status: 'COMPLETED', hs_call_direction: 'OUTBOUND', hubspot_owner_id: cfg.owners?.[c.by_user] || owner, ...debrief }, associations: assoc(l.hs_contact_id, l.hs_deal_id, 'calls') }) });
    await admin.from('sales_calls').update({ hs_id: String(r.id) }).eq('id', c.id); n++;
  }
  const { data: touches } = await admin.from('sales_touches').select('*').eq('lead_id', l.id).is('hs_id', null);
  for (const t of touches || []) {
    if (t.kind === 'email_sent' && String(t.note || '').startsWith('gmail:')) { await admin.from('sales_touches').update({ hs_id: 'skip' }).eq('id', t.id); continue; }   // the mailbox row carries it
    const isNote = t.kind !== 'email_sent';
    const r = isNote
      ? await hs('/crm/v3/objects/notes', { method: 'POST', body: JSON.stringify({ properties: { hs_timestamp: t.at, hs_note_body: `${t.kind === 'sms' ? 'SMS: ' : t.kind === 'meeting_note' ? 'Meeting note: ' : ''}${t.note || ''}`, hubspot_owner_id: cfg.owners?.[t.by_user] || owner }, associations: assoc(l.hs_contact_id, l.hs_deal_id, 'notes') }) })
      : await hs('/crm/v3/objects/emails', { method: 'POST', body: JSON.stringify({ properties: { hs_timestamp: t.at, hs_email_direction: 'EMAIL', hs_email_status: 'SENT', hs_email_subject: 'Email sent (logged in portal)', hs_email_text: t.note || '', hubspot_owner_id: cfg.owners?.[t.by_user] || owner }, associations: assoc(l.hs_contact_id, l.hs_deal_id, 'emails') }) });
    await admin.from('sales_touches').update({ hs_id: String(r.id) }).eq('id', t.id); n++;
  }
  const { data: mails } = await admin.from('gmail_messages').select('*').eq('lead_id', l.id).is('hs_id', null).order('at').limit(50);
  for (const m of mails || []) {
    const r = await hs('/crm/v3/objects/emails', { method: 'POST', body: JSON.stringify({ properties: { hs_timestamp: m.at, hs_email_direction: m.is_sent ? 'EMAIL' : 'INCOMING_EMAIL', hs_email_status: 'SENT', hs_email_subject: m.subject || '', hs_email_text: (m.body || m.snippet || '').slice(0, 60000), hs_email_headers: JSON.stringify({ from: { email: m.from_email, firstName: m.from_name || '' }, to: String(m.to_email || '').split(',').map((e: string) => ({ email: e.trim() })).filter((x: any) => x.email) }), hubspot_owner_id: cfg.owners?.[m.user_id] || owner }, associations: assoc(l.hs_contact_id, l.hs_deal_id, 'emails') }) });
    await admin.from('gmail_messages').update({ hs_id: String(r.id) }).eq('id', m.id); n++;
  }
  const { data: sends } = await admin.from('sales_email_sends').select('*').eq('lead_id', l.id).eq('replied', true).is('mailbox', null).gt('reply_at', since || '2000-01-01').limit(20);
  for (const s of sends || []) {
    const key = `sl:${s.id}`; const { data: dup } = await admin.from('sales_touches').select('id').eq('hs_id', key).maybeSingle(); if (dup) continue;
    await hs('/crm/v3/objects/emails', { method: 'POST', body: JSON.stringify({ properties: { hs_timestamp: s.reply_at, hs_email_direction: 'INCOMING_EMAIL', hs_email_status: 'SENT', hs_email_subject: s.reply_subject || `Re: ${s.subject || ''}`, hs_email_text: (s.reply_body || '').slice(0, 60000), hubspot_owner_id: owner }, associations: assoc(l.hs_contact_id, l.hs_deal_id, 'emails') }) });
    await admin.from('sales_touches').insert({ lead_id: l.id, kind: 'note', note: `Smartlead reply mirrored to HubSpot`, at: s.reply_at, by_user: null, hs_id: key }); n++;
  }
  const { data: meets } = await admin.from('sales_meetings').select('*').eq('lead_id', l.id).is('hs_id', null);
  for (const m of meets || []) {
    const r = await hs('/crm/v3/objects/meetings', { method: 'POST', body: JSON.stringify({ properties: { hs_timestamp: m.starts_at, hs_meeting_title: m.name || 'Sales call', hs_meeting_start_time: m.starts_at, hs_meeting_end_time: m.ends_at || m.starts_at, hs_meeting_body: [m.location, m.notes, m.outcome].filter(Boolean).join('\n'), hs_meeting_outcome: m.status === 'canceled' ? 'CANCELED' : new Date(m.starts_at) < new Date() ? 'COMPLETED' : 'SCHEDULED', hubspot_owner_id: cfg.owners?.[m.assigned_to] || owner }, associations: assoc(l.hs_contact_id, l.hs_deal_id, 'meetings') }) });
    await admin.from('sales_meetings').update({ hs_id: String(r.id) }).eq('id', m.id); n++;
  }
  return n;
}
/** HubSpot → portal: contacts / companies / deals / engagements changed since the last pull */
async function hsPull(cfg: any, left: () => number = () => 1e9) {
  const since = cfg.last_pull ? new Date(new Date(cfg.last_pull).getTime() - 120000).toISOString() : '2000-01-01T00:00:00Z';
  const ms = String(new Date(since).getTime()); const out = { contacts: 0, deals: 0, companies: 0, activities: 0, created: 0 };
  let cut = false;
  const search = async (obj: string, props: string[]) => { if (left() < 15000) { cut = true; return []; } const modProp = obj === 'contacts' ? 'lastmodifieddate' : 'hs_lastmodifieddate'; const rows: any[] = []; let after: string | undefined; for (let i = 0; i < 10; i++) { const j = await hs(`/crm/v3/objects/${obj}/search`, { method: 'POST', body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: modProp, operator: 'GTE', value: ms }] }], properties: props, sorts: [{ propertyName: modProp, direction: 'ASCENDING' }], limit: 100, ...(after ? { after } : {}) }) }); rows.push(...(j.results || [])); after = j.paging?.next?.after; if (!after) break; } return rows; };
  // contacts
  for (const c of await search('contacts', ['firstname', 'lastname', 'email', 'phone', 'jobtitle', 'company', 'website', 'city', 'state', 'hs_lead_status', 'hubspot_owner_id', 'shipbay_account_id', 'lifecyclestage'])) {
    const p = c.properties; const email = (p.email || '').toLowerCase();
    let { data: l } = await admin.from('sales_leads').select('*').eq('hs_contact_id', String(c.id)).maybeSingle();
    if (!l && p.shipbay_account_id) ({ data: l } = await admin.from('sales_leads').select('*').eq('id', p.shipbay_account_id).maybeSingle());
    if (!l && email) { const { data: id } = await admin.rpc('find_lead', { p_email: email, p_domain: '', p_company: p.company || '' }); if (id) ({ data: l } = await admin.from('sales_leads').select('*').eq('id', id).maybeSingle()); }
    const domain = (p.website || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase() || null;
    const fields: any = { contact_name: [p.firstname, p.lastname].filter(Boolean).join(' ') || undefined, email: email || undefined, phone: p.phone || undefined, title: p.jobtitle || undefined, city: p.city || undefined, state: p.state || undefined, hs_contact_id: String(c.id), hs_owner_id: p.hubspot_owner_id || undefined, assigned_to: cfg.owner_users?.[p.hubspot_owner_id] || undefined, hs_pulled_at: new Date().toISOString() };
    Object.keys(fields).forEach((k) => fields[k] === undefined && delete fields[k]);
    if (l) { await admin.from('sales_leads').update(fields).eq('id', l.id); out.contacts++; }
    else if (email || p.company) { const { data: ins } = await admin.from('sales_leads').insert({ ...fields, company: p.company || (domain ? domain.split('.')[0] : null) || email, domain, source: 'inbound', stage: p.lifecyclestage === 'customer' ? 'signed' : p.hs_lead_status === 'UNQUALIFIED' ? 'lost' : 'new', notes: 'Created in HubSpot.', last_touch_at: new Date().toISOString() }).select('id').single(); if (ins) { await hs(`/crm/v3/objects/contacts/${c.id}`, { method: 'PATCH', body: JSON.stringify({ properties: { shipbay_account_id: ins.id } }) }).catch(() => {}); out.created++; } }
  }
  // companies: name / domain / phone changes on linked accounts
  for (const c of await search('companies', ['name', 'domain', 'phone', 'city', 'state', 'shipbay_account_id', 'hubspot_owner_id'])) {
    const p = c.properties; const { data: l } = await admin.from('sales_leads').select('id, domain').eq('hs_company_id', String(c.id)).maybeSingle(); if (!l) continue;
    const fields: any = { company: p.name || undefined, phone: p.phone || undefined, city: p.city || undefined, state: p.state || undefined, hs_pulled_at: new Date().toISOString() }; if (p.domain && !l.domain) fields.domain = p.domain.toLowerCase();
    Object.keys(fields).forEach((k) => fields[k] === undefined && delete fields[k]); await admin.from('sales_leads').update(fields).eq('id', l.id); out.companies++;
  }
  // deals: stage + amount + owner
  for (const d of await search('deals', ['dealstage', 'pipeline', 'amount', 'hubspot_owner_id', 'shipbay_account_id', 'closedate'])) {
    const p = d.properties; if (p.pipeline !== cfg.pipeline_id) continue;
    let { data: l } = await admin.from('sales_leads').select('id, stage, deal_value, org_id').eq('hs_deal_id', String(d.id)).maybeSingle();
    if (!l && p.shipbay_account_id) ({ data: l } = await admin.from('sales_leads').select('id, stage, deal_value, org_id').eq('id', p.shipbay_account_id).maybeSingle()); if (!l) continue;
    const stage = cfg.stage_keys?.[p.dealstage]; const fields: any = { hs_deal_id: String(d.id), hs_pulled_at: new Date().toISOString() };
    if (p.amount) fields.deal_value = Math.round(Number(p.amount) / 12);
    if (p.hubspot_owner_id && cfg.owner_users?.[p.hubspot_owner_id]) fields.assigned_to = cfg.owner_users[p.hubspot_owner_id];
    if (stage && stage !== l.stage) { if (stage === 'signed' && !l.org_id) { await admin.from('sales_leads').update(fields).eq('id', l.id); await admin.rpc('win_lead', { p_lead_id: l.id, p_deal_value: fields.deal_value ?? null }); out.deals++; continue; } fields.stage = stage; if (stage === 'signed') fields.won_at = p.closedate || new Date().toISOString(); fields.last_touch_at = new Date().toISOString(); }
    await admin.from('sales_leads').update(fields).eq('id', l.id); out.deals++;
  }
  // engagements created in HubSpot (notes, calls, meetings, logged emails) → portal timeline
  const leadByContact = async (ids: string[]) => { for (const id of ids) { const { data } = await admin.from('sales_leads').select('id').eq('hs_contact_id', id).maybeSingle(); if (data) return data.id; } return null; };
  const withAssoc = async (obj: string, id: string) => (await hs(`/crm/v3/objects/${obj}/${id}?associations=contacts&properties=hs_body_preview`)).associations?.contacts?.results?.map((r: any) => String(r.id)) || [];
  for (const n of await search('notes', ['hs_note_body', 'hs_timestamp', 'hubspot_owner_id', 'hs_created_by_user_id'])) {
    const { data: dup } = await admin.from('sales_touches').select('id').eq('hs_id', String(n.id)).maybeSingle(); if (dup) continue;
    const leadId = await leadByContact(await withAssoc('notes', n.id)); if (!leadId) continue;
    await admin.from('sales_touches').insert({ lead_id: leadId, kind: 'note', note: String(n.properties.hs_note_body || '').replace(/<[^>]+>/g, '').slice(0, 4000), at: n.properties.hs_timestamp, by_user: cfg.owner_users?.[n.properties.hubspot_owner_id] || null, hs_id: String(n.id) }); out.activities++;
  }
  for (const c of await search('calls', ['hs_call_title', 'hs_call_body', 'hs_call_duration', 'hs_call_disposition', 'hs_timestamp', 'hubspot_owner_id'])) {
    const { data: dup } = await admin.from('sales_calls').select('id').eq('hs_id', String(c.id)).maybeSingle(); if (dup) continue;
    const leadId = await leadByContact(await withAssoc('calls', c.id)); if (!leadId) continue;
    if (!hsDispositions) { const m: Record<string, string> = {}; try { for (const d of await hs('/calling/v1/dispositions')) m[d.id] = d.label; } catch { /* optional */ } hsDispositions = m; }
    const label = (hsDispositions as Record<string, string>)[c.properties.hs_call_disposition] || ''; const outcome = /voicemail/i.test(label) ? 'voicemail' : /no answer/i.test(label) ? 'no_answer' : /wrong/i.test(label) ? 'wrong_number' : /busy/i.test(label) ? 'busy' : /live message/i.test(label) ? 'gatekeeper' : 'connected';
    await admin.from('sales_calls').insert({ lead_id: leadId, started_at: c.properties.hs_timestamp, seconds: Math.round(Number(c.properties.hs_call_duration || 0) / 1000), outcome, note: [c.properties.hs_call_title, String(c.properties.hs_call_body || '').replace(/<[^>]+>/g, '')].filter(Boolean).join(' — ').slice(0, 2000), by_user: cfg.owner_users?.[c.properties.hubspot_owner_id] || null, hs_id: String(c.id) }); 
    await admin.from('sales_leads').update({ last_touch_at: c.properties.hs_timestamp, last_outcome: outcome }).eq('id', leadId); out.activities++;
  }
  for (const m of await search('meetings', ['hs_meeting_title', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_body', 'hs_meeting_outcome', 'hubspot_owner_id'])) {
    const { data: dup } = await admin.from('sales_meetings').select('id').eq('hs_id', String(m.id)).maybeSingle(); if (dup) continue;
    const leadId = await leadByContact(await withAssoc('meetings', m.id)); if (!leadId || !m.properties.hs_meeting_start_time) continue;
    const { data: l } = await admin.from('sales_leads').select('contact_name, email, assigned_to').eq('id', leadId).maybeSingle();
    await admin.from('sales_meetings').insert({ external_id: `hs:${m.id}`, source: 'hubspot', name: m.properties.hs_meeting_title || 'Meeting', starts_at: m.properties.hs_meeting_start_time, ends_at: m.properties.hs_meeting_end_time || null, status: m.properties.hs_meeting_outcome === 'CANCELED' ? 'canceled' : 'active', invitee_name: l?.contact_name || null, invitee_email: l?.email || null, lead_id: leadId, assigned_to: cfg.owner_users?.[m.properties.hubspot_owner_id] || l?.assigned_to || null, notes: String(m.properties.hs_meeting_body || '').replace(/<[^>]+>/g, '').slice(0, 2000) || null, hs_id: String(m.id) }); out.activities++;
  }
  for (const e of await search('emails', ['hs_email_subject', 'hs_email_text', 'hs_email_direction', 'hs_timestamp', 'hubspot_owner_id'])) {
    const { data: dup1 } = await admin.from('gmail_messages').select('id').eq('hs_id', String(e.id)).maybeSingle(); if (dup1) continue;
    const { data: dup2 } = await admin.from('sales_touches').select('id').eq('hs_id', String(e.id)).maybeSingle(); if (dup2) continue;
    const leadId = await leadByContact(await withAssoc('emails', e.id)); if (!leadId) continue;
    const p = e.properties; const incoming = p.hs_email_direction === 'INCOMING_EMAIL';
    await admin.from('sales_touches').insert({ lead_id: leadId, kind: incoming ? 'note' : 'email_sent', note: `${incoming ? 'Email received' : 'Email'} (HubSpot): ${p.hs_email_subject || ''}\n${String(p.hs_email_text || '').slice(0, 2000)}`.trim(), at: p.hs_timestamp, by_user: cfg.owner_users?.[p.hubspot_owner_id] || null, hs_id: String(e.id) }); out.activities++;
  }
  if (!cut) cfg.last_pull = new Date().toISOString(); await saveHsCfg(cfg); return { ...out, partial: cut };
}
/** the whole round trip: pull HubSpot's changes, then push the portal's */
/** each run works inside a time budget; whatever is left waits for the next tick (every 5 min) or the next click */
const SYNC_BUDGET_MS = 110000;
async function hubspotSync(full = false) {
  const cfg = await hsCfg(); if (!cfg.pipeline_id) throw new Error('Run HubSpot set-up first (Admin → Connections).');
  const t0 = Date.now(); const left = () => SYNC_BUDGET_MS - (Date.now() - t0);
  if (full) { await admin.from('sales_leads').update({ hs_synced_at: null }).not('hs_synced_at', 'is', null); cfg.last_pull = null; }
  const pulled = await hsPull(cfg, left);
  const since = cfg.last_push || null;
  const { data: leads } = await admin.rpc('hs_push_queue', { p_limit: 400 }); let pushed = 0, acts = 0; const errors: string[] = [];
  for (const l of leads || []) {
    if (left() < 6000) break;
    try { const l2 = await hsPushLead(l, cfg); acts += await hsPushActivity(l2, cfg, since); pushed++; }
    catch (e) { errors.push(`${l.company || l.email}: ${String((e as Error).message).slice(0, 140)}`); await admin.from('sales_leads').update({ hs_synced_at: new Date().toISOString(), hs_error: String((e as Error).message).slice(0, 300) }).eq('id', l.id).then(() => {}, () => {}); if (errors.length > 8) break; }
  }
  const { data: pending } = await admin.rpc('hs_push_pending');
  cfg.last_push = new Date().toISOString(); cfg.last_sync = cfg.last_push; cfg.last_result = { pulled, pushed, acts, pending: pending ?? 0, errors: errors.slice(0, 5) }; await saveHsCfg(cfg);
  return { ok: true, pulled, pushed, activities: acts, pending: pending ?? 0, errors };
}

// ---------- Calendly ----------
async function calendlySync(uid: string) {
  const tok = await secret('CALENDLY_TOKEN'); if (!tok) return { error: 'Paste a Calendly personal access token under Settings first.' };
  const H = { Authorization: `Bearer ${tok}` };
  const me = await (await fetch('https://api.calendly.com/users/me', { headers: H })).json();
  const org = me?.resource?.current_organization; const user = me?.resource?.uri; if (!user) return { error: `Calendly token rejected: ${JSON.stringify(me).slice(0, 160)}` };
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const events: any[] = [];
  for (const status of ['active', 'canceled']) {
    let url: string | null = `https://api.calendly.com/scheduled_events?${new URLSearchParams({ organization: org, min_start_time: since, status, count: '100', sort: 'start_time:asc' })}`;
    for (let n = 0; url && n < 10; n++) { const j = await (await fetch(url, { headers: H })).json(); events.push(...(j.collection || [])); url = j.pagination?.next_page || null; }
  }
  let n = 0;
  for (const ev of events) {
    const uuid = String(ev.uri).split('/').pop();
    const inv = await (await fetch(`https://api.calendly.com/scheduled_events/${uuid}/invitees?count=5`, { headers: H })).json().catch(() => ({}));
    const first = (inv.collection || [])[0] || {};
    const email = String(first.email || '').toLowerCase() || null;
    let lead_id: string | null = null;
    if (email) { const { data: l } = await admin.from('sales_leads').select('id, stage').ilike('email', email).maybeSingle(); if (l) { lead_id = l.id; if (ev.status === 'active' && ['new', 'contacted', 'replied'].includes(l.stage)) await admin.from('sales_leads').update({ stage: 'call_booked', last_touch_at: new Date().toISOString() }).eq('id', l.id); } }
    const { data: ex } = await admin.from('sales_meetings').select('id, assigned_to').eq('external_id', ev.uri).maybeSingle();
    const row: any = { external_id: ev.uri, source: 'calendly', name: ev.name, starts_at: ev.start_time, ends_at: ev.end_time, status: ev.status === 'canceled' ? 'canceled' : (ex ? undefined : 'active'), invitee_name: first.name || null, invitee_email: email, location: ev.location?.join_url || ev.location?.location || ev.location?.type || null, lead_id };
    if (!ex) {
      // new booking: the lead's owner takes it; otherwise the next rep in the round-robin
      let owner: string | null = null;
      if (lead_id) { const { data: l } = await admin.from('sales_leads').select('assigned_to').eq('id', lead_id).maybeSingle(); owner = l?.assigned_to || null; }
      if (!owner) { const rr = (await getSetting('round_robin')) || { members: [], next: 0 }; const members: string[] = (rr.members || []).filter(Boolean); if (members.length) { owner = members[Number(rr.next || 0) % members.length]; await setSetting('round_robin', { ...rr, members, next: (Number(rr.next || 0) + 1) % members.length }); } }
      row.assigned_to = owner || uid;
      if (lead_id && owner) await admin.from('sales_leads').update({ assigned_to: owner }).eq('id', lead_id).is('assigned_to', null);
    }
    Object.keys(row).forEach((k) => row[k] === undefined && delete row[k]);
    await admin.from('sales_meetings').upsert(row, { onConflict: 'external_id' }); n++;
  }
  await setSetting('calendly_last_sync', { at: new Date().toISOString(), events: n });
  return { ok: true, events: n };
}

// QuickBooks TransactionList → fin_transactions (source 'qbo'). Invoices/sales receipts = money in; expenses/checks/bills/card charges = money out.
// Payments, bill payments, transfers, deposits and journal entries are skipped (they move money, they don't earn or spend it).
const QBO_IN = new Set(['Invoice', 'Sales Receipt']);
const QBO_OUT = new Set(['Expense', 'Check', 'Bill', 'Credit Card Expense', 'Cash Expense', 'Purchase', 'Credit Card Charge']);
const QBO_REFUND = new Set(['Refund Receipt', 'Credit Memo']);
async function qboToLedger(rep: any) {
  const cols: string[] = (rep?.Columns?.Column || []).map((c: any) => c.ColType || c.ColTitle);
  const ix = (n: string) => cols.findIndex((c) => c === n);
  const [iDate, iType, iDoc, iName, iMemo, iAcct, iOther, iAmt] = ['tx_date', 'txn_type', 'doc_num', 'name', 'memo', 'account_name', 'other_account', 'subt_nat_amount'].map(ix);
  const out: any[] = [];
  const walk = (rows: any[]) => { for (const r of rows || []) { if (r.ColData) out.push(r.ColData); if (r.Rows?.Row) walk(r.Rows.Row); } };
  walk(rep?.Rows?.Row);
  const txns: any[] = [];
  for (const c of out) {
    const v = (i: number) => (i >= 0 ? String(c[i]?.value ?? '') : '');
    const type = v(iType); const amt = Math.abs(Number(v(iAmt)) || 0); if (!amt) continue;
    let kind: string; let category = v(iOther) && v(iOther) !== '-Split-' ? v(iOther) : v(iAcct);
    if (QBO_IN.has(type)) { kind = 'revenue'; if (!category || category === v(iAcct)) category = 'Services revenue'; }
    else if (QBO_OUT.has(type)) kind = 'expense';
    else if (QBO_REFUND.has(type)) { kind = 'expense'; category = 'Refunds'; }
    else continue;
    const id = c[iDate]?.id || c[iDoc]?.id || c[iName]?.id || `${v(iDate)}|${type}|${v(iDoc)}|${v(iName)}|${amt}`;
    txns.push({ txn_date: v(iDate), kind, category: category || 'Other', counterparty: v(iName) || null, description: [v(iMemo), v(iDoc) ? `#${v(iDoc)}` : ''].filter(Boolean).join(' ') || type, amount: amt, paid: true, source: 'qbo', external_id: `qbo:${type}:${id}`, account: v(iAcct) || null, txn_type: type });
  }
  for (let i = 0; i < txns.length; i += 200) await admin.from('fin_transactions').upsert(txns.slice(i, i + 200), { onConflict: 'external_id', ignoreDuplicates: false });
  return txns.length;
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

  // ----- Google OAuth return leg (no JWT) -----
  if (req.method === 'GET' && u.pathname.endsWith('/google-callback')) {
    const q = u.searchParams; const back = (ok: boolean, msg: string) => Response.redirect(`${DASH}#sales=gmail|${ok ? 'ok' : 'error'}|${encodeURIComponent(msg)}`, 302);
    const st = await getSetting(`google_state:${q.get('state')}`);
    if (!st || Date.now() - new Date(st.at).getTime() > 15 * 60 * 1000) return back(false, 'That connect link expired — start again from Sales → Settings.');
    if (q.get('error')) return back(false, q.get('error') || 'Google declined');
    const [id, sec] = [await secret('GOOGLE_CLIENT_ID'), await secret('GOOGLE_CLIENT_SECRET')];
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: q.get('code') || '', client_id: id, client_secret: sec, redirect_uri: GOOGLE_REDIRECT, grant_type: 'authorization_code' }) });
    const j = await r.json(); if (!r.ok || !j.access_token) return back(false, `Token exchange failed: ${JSON.stringify(j).slice(0, 160)}`);
    const info = await (await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${j.access_token}` } })).json().catch(() => ({}));
    const { data: prev } = await admin.from('gmail_accounts').select('refresh_token').eq('user_id', st.uid).maybeSingle();
    await admin.from('gmail_accounts').upsert({ user_id: st.uid, email: info.email || null, access_token: j.access_token, refresh_token: j.refresh_token || prev?.refresh_token || null, expires_at: new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString(), connected_at: new Date().toISOString(), last_error: null, scopes: j.scope || null }, { onConflict: 'user_id' });
    await setSetting(`google_state:${q.get('state')}`, null);
    return back(true, info.email ? `Gmail connected: ${info.email}` : 'Gmail connected');
  }

  // ----- scheduled runs (pg_cron → pg_net) and one-off system calls: x-cron-key instead of a user -----
  const cronKey = req.headers.get('x-cron-key');
  if (cronKey) {
    const want = await secret('CRON_KEY'); if (!want || cronKey !== want) return json({ error: 'bad cron key' }, 403);
    const sb = await req.json().catch(() => ({}));
    try {
      if (sb.action === 'hubspot_setup') return json({ ok: true, hubspot: await hubspotSetup() });
      if (sb.action === 'hubspot_sync') return json(await hubspotSync(!!sb.full));
      if (sb.action === 'gmail_sync') return json(await gmailSync('', true));
      if (sb.action === 'smartlead_sync') { const { data: owner } = await admin.from('profiles').select('id').eq('is_owner', true).limit(1).maybeSingle(); return json(await smartleadSync(owner?.id || '')); }
      if (sb.action === 'calendly_sync') { const { data: owner } = await admin.from('profiles').select('id').eq('is_owner', true).limit(1).maybeSingle(); return json(await calendlySync(owner?.id || '')); }
      if (sb.action === 'tick') {
        // one scheduled pass: everything that can move, each guarded so one failure doesn't stop the rest
        const out: Record<string, unknown> = {};
        for (const [k, fn] of [['hubspot', () => hubspotSync(false)], ['gmail', () => gmailSync('', true)]] as [string, () => Promise<unknown>][]) { try { out[k] = await fn(); } catch (e) { out[k] = { error: String((e as Error).message).slice(0, 200) }; } }
        return json({ ok: true, ...out });
      }
      return json({ error: 'unknown system action' }, 400);
    } catch (e) { return json({ error: String((e as Error).message) }, 500); }
  }

  // ----- everything else: signed-in owner -----
  const auth = req.headers.get('Authorization') ?? '';
  const userClient = createClient(SB_URL, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: { user: me } } = await userClient.auth.getUser();
  if (!me) return json({ error: 'not signed in' }, 401);
  const { data: prof } = await admin.from('profiles').select('is_owner, is_sales, role').eq('id', me.id).single();
  const b = await req.json().catch(() => ({}));
  const REP_ACTIONS = new Set(['smartlead_stop_lead', 'gmail_connect', 'gmail_sync', 'gmail_disconnect', 'gmail_send', 'hubspot_sync', 'hubspot_push_one', 'hubspot_links']);   // sales reps may do these without the owner passphrase
  const gmailConnect = async () => { const id = await secret('GOOGLE_CLIENT_ID'); if (!id) return json({ error: 'Google app keys are missing.' }, 400); const state = crypto.randomUUID(); await setSetting(`google_state:${state}`, { uid: me.id, at: new Date().toISOString() }); return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: id, redirect_uri: GOOGLE_REDIRECT, response_type: 'code', scope: GOOGLE_SCOPES, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state })}` }); };
  const repAction = async () => {
    if (b.action === 'smartlead_stop_lead') return json(await smartleadStopLead(String(b.email || '')));
    if (b.action === 'gmail_connect') return gmailConnect();
    if (b.action === 'gmail_sync') return json(await gmailSync(me.id, !!prof?.is_owner && !!b.all));
    if (b.action === 'gmail_disconnect') { await admin.from('gmail_accounts').delete().eq('user_id', me.id); return json({ ok: true }); }
    if (b.action === 'gmail_send') return json(await gmailSend(me.id, b));
    if (b.action === 'hubspot_links') { const c = await hsCfg(); return json({ portal_id: c.portal_id || null, pipeline_id: c.pipeline_id || null, setup: !!c.pipeline_id, last_sync: c.last_sync || null, last_result: c.last_result || null }); }
    if (b.action === 'hubspot_sync') { try { return json(await hubspotSync(false)); } catch (e) { return json({ error: String((e as Error).message) }, 500); } }
    if (b.action === 'hubspot_push_one') { try { const cfg = await hsCfg(); const { data: l } = await admin.from('sales_leads').select('*').eq('id', String(b.lead_id)).single(); const l2 = await hsPushLead(l, cfg); await hsPushActivity(l2, cfg, null); return json({ ok: true, hs_contact_id: l2.hs_contact_id, hs_deal_id: l2.hs_deal_id, hs_company_id: l2.hs_company_id }); } catch (e) { return json({ error: String((e as Error).message) }, 500); } }
    return null;
  };
  if (!prof?.is_owner) {
    if (prof?.is_sales && REP_ACTIONS.has(b.action)) { try { const r = await repAction(); if (r) return r; } catch (e) { return json({ error: String(e) }, 500); } }
    return json({ error: 'This area is for the owner only.' }, 403);
  }
  if (REP_ACTIONS.has(b.action) && b.action !== 'smartlead_stop_lead') { try { const r = await repAction(); if (r) return r; } catch (e) { return json({ error: String(e) }, 500); } }
  const stored = await secret('OWNER_PASSPHRASE');
  const unlocked = await tokenOk(me.id, req.headers.get('x-owner-token'));

  if (b.action === 'status') {
    const { data: qbo } = await admin.from('fin_qbo_status').select('*').eq('id', 1).maybeSingle();
    return json({ passphrase_set: !!stored, unlocked, qbo, smartlead_key_set: !!(await secret('SMARTLEAD_API_KEY')), smartlead_campaigns: await secret('SMARTLEAD_CAMPAIGNS'), qbo_keys_set: !!(await secret('QBO_CLIENT_ID')) && !!(await secret('QBO_CLIENT_SECRET')), smartlead_last_sync: await getSetting('smartlead_last_sync'), calendly_set: !!(await secret('CALENDLY_TOKEN')), calendly_last_sync: await getSetting('calendly_last_sync'), gcal_set: !!(await secret('GCAL_ICS_URL')), gcal_last_sync: await getSetting('gcal_last_sync'), google_keys_set: !!(await secret('GOOGLE_CLIENT_ID')) && !!(await secret('GOOGLE_CLIENT_SECRET')), hubspot: { token_set: !!(await secret('HUBSPOT_TOKEN')), ...(await hsCfg()) } });
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
  if (b.action === 'smartlead_campaign') { try { return json(await smartleadCampaignStatus()); } catch (e) { return json({ error: String(e) }, 500); } }
  if (b.action === 'smartlead_status') { try { return json(await smartleadSetStatus(String(b.campaign_id || ''), String(b.status || ''))); } catch (e) { return json({ error: String(e) }, 500); } }
  if (b.action === 'smartlead_stop_lead') { try { return json(await smartleadStopLead(String(b.email || ''))); } catch (e) { return json({ error: String(e) }, 500); } }
  if (b.action === 'smartlead_add_leads') { try { return json(await smartleadAddLeads(Array.isArray(b.lead_ids) ? b.lead_ids : [], b.campaign_id)); } catch (e) { return json({ error: String(e) }, 500); } }
  if (b.action === 'smartlead_schedule') { try { return json(await smartleadSchedule(String(b.campaign_id || ''), !!b.weekends)); } catch (e) { return json({ error: String(e) }, 500); } }
  if (b.action === 'hubspot_setup') { try { return json({ ok: true, hubspot: await hubspotSetup() }); } catch (e) { return json({ error: String((e as Error).message) }, 500); } }
  if (b.action === 'hubspot_sync') { try { return json(await hubspotSync(!!b.full)); } catch (e) { return json({ error: String((e as Error).message) }, 500); } }
  if (b.action === 'hubspot_push_one') { try { const cfg = await hsCfg(); const { data: l } = await admin.from('sales_leads').select('*').eq('id', String(b.lead_id)).single(); const l2 = await hsPushLead(l, cfg); await hsPushActivity(l2, cfg, null); return json({ ok: true, hs_contact_id: l2.hs_contact_id, hs_deal_id: l2.hs_deal_id, hs_company_id: l2.hs_company_id }); } catch (e) { return json({ error: String((e as Error).message) }, 500); } }
  if (b.action === 'gcal_sync') { try { return json(await gcalSync(me.id)); } catch (e) { return json({ error: String(e) }, 500); } }
  if (b.action === 'calendly_sync') { try { return json(await calendlySync(me.id)); } catch (e) { return json({ error: String(e) }, 500); } }

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
      const since = new Date(y, 0, 1);
      const tl = await qboGet(tok, `/reports/TransactionList?start_date=${ymd(since)}&end_date=${ymd(now)}&columns=tx_date,txn_type,doc_num,name,memo,account_name,other_account,subt_nat_amount`);
      const imported = await qboToLedger(tl);
      const ar = await qboGet(tok, `/reports/AgedReceivables?report_date=${ymd(now)}`).catch(() => null);
      const rows = [
        { report: 'ProfitAndLoss', period_start: `${y}-01-01`, period_end: ymd(now), data: pl },
        { report: 'BalanceSheet', period_start: ymd(now), period_end: ymd(now), data: bs },
        { report: 'TransactionList', period_start: ymd(since), period_end: ymd(now), data: tl },
      ];
      if (ar) rows.push({ report: 'AgedReceivables', period_start: ymd(now), period_end: ymd(now), data: ar });
      await admin.from('fin_qbo_reports').insert(rows);
      await admin.from('fin_qbo_status').update({ last_sync_at: new Date().toISOString(), last_error: null }).eq('id', 1);
      return json({ ok: true, reports: rows.map((r) => r.report), imported });
    } catch (e) { await admin.from('fin_qbo_status').update({ last_error: String(e).slice(0, 300) }).eq('id', 1); return json({ error: String(e) }, 500); }
  }
  return json({ error: 'unknown action' }, 400);
});
