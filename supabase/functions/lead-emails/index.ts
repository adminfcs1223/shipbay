// lead-emails — every prospect-facing email, sent from the founder via Resend.
// Three entry points, all guarded by the shared secret:
//   { record, template }  — a Postgres trigger sends the instant (T0) email for a new website lead
//   { run_due: true }     — pg_cron calls this every 30 min to send due website-lead follow-ups
//   { run_blitz: true, lead_id? } — pg_cron every 10 min (and lead-intake, per lead) sends due Blitz emails from the assigned rep
// Secrets: WEBHOOK_SECRET (env, or platform_secrets), RESEND_API_KEY (verified shipbay3pl.com domain in Resend). Optional: FOUNDER_FROM.
// Follow-ups are skipped automatically once a lead is marked won or lost in the CRM.
// Derek, 2026-11-10: all pricing in these emails is Rate Card v2 (the founding-terms Blitz offer and the old rate table are gone).
// Derek, 2026-11-10: every email is about booking the call, and every template carries the Calendly link
// (the sender's own event link, else the team link under Admin settings, else DEFAULT_BOOK).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ENV_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";
/** the shared secret: env first, else platform_secrets.WEBHOOK_SECRET (what pg_cron and lead-intake send) */
async function secretOk(got: string | null): Promise<boolean> {
  if (!got) return false;
  if (ENV_SECRET && got === ENV_SECRET) return true;
  const sb = Deno.env.get("SUPABASE_URL"), srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!sb || !srk) return false;
  const r = await fetch(`${sb}/rest/v1/platform_secrets?key=eq.WEBHOOK_SECRET&select=value`, { headers: { apikey: srk, Authorization: `Bearer ${srk}` } });
  const v = r.ok ? (await r.json())?.[0]?.value : null;
  return !!v && got === v;
}
const DEFAULT_BOOK = "https://calendly.com/derekh-shipbay3pl/30min";
const okUrl = (u: unknown): u is string => typeof u === "string" && /^https:\/\/[^\s"<>]+$/.test(u);
/** the Calendly link an email carries: the sender's own event link, else the team link, else the default */
async function bookingUrl(sb: string | undefined, rest: Record<string, string>, repId?: string): Promise<string> {
  if (!sb) return DEFAULT_BOOK;
  try {
    if (repId) {
      const a = await (await fetch(`${sb}/rest/v1/sales_availability?user_id=eq.${repId}&select=calendly_url`, { headers: rest })).json();
      if (okUrl(a?.[0]?.calendly_url)) return a[0].calendly_url;
    }
    const t = await (await fetch(`${sb}/rest/v1/fin_settings?key=eq.booking_link&select=value`, { headers: rest })).json();
    if (okUrl(t?.[0]?.value?.url)) return t[0].value.url;
  } catch (_) { /* fall through to the default */ }
  return DEFAULT_BOOK;
}
const SIG = `
  <p style="margin:26px 0 0;color:#101C2B"><b>Derek Harrison</b><br>
  <span style="color:#5A6473">Founder, shipbay</span><br>
  <span style="color:#5A6473;font-size:13px">115 Stryker Ln, Hillsborough Township, NJ · (610) 478-5432 · <a href="https://www.shipbay3pl.com" style="color:#D14E00">shipbay3pl.com</a></span></p>
  <p style="color:#8A93A3;font-size:12px;margin-top:18px">You're getting this because you reached out on shipbay3pl.com. Reply "stop" and we won't email again.</p>`;
const BTN = (href: string, label: string) =>
  `<p style="margin:22px 0"><a href="${href}" style="background:#FF6B15;color:#fff;text-decoration:none;padding:13px 24px;border-radius:9px;font-weight:bold;display:inline-block">${label}</a></p>`;

function wrap(inner: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#101C2B;line-height:1.6">
    <div style="height:5px;background:#FF6B15;border-radius:3px;margin-bottom:22px"></div>${inner}${SIG}</div>`;
}

function rateCardTable(): string {
  const row = (svc: string, rate: string, note: string) =>
    `<tr><td style="padding:8px 10px;border-top:1px solid #E8E6E1">${svc}</td><td style="padding:8px 10px;border-top:1px solid #E8E6E1;white-space:nowrap"><b>${rate}</b></td><td style="padding:8px 10px;border-top:1px solid #E8E6E1;color:#5A6473;font-size:13px">${note}</td></tr>`;
  const grp = (t: string) =>
    `<tr><td colspan="3" style="padding:7px 10px;background:#FFF0E4;color:#D14E00;font-size:11px;letter-spacing:.12em"><b>${t}</b></td></tr>`;
  // Rate Card v2 (approved 2026-11-01, claude/pricing-rate-card-v2.md). Change it there first, then here, the portal and the site together.
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">
    ${grp("PICK &amp; PACK — BY MONTHLY VOLUME")}
    ${row("Up to 1,000 orders/mo", "$1.95 / order", "+ $0.45 per additional unit")}
    ${row("1,001 – 5,000 orders/mo", "$1.80 / order", "+ $0.45 per additional unit")}
    ${row("5,001+ orders/mo", "$1.65 / order", "+ $0.45 per additional unit · 12-month term")}
    ${row("Box pack-out", "$2.50", "Box, fill, tape and labor · your own packaging: $0")}
    ${grp("RECEIVING")}
    ${row("Pallet, one SKU", "$10 / pallet", "+ $5 per additional SKU")}
    ${row("Mixed or unsorted pallet", "$60", "Up to 10 SKUs")}
    ${row("Parcel carton", "$2.50 / carton", "$10 minimum per shipment")}
    ${row("Container unload", "$350 (20′) · $500 (40′)", "Floor-loaded +$150")}
    ${grp("STORAGE — ONLY WHAT YOU USE, NO PEAK-SEASON SURCHARGE")}
    ${row("Standard pallet", "$18 / month", "40×48, up to 48″ · up to 60″ $20 · up to 72″ $24")}
    ${row("Half pallet", "$12 / month", "")}
    ${row("Shelf", "$4 / month", "")}
    ${row("Bin", "$1 / month", "")}
    ${row("Oversize", "$0.40 / cu ft", "$30 minimum")}
    ${grp("B2B, PREP &amp; PROJECTS")}
    ${row("B2B / wholesale order", "$5.50 + $0.40/unit", "Pallet build $18")}
    ${row("FBA / marketplace prep", "$0.60 / unit", "+ $2.50 per carton")}
    ${row("Return processed", "$3.00 + $0.50/unit", "")}
    ${row("Kitting / special projects", "$40 / hour", "Quoted before we start")}
    ${grp("ACCOUNT")}
    ${row("Setup / onboarding", "$0", "Shopify, WooCommerce, Amazon &amp; TikTok Shop included")}
    ${row("Monthly minimum", "None", "Storage has a $10 per account floor")}
    ${row("Shipping / postage", "Your own carrier account", "Your rates · never on our invoice")}
    ${row("Contract", "Month-to-month", "30 days' notice")}
  </table>`;
}

const ABOUT = `<p>Quick bit about us: shipbay is a DTC 3PL that runs its own warehouse in Hillsborough, NJ.
  Orders in by 2pm ET ship the same day, pricing is published and volume-tiered, there's no setup fee and no monthly minimum,
  and it's month-to-month.</p>`;

// deno-lint-ignore no-explicit-any
function render(template: string, lead: any, book: string): { subject: string; html: string } | null {
  const first = String(lead.name ?? "").trim().split(/\s+/)[0] || "there";
  const slot = String(lead.slot ?? "");
  const hasSlot = !!slot && slot !== "ASAP";
  const slotLine = hasSlot
    ? `<p><b>Your call is confirmed for ${slot} (Eastern).</b> Want it on your calendar with a meeting link, or need a different time? Pick it here:</p>`
    : `<p><b>You asked us to call as soon as possible</b> — a specialist (usually me) will ring you during business hours today or tomorrow morning. Rather pick the exact time yourself? It takes ten seconds:</p>`;
  switch (template) {
    case "call_t0": return { subject: "Your shipbay call is booked", html: wrap(
      `<p>Hi ${first},</p><p>Thanks for the interest in shipbay — I saw your booking come in myself.</p>${slotLine}${BTN(book, hasSlot ? "Put it on my calendar →" : "Pick my time →")}${ABOUT}
       <p>To make the call count, have rough monthly order volume, SKU count, and what you pay today (if anything) handy — you'll leave with your exact number.</p>`) };
    case "call_d2": return { subject: "Before our call — the numbers", html: wrap(
      `<p>Hi ${first},</p><p>In case you're comparing options in the meantime, here's our full rate card — every line item, nothing gated. Fifteen minutes on a call turns it into your number:</p>
       ${BTN(book, "Pick a time →")}${rateCardTable()}
       <p>Need to move your call time? Use the same link.</p>`) };
    case "call_d6": return { subject: "The math most brands ask about", html: wrap(
      `<p>Hi ${first},</p><p>The question I get most: "what does a month actually cost?" It comes down to three numbers: orders a month, units per order, and how much you keep on the shelf.</p>
       <p>Pick &amp; pack runs <b>$1.65 to $1.95</b> an order by volume, storage is billed on the pallets, shelves and bins you actually use, and there is no monthly minimum.</p>
       <p>Give me those three numbers on one short call and you leave with your month, line by line.</p>${BTN(book, "Grab a time →")}`) };
    case "rate_t0": return { subject: "Your shipbay rate card", html: wrap(
      `<p>Hi ${first},</p><p>Thanks for the interest in shipbay — here's the full rate card you asked for. I'm the founder. The card is our list; fifteen minutes with me turns it into your exact number:</p>
       ${BTN(book, "Book 15 minutes →")}${rateCardTable()}${BTN(book, "Get your exact quote →")}`) };
    case "rate_d2": return { subject: "Want your exact number?", html: wrap(
      `<p>Hi ${first},</p><p>The rate card gives you our list — but your real cost depends on items per order and how you store. Give me 15 minutes and we'll price your catalog line by line, same day.</p>
       ${BTN(book, "Book 15 minutes →")}${ABOUT}`) };
    case "rate_d5": return { subject: "What a month at shipbay is made of", html: wrap(
      `<p>Hi ${first},</p><p>A month with us is three lines: pick &amp; pack (<b>$1.65 to $1.95</b> an order by volume, +$0.45 per extra unit), storage on what you actually keep here (from $1 a bin to $18 a standard pallet), and receiving when stock arrives ($10 for a single-SKU pallet).</p>
       <p>No monthly minimum, no setup fee, and postage stays on your own carrier account.</p>
       <p>If the math looks right, the next step is a short call.</p>${BTN(book, "Book a call →")}`) };
    case "app_t0": return { subject: "We got your shipbay application", html: wrap(
      `<p>Hi ${first},</p><p>Thanks for applying for a shipbay account — your answers are in front of our team right now (I read every application myself).</p>
       <p><b>What happens next:</b> we price your catalog against your volumes and come back with your exact quote and an onboarding plan — typically the same business day. The fastest way through it is 15 minutes together:</p>
       ${BTN(book, "Pick a time →")}${ABOUT}`) };
    case "app_d1": return { subject: "Your pricing is being built — grab a time", html: wrap(
      `<p>Hi ${first},</p><p>We've started pricing your catalog. Fastest way to finish is 15 minutes together — we'll walk your quote line by line and map your move-in.</p>
       ${BTN(book, "Pick a time →")}`) };
    case "app_d4": return { subject: "Still want that quote?", html: wrap(
      `<p>Hi ${first},</p><p>Your application is still open with us. If now's not the moment, no pressure — there's no setup fee and no monthly minimum whenever you're ready. If you want it wrapped this week:</p>
       ${BTN(book, "Finish my quote →")}`) };
    default: return null;
  }
}

async function sendEmail(apiKey: string, to: string, subject: string, html: string, opts: { from?: string; replyTo?: string; text?: string } = {}): Promise<{ ok: boolean; id?: string }> {
  const from = opts.from ?? Deno.env.get("FOUNDER_FROM") ?? "Derek Harrison — shipbay <derekh@shipbay3pl.com>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], reply_to: opts.replyTo ?? "sales@shipbay3pl.com", subject, html, ...(opts.text ? { text: opts.text } : {}),
      headers: { "X-Priority": "1", "Importance": "high" } }),
  });
  if (!res.ok) { console.error("Resend error:", res.status, await res.text()); return { ok: false }; }
  const j = await res.json().catch(() => ({})); return { ok: true, id: j?.id };
}

