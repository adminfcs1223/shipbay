// lead-emails — every prospect-facing email, sent from the founder via Resend.
// Two entry points, both guarded by the shared secret:
//   { record, template }  — a Postgres trigger sends the instant (T0) email for a new lead
//   { run_due: true }     — pg_cron calls this every 30 min to send due sequence follow-ups
// Secrets: WEBHOOK_SECRET, RESEND_API_KEY (verified shipbay3pl.com domain in Resend). Optional: FOUNDER_FROM.
// Follow-ups are skipped automatically once a lead is marked won or lost in the CRM.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET")!;
const BOOK_URL = "https://www.shipbay3pl.com/book";
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
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">
    ${grp("PICK &amp; PACK — VOLUME PRICING, PACKAGING INCLUDED")}
    ${row("5,000+ orders/mo", "$1.65 / order", "+ $0.40 per additional unit")}
    ${row("1,000 – 5,000 orders/mo", "$1.80 / order", "+ $0.40 per additional unit")}
    ${row("Under 1,000 orders/mo", "$1.95 / order", "+ $0.40 per additional unit · no order minimums")}
    ${grp("RECEIVING")}
    ${row("Pallet received", "$20 / pallet", "Counted and verified against your ASN")}
    ${row("Loose cartons", "$3 / carton", "")}
    ${row("Container unload", "$350 (20′) · $500 (40′)", "Palletized; floor-loaded +$150")}
    ${grp("STORAGE — NO PEAK-SEASON SURCHARGE")}
    ${row("Pallet", "$30 / month", "")}
    ${row("Shelf", "$10 / month", "")}
    ${row("Bin", "$2.50 / month", "")}
    ${grp("B2B, PREP &amp; PROJECTS")}
    ${row("B2B / wholesale order", "from $5.50 + $0.40/unit", "Pallet build $18")}
    ${row("FBA / marketplace prep", "from $0.60 / unit", "Labels, polybags")}
    ${row("Return processed", "$3.00 + $0.50/addl item", "Inspection and restock included")}
    ${row("Kitting / special projects", "$40 / hour", "Quoted before we start")}
    ${grp("ACCOUNT")}
    ${row("Setup / onboarding", "$0", "Shopify, WooCommerce, Amazon &amp; TikTok Shop included")}
    ${row("Monthly minimum", "$250", "Waived your first 60 days")}
    ${row("Shipping / postage", "Carrier rates, at cost", "Line-item on every invoice · no markup")}
    ${row("Contract", "Month-to-month", "No lock-in, no offboarding fee")}
  </table>`;
}

const ABOUT = `<p>Quick bit about us: shipbay is a DTC 3PL that runs its own warehouse in Hillsborough, NJ.
  Orders in by 2pm ET ship the same day, pricing is published and volume-tiered, there's no setup fee,
  and it's month-to-month — you're never locked in.</p>`;

// deno-lint-ignore no-explicit-any
function render(template: string, lead: any): { subject: string; html: string } | null {
  const first = String(lead.name ?? "").trim().split(/\s+/)[0] || "there";
  const slot = String(lead.slot ?? "");
  const slotLine = slot && slot !== "ASAP"
    ? `<p><b>Your call is confirmed for ${slot} (Eastern).</b> If that stops working, just reply and we'll move it.</p>`
    : `<p><b>You asked us to call as soon as possible</b> — a specialist (usually me) will ring you during business hours today or tomorrow morning.</p>`;
  switch (template) {
    case "call_t0": return { subject: "Your shipbay call is booked", html: wrap(
      `<p>Hi ${first},</p><p>Thanks for the interest in shipbay — I saw your booking come in myself.</p>${slotLine}${ABOUT}
       <p>To make the call count, have rough monthly order volume, SKU count, and what you pay today (if anything) handy — you'll leave with your exact number.</p>`) };
    case "call_d2": return { subject: "Before our call — the numbers", html: wrap(
      `<p>Hi ${first},</p><p>In case you're comparing options in the meantime, here's our full rate card — every line item, nothing gated:</p>${rateCardTable()}
       <p>Need to move your call time? Just reply.</p>`) };
    case "call_d6": return { subject: "The math most brands ask about", html: wrap(
      `<p>Hi ${first},</p><p>The question I get most: "what does a month actually cost?" Three real examples on our rates, ex-postage:</p>
       <p>• 350 orders/mo ≈ <b>$924</b> · • 1,500 orders/mo ≈ <b>$3,660</b> · • 5,000 orders/mo ≈ <b>$11,650</b></p>
       <p>On reported rates at the major national 3PLs, those same months run roughly $1,050–$1,280, $4,350–$5,330, and $14,700–$18,100.</p>
       <p>Happy to price your exact catalog — takes one short call.</p>${BTN(BOOK_URL, "Grab a time →")}`) };
    case "rate_t0": return { subject: "Your shipbay rate card", html: wrap(
      `<p>Hi ${first},</p><p>Thanks for the interest in shipbay — here's the full rate card you asked for. I'm the founder; if any line needs explaining, reply and you'll get me, not a queue.</p>
       ${rateCardTable()}${BTN(BOOK_URL, "Get your exact quote →")}`) };
    case "rate_d2": return { subject: "Want your exact number?", html: wrap(
      `<p>Hi ${first},</p><p>The rate card gives you our list — but your real cost depends on items per order and how you store. Give me 15 minutes and we'll price your catalog line by line, same day.</p>
       ${BTN(BOOK_URL, "Book 15 minutes →")}${ABOUT}`) };
    case "rate_d5": return { subject: "How a month at shipbay compares", html: wrap(
      `<p>Hi ${first},</p><p>Real months on our rates, ex-postage: 350 orders ≈ <b>$924</b> · 1,500 ≈ <b>$3,660</b> · 5,000 ≈ <b>$11,650</b> — against roughly $1,050–$1,280 / $4,350–$5,330 / $14,700–$18,100 at the majors on reported rates.</p>
       <p>If the math looks right, the next step is a short call.</p>${BTN(BOOK_URL, "Book a call →")}`) };
    case "app_t0": return { subject: "We got your shipbay application", html: wrap(
      `<p>Hi ${first},</p><p>Thanks for applying for a shipbay account — your answers are in front of our team right now (I read every application myself).</p>
       <p><b>What happens next:</b> we price your catalog against your volumes and come back with your exact quote and an onboarding plan — typically the same business day. If anything needs clarifying, we'll call.</p>${ABOUT}`) };
    case "app_d1": return { subject: "Your pricing is being built — grab a time", html: wrap(
      `<p>Hi ${first},</p><p>We've started pricing your catalog. Fastest way to finish is 15 minutes together — we'll walk your quote line by line and map your move-in.</p>
       ${BTN(BOOK_URL, "Pick a time →")}`) };
    case "app_d4": return { subject: "Still want that quote?", html: wrap(
      `<p>Hi ${first},</p><p>Your application is still open with us. If now's not the moment, no pressure — the quote stays good and there's no fee or lock-in whenever you're ready. If you want it wrapped this week:</p>
       ${BTN(BOOK_URL, "Finish my quote →")}`) };
    default: return null;
  }
}

