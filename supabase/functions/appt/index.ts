// appt — calendar invites for calls booked in the portal (Appt. Setting → Book, or "Book a call" during a dial).
//   { action: 'invite', meeting_id, dry_run? }  → emails the prospect and the closer a calendar invite (.ics, METHOD:REQUEST)
//   { action: 'cancel', meeting_id, dry_run? }  → emails both a cancellation for the same calendar entry (METHOD:CANCEL)
// The booking itself is made by the book_meeting / log_call database functions; this only sends mail and records the result
// on sales_meetings (invite_sent_at / invite_error). Caller must be the owner, the closer, or whoever booked it.
// Deploy: supabase functions deploy appt
import { createClient } from 'npm:@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const admin = createClient(SB_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info' };
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: cors });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* ---------- the .ics ---------- */
const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const icsText = (s: string) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
/** RFC 5545: lines fold at 75 octets, continuation lines start with a space */
const fold = (line: string) => { const out: string[] = []; let cur = ''; let n = 0; const enc = new TextEncoder(); for (const ch of line) { const w = enc.encode(ch).length; if (n + w > 73) { out.push(cur); cur = ' ' + ch; n = 1 + w; } else { cur += ch; n += w; } } out.push(cur); return out.join('\r\n'); };
export function buildIcs(o: { uid: string; method: 'REQUEST' | 'CANCEL'; sequence: number; start: Date; end: Date; summary: string; description: string; location: string; organizerName: string; organizerEmail: string; attendees: { name: string; email: string }[]; stamp: Date }) {
  const L = [
    'BEGIN:VCALENDAR', 'PRODID:-//ShipBay 3PL//Portal//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', `METHOD:${o.method}`,
    'BEGIN:VEVENT', `UID:${o.uid}`, `SEQUENCE:${o.sequence}`, `DTSTAMP:${icsDate(o.stamp)}`, `DTSTART:${icsDate(o.start)}`, `DTEND:${icsDate(o.end)}`,
    `SUMMARY:${icsText(o.summary)}`, ...(o.description ? [`DESCRIPTION:${icsText(o.description)}`] : []), ...(o.location ? [`LOCATION:${icsText(o.location)}`] : []),
    `ORGANIZER;CN=${icsText(o.organizerName)}:mailto:${o.organizerEmail}`,
    ...o.attendees.map((a) => `ATTENDEE;CN=${icsText(a.name || a.email)};ROLE=REQ-PARTICIPANT;PARTSTAT=${o.method === 'CANCEL' ? 'DECLINED' : 'NEEDS-ACTION'};RSVP=${o.method === 'CANCEL' ? 'FALSE' : 'TRUE'}:mailto:${a.email}`),
    `STATUS:${o.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`, 'TRANSP:OPAQUE',
    ...(o.method === 'REQUEST' ? ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT10M', 'END:VALARM'] : []),
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return L.map(fold).join('\r\n') + '\r\n';
}
const b64 = (s: string) => { const bytes = new TextEncoder().encode(s); let bin = ''; for (const x of bytes) bin += String.fromCharCode(x); return btoa(bin); };
const whenIn = (d: Date, tz: string) => `${new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(d)} at ${new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d)}`;
const first = (s: string | null | undefined) => String(s || '').trim().split(/\s+/)[0] || '';

async function resendKey() { const { data } = await admin.from('platform_secrets').select('value').eq('key', 'RESEND_API_KEY').maybeSingle(); return data?.value || Deno.env.get('RESEND_API_KEY') || ''; }
const shell = (inner: string) => `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0F1B2A;line-height:1.6;font-size:15px"><div style="height:4px;background:#FF6B15;border-radius:2px;margin-bottom:20px"></div>${inner}<p style="color:#5A6473;font-size:13px;margin-top:26px">ShipBay 3PL · 115 Stryker Ln, Hillsborough Township, NJ</p></div>`;
const row = (k: string, v: string) => `<tr><td style="padding:7px 12px;color:#5A6473;font-size:13px;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:7px 12px"><b>${v}</b></td></tr>`;
const table = (rows: string) => `<table style="border-collapse:collapse;background:#F7F6F3;border:1px solid #E8E6E1;border-radius:8px;margin:16px 0;width:100%">${rows}</table>`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const auth = req.headers.get('Authorization') ?? '';
  const userClient = createClient(SB_URL, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: { user: me } } = await userClient.auth.getUser();
  if (!me) return json({ error: 'not signed in' }, 401);
  const b = await req.json().catch(() => ({}));
  if (!['invite', 'cancel'].includes(b.action)) return json({ error: 'unknown action' }, 400);

  const { data: m } = await admin.from('sales_meetings').select('*').eq('id', String(b.meeting_id || '')).maybeSingle();
  if (!m) return json({ error: 'That call is not on the calendar.' }, 404);
  const { data: prof } = await admin.from('profiles').select('id, is_owner, active').eq('id', me.id).maybeSingle();
  if (!prof || prof.active === false) return json({ error: 'not allowed' }, 403);
  if (!(prof.is_owner || m.assigned_to === me.id || m.booked_by === me.id)) return json({ error: 'Only whoever booked the call or takes it can send its invite.' }, 403);
  if (m.source !== 'portal') return json({ error: 'Invites are sent for calls booked in the portal. This one came from another calendar.' }, 400);
  if (b.action === 'invite' && m.status === 'canceled') return json({ error: 'That call was canceled.' }, 400);

  const { data: closer } = await admin.from('profiles').select('id, full_name, email, phone').eq('id', m.assigned_to).maybeSingle();
  if (!closer?.email) return json({ error: 'Nobody is assigned to take this call.' }, 400);
  const { data: booker } = m.booked_by ? await admin.from('profiles').select('full_name, email').eq('id', m.booked_by).maybeSingle() : { data: null };
  const { data: lead } = m.lead_id ? await admin.from('sales_leads').select('company, domain, contact_name, email, phone, orders_month_actual, current_setup, pain, notes').eq('id', m.lead_id).maybeSingle() : { data: null };
  const { data: av } = await admin.from('sales_availability').select('tz').eq('user_id', m.assigned_to).maybeSingle();
  const tz = av?.tz || 'America/New_York';

  const start = new Date(m.starts_at); const end = new Date(m.ends_at || start.getTime() + 20 * 60000);
  const mins = Math.max(5, Math.round((end.getTime() - start.getTime()) / 60000));
  const prospectEmail = String(m.invitee_email || lead?.email || '').trim().toLowerCase();
  const prospectName = m.invitee_name || lead?.contact_name || '';
  const company = lead?.company || lead?.domain || '';
  const closerFirst = first(closer.full_name) || 'ShipBay';
  const phone = lead?.phone || '';
  const where = m.location || (phone ? `By phone: ${closerFirst} calls ${phone}` : 'By phone');
  const cancel = b.action === 'cancel';
  // every re-send must carry a higher SEQUENCE or calendars ignore it
  const sequence = Math.floor(Date.now() / 1000) - 1750000000;
  const own = /@shipbay3pl\.com$/i.test(closer.email);
  const from = `${closer.full_name || 'ShipBay'} <${own ? closer.email : 'derekh@shipbay3pl.com'}>`;
  const summaryProspect = `ShipBay call with ${closerFirst}`;
  const summaryCloser = `${company || prospectName || 'Discovery call'} · ShipBay discovery call`;
  const when = whenIn(start, tz);

  const attendees = [...(EMAIL.test(prospectEmail) ? [{ name: prospectName || prospectEmail, email: prospectEmail }] : []), { name: closer.full_name || closer.email, email: closer.email }];
  const base = { uid: `${m.id}@shipbay3pl.com`, method: (cancel ? 'CANCEL' : 'REQUEST') as 'REQUEST' | 'CANCEL', sequence, start, end, location: where, organizerName: closer.full_name || 'ShipBay', organizerEmail: own ? closer.email : 'derekh@shipbay3pl.com', attendees, stamp: new Date() };
  const closerNotes = [company && `Company: ${company}`, prospectName && `Contact: ${prospectName}`, prospectEmail && `Email: ${prospectEmail}`, phone && `Phone: ${phone}`,
    lead?.orders_month_actual != null && `Orders a month: ${lead.orders_month_actual}`, lead?.current_setup && `Ships today: ${String(lead.current_setup).replace(/_/g, ' ')}`, lead?.pain && `Pain: ${lead.pain}`,
    booker && `Booked by: ${booker.full_name || booker.email}`, m.notes && `\n${m.notes}`].filter(Boolean).join('\n');
  const icsProspect = buildIcs({ ...base, summary: summaryProspect, description: `${mins} minutes with ${closerFirst} at ShipBay 3PL. Need a different time? Reply to the invite email.` });
  // the closer's copy is organized by whoever booked it, so it arrives as an invitation and lands on their calendar
  const viaBooker = booker?.email && booker.email.toLowerCase() !== closer.email.toLowerCase();
  const icsCloser = buildIcs({ ...base, ...(viaBooker ? { organizerName: booker!.full_name || booker!.email, organizerEmail: booker!.email } : {}), summary: summaryCloser, description: closerNotes });
  const attach = (ics: string) => [{ filename: cancel ? 'canceled.ics' : 'invite.ics', content: b64(ics), content_type: `text/calendar; charset=utf-8; method=${base.method}` }];

  const mails: any[] = [];
  if (EMAIL.test(prospectEmail)) mails.push({
    from, to: [prospectEmail], reply_to: closer.email,
    subject: cancel ? `Canceled: ShipBay call on ${when}` : `ShipBay call · ${when}`,
    html: shell(cancel
      ? `<p>Hi ${esc(first(prospectName) || 'there')},</p><p>The call on <b>${esc(when)}</b> is canceled. Reply to this email and we will find another time.</p><p>${esc(closerFirst)}</p>`
      : `<p>Hi ${esc(first(prospectName) || 'there')},</p><p>You are booked with ${esc(closerFirst)} at ShipBay.</p>${table(row('When', esc(when)) + row('Length', `${mins} minutes`) + row('Where', esc(where)))}<p>The calendar invite is attached. Need a different time? Reply to this email.</p><p>${esc(closerFirst)}</p>`),
    attachments: attach(icsProspect),
  });
  mails.push({
    from: `ShipBay portal <${own ? closer.email : 'derekh@shipbay3pl.com'}>`, to: [closer.email], ...(booker?.email && booker.email !== closer.email ? { cc: [booker.email] } : {}),
    subject: cancel ? `Canceled: ${company || prospectName || 'call'} · ${when}` : `Booked: ${company || prospectName || 'call'} · ${when}`,
    html: shell(`<p>${cancel ? 'This call was canceled.' : `${esc(booker?.full_name || 'Someone')} booked a call for you.`}</p>${table(row('When', esc(when)) + row('Length', `${mins} minutes`) + row('Where', esc(where)) + (company ? row('Company', esc(company)) : '') + (prospectName ? row('Contact', esc(prospectName)) : '') + (prospectEmail ? row('Email', esc(prospectEmail)) : '') + (phone ? row('Phone', esc(phone)) : ''))}${m.notes ? `<p style="white-space:pre-wrap">${esc(m.notes)}</p>` : ''}${EMAIL.test(prospectEmail) ? '' : '<p><b>No email on file for the prospect, so they did not get an invite.</b></p>'}`),
    attachments: attach(icsCloser),
  });

  if (b.dry_run) return json({ ok: true, dry_run: true, when, where, mails: mails.map((x) => ({ from: x.from, to: x.to, cc: x.cc, subject: x.subject, html: x.html })), ics: icsProspect });

  const key = await resendKey();
  if (!key) { await admin.from('sales_meetings').update({ invite_error: 'No Resend API key on the server.' }).eq('id', m.id); return json({ error: 'No Resend API key on the server.' }, 500); }
  const errors: string[] = []; const sent: string[] = [];
  for (const mail of mails) {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(mail) });
    if (r.ok) sent.push(...mail.to); else errors.push(`${mail.to[0]}: ${(await r.json().catch(() => ({})))?.message || r.status}`);
  }
  const noProspect = !EMAIL.test(prospectEmail);
  if (!cancel) await admin.from('sales_meetings').update({ invite_sent_at: sent.includes(prospectEmail) ? new Date().toISOString() : m.invite_sent_at, invite_error: errors.length ? errors.join(' · ').slice(0, 500) : noProspect ? 'No email on file for the prospect.' : null }).eq('id', m.id);
  if (errors.length) return json({ error: `The invite did not go: ${errors.join(' · ')}`, sent }, 502);
  return json({ ok: true, sent, prospect_invited: !noProspect, when });
});
