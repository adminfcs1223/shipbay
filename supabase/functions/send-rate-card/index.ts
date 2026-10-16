// send-rate-card — when a visitor requests the full rate card on pricing.html,
// email it to them automatically via Resend. Fires on every lead insert; skips
// anything that is not a rate-card request.
// Secrets: WEBHOOK_SECRET, RESEND_API_KEY. Optional: RATECARD_FROM / SALES_NOTIFY_FROM.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET")!;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!WEBHOOK_SECRET || req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  let lead: Record<string, unknown> = {};
  try {
    const body = await req.json();
    lead = (body.record ?? body) as Record<string, unknown>;
  } catch (_) {
    return new Response("bad request", { status: 400 });
  }

  if (String(lead.source ?? "") !== "Rate card request") {
    return new Response(JSON.stringify({ ok: true, skipped: "not a rate card request" }), { status: 200 });
  }
  const email = String(lead.email ?? "").trim();
  if (!email) return new Response(JSON.stringify({ ok: false, skipped: "no email" }), { status: 200 });

  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    console.error("RESEND_API_KEY is not set — rate card NOT emailed to", email, "— follow up manually from the CRM.");
    return new Response(JSON.stringify({ ok: false, reason: "missing RESEND_API_KEY" }), { status: 200 });
  }
  const from = Deno.env.get("RATECARD_FROM") ?? Deno.env.get("SALES_NOTIFY_FROM") ?? "shipbay <derekh@shipbay3pl.com>";

  const row = (svc: string, rate: string, note: string) =>
    `<tr><td style="padding:9px 12px;border-top:1px solid #E8E6E1">${svc}</td><td style="padding:9px 12px;border-top:1px solid #E8E6E1;white-space:nowrap"><b>${rate}</b></td><td style="padding:9px 12px;border-top:1px solid #E8E6E1;color:#5A6473;font-size:13px">${note}</td></tr>`;
  const grp = (t: string) =>
    `<tr><td colspan="3" style="padding:8px 12px;background:#FFF0E4;color:#D14E00;font-size:11px;letter-spacing:.12em"><b>${t}</b></td></tr>`;

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#101C2B">
    <div style="height:6px;background:#FF6B15;border-radius:3px"></div>
    <h2 style="margin:22px 0 4px">ship<span style="color:#FF6B15">bay</span>. — Full Rate Card</h2>
    <p style="color:#5A6473;margin:0 0 18px">Effective September 2026 · 115 Stryker Ln, Hillsborough Township, NJ</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
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
      ${row("B2B / wholesale order", "from $5.50 + $0.40/unit", "Pallet build $18 · routing-guide work quoted up front")}
      ${row("FBA / marketplace prep", "from $0.60 / unit", "Labels, polybags")}
      ${row("Return processed", "$3.00 + $0.50/addl item", "Inspection and restock included")}
      ${row("Kitting / special projects", "$40 / hour", "Quoted before we start")}
      ${grp("ACCOUNT")}
      ${row("Setup / onboarding", "$0", "Shopify, WooCommerce, Amazon &amp; TikTok Shop included")}
      ${row("Monthly minimum", "$250", "Pick &amp; pack + storage combined · waived your first 60 days")}
      ${row("Shipping / postage", "Carrier rates, at cost", "Line-item on every invoice · no markup")}
      ${row("Contract", "Month-to-month", "No lock-in, no offboarding fee")}
    </table>
    <p style="margin:24px 0"><a href="https://www.shipbay3pl.com/book" style="background:#FF6B15;color:#fff;text-decoration:none;padding:13px 24px;border-radius:9px;font-weight:bold;display:inline-block">Get your exact quote →</a></p>
    <p style="color:#5A6473;font-size:13px">Questions? Reply to this email, write <b>sales@shipbay3pl.com</b>, or call <b>(610) 478-5432</b>.<br>shipbay · 115 Stryker Ln, Bldg 4 Unit 10, Hillsborough Township, NJ 08844</p>
  </div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [email], reply_to: "sales@shipbay3pl.com", subject: "Your shipbay rate card", html }),
  });
  const out = await res.text();
  if (!res.ok) console.error("Resend error:", res.status, out);
  else console.log("Rate card emailed to", email);
  return new Response(JSON.stringify({ ok: res.ok }), { headers: { "Content-Type": "application/json" } });
});