async function sendEmail(apiKey: string, to: string, subject: string, html: string): Promise<boolean> {
  const from = Deno.env.get("FOUNDER_FROM") ?? "Derek Harrison — shipbay <derekh@shipbay3pl.com>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], reply_to: "sales@shipbay3pl.com", subject, html,
      headers: { "X-Priority": "1", "Importance": "high" } }),
  });
  if (!res.ok) console.error("Resend error:", res.status, await res.text());
  return res.ok;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!WEBHOOK_SECRET || req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch (_) { return new Response("bad request", { status: 400 }); }

  const apiKey = Deno.env.get("RESEND_API_KEY");
  const sb = Deno.env.get("SUPABASE_URL");
  const srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const rest = { "apikey": srk ?? "", "Authorization": `Bearer ${srk}`, "Content-Type": "application/json" };

  // ---- mode 1: instant email for a new lead ----
  if (body.record && body.template) {
    const lead = body.record;
    const email = String(lead.email ?? "").trim();
    if (!email || !email.includes("@")) return new Response(JSON.stringify({ skipped: "no email" }), { status: 200 });
    if (!apiKey) {
      console.error(`RESEND_API_KEY not set — ${body.template} NOT sent to ${email}. Send manually from the CRM.`);
      return new Response(JSON.stringify({ ok: false, reason: "missing RESEND_API_KEY" }), { status: 200 });
    }
    const msg = render(String(body.template), lead);
    if (!msg) return new Response(JSON.stringify({ skipped: "unknown template" }), { status: 200 });
    const ok = await sendEmail(apiKey, email, msg.subject, msg.html);
    console.log(`${body.template} → ${email}: ${ok ? "sent" : "FAILED"}`);
    return new Response(JSON.stringify({ ok }), { status: 200 });
  }

  // ---- mode 2: cron runner for due follow-ups ----
  if (body.run_due) {
    if (!sb || !srk) return new Response(JSON.stringify({ ok: false, reason: "missing service credentials" }), { status: 200 });
    const q = await fetch(`${sb}/rest/v1/sequence_queue?sent=eq.false&send_at=lte.${new Date().toISOString()}&select=id,template,lead_id,leads(name,email,brand,slot,stage)&limit=50`, { headers: rest });
    if (!q.ok) { console.error("queue read failed:", q.status, await q.text()); return new Response("queue read failed", { status: 200 }); }
    const due = await q.json();
    let sent = 0, skipped = 0;
    for (const row of due) {
      const lead = row.leads ?? {};
      const stage = String(lead.stage ?? "");
      let status = "sent";
      if (["won", "lost"].includes(stage) || !lead.email) { status = "skipped"; skipped++; }
      else if (!apiKey) { console.error("RESEND_API_KEY not set — follow-ups held in queue."); break; }
      else {
        const msg = render(String(row.template), lead);
        if (!msg) { status = "skipped"; skipped++; }
        else {
          const ok = await sendEmail(apiKey, String(lead.email), msg.subject, msg.html);
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