// ===================== Blitz (purchased leads · 14-day) — plain-text style, sent from the assigned rep =====================
// deno-lint-ignore no-explicit-any
type Lead = Record<string, any>;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function blitzVars(lead: Lead) {
  const first = String(lead.contact_name ?? "").trim().split(/\s+/)[0] || "there";
  const company = String(lead.company ?? "").trim();
  const orders = String(lead.orders_est ?? "").trim();
  const skus = ((String(lead.notes ?? "").match(/SKUs:\s*([^|\n]+)/i) ?? [])[1] ?? "").trim();
  return { first, company, orders, skus };
}
/** Rate Card v2 pick & pack rate for a stated monthly volume ("400", "1,000-5,000"); null when no number is given */
function v2Rate(orders: string): string | null {
  const m = orders.replace(/,/g, "").match(/\d+/); if (!m) return null;
  const n = Number(m[0]); return n <= 1000 ? "$1.95" : n <= 5000 ? "$1.80" : "$1.65";
}
/** the five Blitz emails as plain paragraphs; {v} = merge values. Blank company / volume just drop the clause.
 *  Each one ends on the Calendly link (book); the reply options stay as the second way in. */
function blitzBody(t: string, lead: Lead, book: string): { subject: string; paras: string[] } | null {
  const { first, company, orders, skus } = blitzVars(lead);
  const brand = company || "your brand";
  const who = company ? `someone at ${company}` : "you";
  const rate = v2Rate(orders);
  const vol = [orders ? `around ${orders} orders a month` : "", skus ? `${skus} SKUs` : ""].filter(Boolean).join(", ");
  switch (t) {
    case "blitz_e1": return { subject: `${company ? company + " x " : ""}ShipBay3PL`, paras: [
      `Hi ${first},`,
      `Back in July ${who} requested 3PL quotes${vol ? ` — ${vol}` : ""}. A few months on, you've either signed with one of the places that called you, or you're still shipping it yourself. Either way, quick one.`,
      `We're a fulfillment warehouse in Hillsborough, NJ. You don't need a discovery call to see the price, it's published:`,
      `${rate ? `${rate} per order picked and packed at your volume` : "$1.65 to $1.95 per order picked and packed, by monthly volume"} (+$0.45 per extra unit)${rate === "$1.65" ? ", on a 12-month term" : ""}\nStorage on the pallets, shelves and bins you actually use: from $1 a bin to $18 a standard pallet a month\nNo monthly minimum, $0 setup, month-to-month\nPostage on your own carrier account: your rates, never on our invoice\nOrders in by 2pm ET ship same day, Mon–Sat.`,
      `Fifteen minutes is all it takes to put your real numbers against that rate. Pick a time here:\n${book}`,
      `Or just reply with a number:\n1 — Still open. Quote my real numbers.\n2 — Signed elsewhere. (Tell me who — and if it's gone sideways, we move you with zero downtime.)\n3 — Handling it in-house.`] };
    case "blitz_e2": return { subject: "the 4 quotes you probably got in July", paras: [
      `${first},`,
      `If you requested quotes in July, you likely got four or five — each after a discovery call, each with a different structure: a "flat $11 ship" here, a $2.50 pick plus materials there, a storage rate that quietly goes up in November.`,
      `Three lines to check on every one of them, in writing:\n1. Is postage at carrier cost, or a flat rate with the margin inside it? (Ours: it runs on your own carrier account. We never invoice postage.)\n2. Does storage move during peak? (Ours: no surcharge, and you pay only for the space you use.)\n3. What's the minimum, and when does it start? (Ours: none.)`,
      `If any of those come back vague, that's the answer.`,
      `For ${brand} I can turn our published rates into a formal quote on your real orders in one business day. Book 15 minutes and we'll do it together:\n${book}`,
      `Or reply "quote" and I'll send the two-line instructions for a 30-day order export.`] };
    case "blitz_e3": return { subject: "try it with one SKU", paras: [
      `Hi ${first},`,
      `The reason most brands don't switch 3PLs isn't the price — it's the fear of moving everything and being wrong.`,
      `So don't move everything. Send us one SKU — your fastest mover — first. No setup fee, no minimum, month-to-month. You'll see the receiving count in your dashboard within 24 hours, orders in by 2pm ET ship the same day, and you'll have a real invoice to compare against what you pay now.`,
      `If it's better, we move the rest with zero downtime — your current setup keeps running until ours is proven. If it isn't, you've lost nothing.`,
      `Want me to set that up for ${brand}? Pick a time and we'll map it in 15 minutes:\n${book}`] };
    case "blitz_e4": return { subject: "the peak question", paras: [
      `${first},`,
      `Practical note: if ${brand} wants to be shipping from a new warehouse before the holiday rush, inventory needs to be moving in about two weeks before your peak. We count it in within 24 hours and the integration is same-week, but a parallel-run week and your own carrier cutover take time nobody can compress once the orders are flying.`,
      `If it is this year, book 15 minutes and we'll set your receiving dates on the call:\n${book}`,
      `If this isn't the year, no problem — reply "Q1" and I'll check back in January.`] };
    case "blitz_e5": return { subject: "closing this out", paras: [
      `Hi ${first},`,
      `I've reached out a few times about the fulfillment request for ${brand} and haven't heard back, which usually means it's handled or not a priority. Either is fine — I'll close the file.`,
      `If it ever comes back around: there's no setup fee, no monthly minimum, and one 15-minute call gets you your number. The link stays open:\n${book}`,
      `Best,`] };
    default: return null;
  }
}
function blitzHtml(paras: string[], sig: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#101C2B;max-width:620px">` +
    paras.map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, "<br>")}</p>`).join("") +
    `<p style="margin:22px 0 0;white-space:pre-line">${esc(sig)}</p></div>`;
}
const DEFAULT_SIG: Record<string, string> = {
  "derekh@shipbay3pl.com": "Derek Harrison\nFounder | ShipBay 3PL\n(610) 478-5432 | derekh@shipbay3pl.com\nshipbay3pl.com · Hillsborough, NJ",
};
/** drain due Blitz email steps (or just one lead's, for the instant E1). Called by pg_cron every 10 min and by lead-intake. */
async function runBlitz(apiKey: string | undefined, sb: string, rest: Record<string, string>, onlyLead?: string): Promise<{ sent: number; skipped: number; due: number }> {
  const nowIso = new Date().toISOString();
  const url = `${sb}/rest/v1/sales_sequence_queue?status=eq.queued&kind=eq.email&due_at=lte.${nowIso}${onlyLead ? `&lead_id=eq.${onlyLead}` : ""}&select=id,step,template,lead_id,sales_leads(id,email,contact_name,company,orders_est,notes,stage,assigned_to)&order=due_at.asc&limit=40`;
  const q = await fetch(url, { headers: rest });
  if (!q.ok) { console.error("blitz queue read failed:", q.status, await q.text()); return { sent: 0, skipped: 0, due: 0 }; }
  const due = await q.json();
  let sent = 0, skipped = 0;
  const reps: Record<string, { email: string; full_name: string; signature: string; book: string }> = {};
  let teamBook = "";
  for (const row of due) {
    const lead: Lead = row.sales_leads ?? {};
    const patch = async (p: Record<string, unknown>) => fetch(`${sb}/rest/v1/sales_sequence_queue?id=eq.${row.id}`, { method: "PATCH", headers: rest, body: JSON.stringify(p) });
    if (!lead.email || !["new", "contacted"].includes(String(lead.stage))) { await patch({ status: "skipped", error: `lead stage ${lead.stage ?? "?"}` }); skipped++; continue; }
    if (!apiKey) { console.error("RESEND_API_KEY not set — Blitz emails held."); break; }
    // sender = the assigned rep (falls back to Derek); signature from their rep settings; booking link = theirs, else the team's
    const rid = String(lead.assigned_to ?? "");
    if (rid && !reps[rid]) {
      const p = await (await fetch(`${sb}/rest/v1/profiles?id=eq.${rid}&select=email,full_name`, { headers: rest })).json().catch(() => []);
      const s = await (await fetch(`${sb}/rest/v1/sales_rep_settings?user_id=eq.${rid}&select=signature`, { headers: rest })).json().catch(() => []);
      reps[rid] = { email: p?.[0]?.email ?? "", full_name: p?.[0]?.full_name ?? "", signature: s?.[0]?.signature ?? "", book: await bookingUrl(sb, rest, rid) };
    }
    if (!rid && !teamBook) teamBook = await bookingUrl(sb, rest);
    const rep = reps[rid] ?? { email: "", full_name: "", signature: "", book: teamBook };
    const msg = blitzBody(String(row.template), lead, rep.book || DEFAULT_BOOK);
    if (!msg) { await patch({ status: "skipped", error: "unknown template" }); skipped++; continue; }
    const fromEmail = rep.email && rep.email.endsWith("@shipbay3pl.com") ? rep.email : "derekh@shipbay3pl.com";
    const fromName = rep.full_name || "Derek Harrison";
    const sig = rep.signature || DEFAULT_SIG[fromEmail] || `${fromName}\nShipBay 3PL\n${fromEmail}\nshipbay3pl.com · Hillsborough, NJ`;
    const html = blitzHtml(msg.paras, sig);
    const text = msg.paras.join("\n\n") + "\n\n" + sig;
    const r = await sendEmail(apiKey, String(lead.email), msg.subject, html, { from: `${fromName} <${fromEmail}>`, replyTo: fromEmail, text });
    if (!r.ok) { await patch({ error: "resend failed, will retry" }); continue; }
    sent++;
    await patch({ status: "sent", sent_at: nowIso, external_id: r.id ?? null, error: null });
    await fetch(`${sb}/rest/v1/sales_email_sends`, { method: "POST", headers: { ...rest, Prefer: "return=minimal" }, body: JSON.stringify({
      external_id: r.id ? `resend:${r.id}` : `blitz:${row.id}`, lead_id: lead.id, lead_email: lead.email, lead_name: lead.contact_name ?? null, campaign: "blitz", mailbox: fromEmail,
      step: row.step, subject: msg.subject, sent_at: nowIso, body: text.slice(0, 4000) }) });
    await fetch(`${sb}/rest/v1/sales_leads?id=eq.${lead.id}`, { method: "PATCH", headers: rest, body: JSON.stringify({ last_touch_at: nowIso, last_outcome: "email_sent", stage: lead.stage === "new" ? "contacted" : lead.stage }) });
  }
  console.log(`blitz run${onlyLead ? ` (lead ${onlyLead})` : ""}: ${sent} sent, ${skipped} skipped, ${due.length} due`);
  return { sent, skipped, due: due.length };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!(await secretOk(req.headers.get("x-webhook-secret")))) {
    return new Response("forbidden", { status: 403 });
  }
  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch (_) { return new Response("bad request", { status: 400 }); }

  const apiKey = Deno.env.get("RESEND_API_KEY");
  const sb = Deno.env.get("SUPABASE_URL");
  const srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const rest = { "apikey": srk ?? "", "Authorization": `Bearer ${srk}`, "Content-Type": "application/json" };

  // ---- preview: render a template without sending (what the portal and a check from SQL use) ----
  if (body.preview) {
    const book = await bookingUrl(srk ? sb : undefined, rest);
    const t = String(body.preview);
    const sample = { name: "Jordan Lee", contact_name: "Jordan Lee", company: "Vinyl Moons", orders_est: "400", slot: body.slot ?? "" };
    const w = render(t, sample, book); const bz = w ? null : blitzBody(t, sample, book);
    return new Response(JSON.stringify(w ? { subject: w.subject, has_link: w.html.includes(book), book } : bz ? { subject: bz.subject, has_link: bz.paras.join("\n").includes(book), book, text: bz.paras.join("\n\n") } : { error: "unknown template" }), { status: 200 });
  }

  // ---- mode 1: instant email for a new lead ----
  if (body.record && body.template) {
    const lead = body.record;
    const email = String(lead.email ?? "").trim();
    if (!email || !email.includes("@")) return new Response(JSON.stringify({ skipped: "no email" }), { status: 200 });
    if (!apiKey) {
      console.error(`RESEND_API_KEY not set — ${body.template} NOT sent to ${email}. Send manually from the CRM.`);
      return new Response(JSON.stringify({ ok: false, reason: "missing RESEND_API_KEY" }), { status: 200 });
    }
    const msg = render(String(body.template), lead, await bookingUrl(srk ? sb : undefined, rest));
    if (!msg) return new Response(JSON.stringify({ skipped: "unknown template" }), { status: 200 });
    const { ok } = await sendEmail(apiKey, email, msg.subject, msg.html);
    console.log(`${body.template} → ${email}: ${ok ? "sent" : "FAILED"}`);
    return new Response(JSON.stringify({ ok }), { status: 200 });
  }

  // ---- mode 3: Blitz runner (pg_cron every 10 min; lead-intake calls it with lead_id for the instant E1) ----
  if (body.run_blitz) {
    if (!sb || !srk) return new Response(JSON.stringify({ ok: false, reason: "missing service credentials" }), { status: 200 });
    const out = await runBlitz(apiKey, sb, rest, body.lead_id ? String(body.lead_id) : undefined);
    return new Response(JSON.stringify({ ok: true, ...out }), { status: 200 });
  }

  // ---- mode 2: cron runner for due follow-ups ----
  if (body.run_due) {
    if (!sb || !srk) return new Response(JSON.stringify({ ok: false, reason: "missing service credentials" }), { status: 200 });
    const q = await fetch(`${sb}/rest/v1/sequence_queue?sent=eq.false&send_at=lte.${new Date().toISOString()}&select=id,template,lead_id,leads(name,email,brand,slot,stage)&limit=50`, { headers: rest });
    if (!q.ok) { console.error("queue read failed:", q.status, await q.text()); return new Response("queue read failed", { status: 200 }); }
    const due = await q.json();
    let sent = 0, skipped = 0;
    const book = due.length ? await bookingUrl(sb, rest) : DEFAULT_BOOK;
    for (const row of due) {
      const lead = row.leads ?? {};
      const stage = String(lead.stage ?? "");
      let status = "sent";
      if (["won", "lost"].includes(stage) || !lead.email) { status = "skipped"; skipped++; }
      else if (!apiKey) { console.error("RESEND_API_KEY not set — follow-ups held in queue."); break; }
      else {
        const msg = render(String(row.template), lead, book);
        if (!msg) { status = "skipped"; skipped++; }
        else {
          const { ok } = await sendEmail(apiKey, String(lead.email), msg.subject, msg.html);
          if (!ok) continue; // leave unsent, retry next run
          sent++;
        }
      }
      await fetch(`${sb}/rest/v1/sequence_queue?id=eq.${row.id}`, {
        method: "PATCH", headers: rest,
        body: JSON.stringify({ sent: true, sent_at: new Date().toISOString(), status }),
      });
    }
    console.log(`sequence run: ${sent} sent, ${skipped} skipped, ${due.length} due`);
    return new Response(JSON.stringify({ ok: true, sent, skipped }), { status: 200 });
  }

  return new Response("bad request", { status: 400 });
});
