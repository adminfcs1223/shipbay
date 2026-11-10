// appt — appointments are booked in Calendly (Derek, 2026-11-10). The portal embeds the closer's Calendly page; this function
// is the server side of that: it tells the portal which Calendly link to show, reads a finished booking back from Calendly
// (never trusting what the browser says about it) and records it, and cancels through Calendly.
//   { action: 'calendly_link', closer_id? }                               → { url, whose, own }
//   { action: 'calendly_booked', lead_id, closer_id?, event_uri, invitee_uri?, note? } → { meeting, host_name, setter_calendar, join_url }
//   { action: 'calendly_find', lead_id, closer_id?, email, note? }          → same; finds the booking by the invitee's email (when the embed's signal was missed)
//   { action: 'cancel', meeting_id, reason? }                               → cancels in Calendly (it tells the prospect and the host), then in the portal
// The setter is passed to Calendly as a guest so the call is on both calendars. If the Calendly event type does not allow
// guests, the setter gets a calendar invite by email from here instead (same time, same join link).
// Caller must be on the sales team. Deploy: supabase functions deploy appt
import { createClient } from 'npm:@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const admin = createClient(SB_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info' };
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: cors });
const API = 'https://api.calendly.com';
const EVENT_RE = /^https:\/\/(?:api\.)?calendly\.com\/(?:api\/v2\/)?scheduled_events\/([A-Za-z0-9-]+)(?:\/invitees\/([A-Za-z0-9-]+))?$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function secret(key: string) { const { data } = await admin.from('platform_secrets').select('value').eq('key', key).maybeSingle(); return data?.value || Deno.env.get(key) || ''; }
async function cal(path: string, tok: string, init: RequestInit = {}) {
  const r = await fetch(API + path, { ...init, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const j: any = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}

/* ---------- a calendar invite for the setter when Calendly did not add them as a guest ---------- */
const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const icsText = (s: string) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
const fold = (line: string) => { const out: string[] = []; let cur = ''; let n = 0; const enc = new TextEncoder(); for (const ch of line) { const w = enc.encode(ch).length; if (n + w > 73) { out.push(cur); cur = ' ' + ch; n = 1 + w; } else { cur += ch; n += w; } } out.push(cur); return out.join('\r\n'); };
const b64 = (s: string) => { const bytes = new TextEncoder().encode(s); let bin = ''; for (const x of bytes) bin += String.fromCharCode(x); return btoa(bin); };
async function mailSetterInvite(o: { uid: string; to: string; toName: string; start: Date; end: Date; summary: string; where: string; hostName: string; hostEmail: string; details: string }) {
  const key = await secret('RESEND_API_KEY'); if (!key) return 'No Resend API key on the server.';
  const ics = ['BEGIN:VCALENDAR', 'PRODID:-//ShipBay 3PL//Portal//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'METHOD:REQUEST', 'BEGIN:VEVENT', `UID:${o.uid}-setter@shipbay3pl.com`, `SEQUENCE:${Math.floor(Date.now() / 1000) - 1750000000}`,
    `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(o.start)}`, `DTEND:${icsDate(o.end)}`, `SUMMARY:${icsText(o.summary)}`, `DESCRIPTION:${icsText(o.details)}`, ...(o.where ? [`LOCATION:${icsText(o.where)}`] : []),
    `ORGANIZER;CN=${icsText(o.hostName)}:mailto:${o.hostEmail}`, `ATTENDEE;CN=${icsText(o.toName || o.to)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:${o.to}`, 'STATUS:CONFIRMED', 'TRANSP:OPAQUE', 'END:VEVENT', 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n';
  const when = `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric' }).format(o.start)} at ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(o.start)}`;
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({
    from: 'ShipBay portal <derekh@shipbay3pl.com>', to: [o.to], subject: `You are on this call: ${o.summary} · ${when}`,
    text: `${o.summary}\n${when}\n${o.where ? `Join: ${o.where}\n` : ''}\n${o.details}\n\nCalendly did not add you as a guest on this booking, so this invite comes from the portal. Open the attachment to put it on your calendar.`,
    attachments: [{ filename: 'invite.ics', content: b64(ics), content_type: 'text/calendar; charset=utf-8; method=REQUEST' }] }) });
  return r.ok ? null : `Resend ${r.status}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const auth = req.headers.get('Authorization') ?? '';
  const userClient = createClient(SB_URL, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'not signed in' }, 401);
  const { data: me } = await admin.from('profiles').select('id, full_name, email, role, is_owner, is_sales, active, closer_id').eq('id', user.id).maybeSingle();
  if (!me || me.active === false || !(me.is_owner || me.is_sales || me.role === 'shipbay_setter')) return json({ error: 'Sales team only.' }, 403);
  const b = await req.json().catch(() => ({}));
  const tok = await secret('CALENDLY_TOKEN');
  if (!tok) return json({ error: 'Calendly is not connected. Paste the Calendly token under Admin → Connections & keys.' }, 400);

  /* ----- which Calendly page to show ----- */
  if (b.action === 'calendly_link') {
    const closerId = String(b.closer_id || (me.role === 'shipbay_setter' ? me.closer_id || '' : me.id));
    if (closerId) {
      const { data: av } = await admin.from('sales_availability').select('calendly_url').eq('user_id', closerId).maybeSingle();
      const { data: c } = await admin.from('profiles').select('full_name, email').eq('id', closerId).maybeSingle();
      if (av?.calendly_url) return json({ url: av.calendly_url, whose: c?.full_name || c?.email || 'the closer', own: true });
    }
    const { data: bl } = await admin.from('fin_settings').select('value').eq('key', 'booking_link').maybeSingle();
    if (bl?.value?.url) return json({ url: bl.value.url, whose: 'the team link', own: false });
    const u = await cal('/users/me', tok); if (!u.ok) return json({ error: `Calendly rejected the token (${u.status}).` }, 502);
    const et = await cal(`/event_types?active=true&count=20&user=${encodeURIComponent(u.j.resource.uri)}`, tok);
    const pick = (et.j.collection || []).find((e: any) => e.active && !e.secret && e.scheduling_url);
    if (!pick) return json({ error: 'The Calendly account has no active event type to book on.' }, 400);
    return json({ url: pick.scheduling_url, whose: u.j.resource.name || 'the team', own: false, event_name: pick.name, minutes: pick.duration });
  }

  /* ----- read a booking back from Calendly and record it ----- */
  const record = async (eventUuid: string, inviteeUuid: string | null) => {
    const ev = await cal(`/scheduled_events/${eventUuid}`, tok);
    if (!ev.ok) return json({ error: ev.status === 403 || ev.status === 404 ? 'That booking is not in ShipBay’s Calendly account, so the portal cannot read it. The closer’s link has to belong to the connected Calendly team.' : `Calendly did not return the booking (${ev.status}).` }, 502);
    const e = ev.j.resource;
    if (e.status !== 'active') return json({ error: 'That Calendly booking is canceled.' }, 400);
    if (Date.now() - new Date(e.created_at).getTime() > 6 * 3600000) return json({ error: 'That booking was made hours ago. It comes in with the Calendly sync; it cannot be claimed here.' }, 400);
    const inv = inviteeUuid ? await cal(`/scheduled_events/${eventUuid}/invitees/${inviteeUuid}`, tok) : await cal(`/scheduled_events/${eventUuid}/invitees?count=1`, tok);
    const i = inviteeUuid ? inv.j.resource : (inv.j.collection || [])[0]; if (!i) return json({ error: 'Calendly returned no invitee for that booking.' }, 502);
    const tagged = i.tracking?.utm_content || null;
    if (tagged && tagged !== String(b.lead_id)) return json({ error: 'That Calendly booking was made for a different lead.' }, 400);
    const host = (e.event_memberships || [])[0] || {};
    const where = e.location?.join_url || e.location?.location || '';
    const p = { lead_id: b.lead_id, closer_id: b.closer_id || '', event_uri: `${API}/scheduled_events/${eventUuid}`, name: e.name, starts_at: e.start_time, ends_at: e.end_time, location: where || e.location?.type || '',
      invitee_name: i.name || '', invitee_email: i.email || '', host_email: host.user_email || '', reschedule_url: i.reschedule_url || '', cancel_url: i.cancel_url || '', note: String(b.note || '').slice(0, 1000) };
    const { data: meeting, error } = await admin.rpc('_record_calendly_booking', { p_uid: me.id, p });
    if (error) return json({ error: error.message }, 400);
    // both the setter and the closer are in the call: is the setter on the Calendly event?
    const myEmail = String(me.email || '').toLowerCase(); const guests = (e.event_guests || []).map((g: any) => String(g.email || '').toLowerCase());
    const amHost = String(host.user_email || '').toLowerCase() === myEmail;
    let setter_calendar = amHost ? 'host' : guests.includes(myEmail) ? 'calendly' : 'none'; let setter_note: string | null = null;
    if (setter_calendar === 'none' && EMAIL.test(myEmail)) {
      const err = await mailSetterInvite({ uid: eventUuid, to: myEmail, toName: me.full_name || '', start: new Date(e.start_time), end: new Date(e.end_time), summary: `${meeting?.company || i.name || 'Prospect'} · ${e.name}`, where,
        hostName: host.user_name || 'ShipBay', hostEmail: host.user_email || 'derekh@shipbay3pl.com', details: [`With ${host.user_name || 'the closer'} and ${i.name || i.email}`, i.email && `Prospect: ${i.email}`, p.note].filter(Boolean).join('\n') });
      setter_calendar = err ? 'failed' : 'email'; setter_note = err;
    }
    return json({ ok: true, meeting, host_name: host.user_name || null, host_email: host.user_email || null, setter_calendar, setter_note, join_url: where || null });
  };

  if (b.action === 'calendly_booked') {
    const m = EVENT_RE.exec(String(b.event_uri || '')); const mi = EVENT_RE.exec(String(b.invitee_uri || ''));
    if (!m || !b.lead_id) return json({ error: 'Calendly did not say which booking was made.' }, 400);
    return record(m[1], mi && mi[1] === m[1] && mi[2] ? mi[2] : null);
  }
  if (b.action === 'calendly_find') {
    const email = String(b.email || '').trim().toLowerCase(); if (!EMAIL.test(email) || !b.lead_id) return json({ error: 'Type the email the booking was made with.' }, 400);
    const u = await cal('/users/me', tok); if (!u.ok) return json({ error: `Calendly rejected the token (${u.status}).` }, 502);
    const list = await cal(`/scheduled_events?${new URLSearchParams({ organization: u.j.resource.current_organization, invitee_email: email, status: 'active', min_start_time: new Date().toISOString(), sort: 'start_time:asc', count: '20' })}`, tok);
    if (!list.ok) return json({ error: `Calendly search failed (${list.status}).` }, 502);
    const recent = (list.j.collection || []).filter((e: any) => Date.now() - new Date(e.created_at).getTime() < 6 * 3600000).sort((a: any, c: any) => String(c.created_at).localeCompare(String(a.created_at)))[0];
    if (!recent) return json({ error: `No Calendly booking made in the last few hours for ${email}.` }, 404);
    return record(String(recent.uri).split('/').pop()!, null);
  }

  /* ----- cancel: Calendly first (it tells the prospect and the host), then the portal ----- */
  if (b.action === 'cancel') {
    const { data: m } = await admin.from('sales_meetings').select('id, external_id, source, status, assigned_to, booked_by').eq('id', String(b.meeting_id || '')).maybeSingle();
    if (!m) return json({ error: 'That call is not on the calendar.' }, 404);
    if (!(me.is_owner || m.assigned_to === me.id || m.booked_by === me.id)) return json({ error: 'Only whoever booked the call or takes it can cancel it.' }, 403);
    const x = EVENT_RE.exec(String(m.external_id || ''));
    if (x && m.status !== 'canceled') {
      const c = await cal(`/scheduled_events/${x[1]}/cancellation`, tok, { method: 'POST', body: JSON.stringify({ reason: String(b.reason || 'Canceled by ShipBay').slice(0, 500) }) });
      if (!c.ok) { const chk = await cal(`/scheduled_events/${x[1]}`, tok); if (chk.j?.resource?.status !== 'canceled') return json({ error: `Calendly did not cancel it (${c.status}${c.j?.message ? `: ${c.j.message}` : ''}). Nothing was changed.` }, 502); }
    }
    const { error } = await userClient.rpc('cancel_meeting', { p_meeting: m.id, p_reason: b.reason || null });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true, calendly: !!x });
  }

  return json({ error: 'unknown action' }, 400);
});
