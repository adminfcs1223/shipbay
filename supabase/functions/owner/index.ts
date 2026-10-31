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
const SECRET_KEYS = new Set(['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'SMARTLEAD_API_KEY', 'SMARTLEAD_CAMPAIGNS', 'CALENDLY_TOKEN', 'GCAL_ICS_URL']);
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

  // ----- everything else: signed-in owner -----
  const auth = req.headers.get('Authorization') ?? '';
  const userClient = createClient(SB_URL, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: { user: me } } = await userClient.auth.getUser();
  if (!me) return json({ error: 'not signed in' }, 401);
  const { data: prof } = await admin.from('profiles').select('is_owner, is_sales, role').eq('id', me.id).single();
  const b = await req.json().catch(() => ({}));
  const REP_ACTIONS = new Set(['smartlead_stop_lead']);   // sales reps may do these without the owner passphrase
  if (!prof?.is_owner) {
    if (prof?.is_sales && REP_ACTIONS.has(b.action)) {
      if (b.action === 'smartlead_stop_lead') { try { return json(await smartleadStopLead(String(b.email || ''))); } catch (e) { return json({ error: String(e) }, 500); } }
    }
    return json({ error: 'This area is for the owner only.' }, 403);
  }
  const stored = await secret('OWNER_PASSPHRASE');
  const unlocked = await tokenOk(me.id, req.headers.get('x-owner-token'));

  if (b.action === 'status') {
    const { data: qbo } = await admin.from('fin_qbo_status').select('*').eq('id', 1).maybeSingle();
    return json({ passphrase_set: !!stored, unlocked, qbo, smartlead_key_set: !!(await secret('SMARTLEAD_API_KEY')), smartlead_campaigns: await secret('SMARTLEAD_CAMPAIGNS'), qbo_keys_set: !!(await secret('QBO_CLIENT_ID')) && !!(await secret('QBO_CLIENT_SECRET')), smartlead_last_sync: await getSetting('smartlead_last_sync'), calendly_set: !!(await secret('CALENDLY_TOKEN')), calendly_last_sync: await getSetting('calendly_last_sync'), gcal_set: !!(await secret('GCAL_ICS_URL')), gcal_last_sync: await getSetting('gcal_last_sync') });
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
