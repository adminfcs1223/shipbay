// notify-lead — emails the sales desk via Resend when a booking lands in `leads`.
// Called by a Postgres trigger (see migration lead_email_webhook); guarded by a shared secret.
// Secrets: WEBHOOK_SECRET (must match the x-webhook-secret header set in the trigger), RESEND_API_KEY.
// Optional: SALES_NOTIFY_TO, SALES_NOTIFY_FROM.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET")!;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!WEBHOOK_SECRET || req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    console.error("RESEND_API_KEY is not set — add it under Edge Functions secrets.");
    return new Response(JSON.stringify({ ok: false, reason: "missing RESEND_API_KEY" }), { status: 200 });
  }

  const to = Deno.env.get("SALES_NOTIFY_TO") ?? "derekh@shipbay3pl.com";
  const from = Deno.env.get("SALES_NOTIFY_FROM") ?? "shipbay <derekh@shipbay3pl.com>";

  let lead: Record<string, unknown> = {};
  try {
    const body = await req.json();
    lead = (body.record ?? body) as Record<string, unknown>;
  } catch (_) {
    return new Response("bad request", { status: 400 });
  }

  const esc = (v: unknown) =>
    String(v ?? "—").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const rows: Array<[string, unknown]> = [
    ["Name", lead.name], ["Brand", lead.brand], ["Email", lead.email], ["Phone", lead.phone],
    ["Requested slot", lead.slot], ["Monthly volume", lead.volume], ["Current setup", lead.current_setup],
    ["Shipping notes", lead.notes], ["Source", lead.source],
  ];

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto">
    <h2 style="color:#101C2B">New lead<span style="color:#FF6B15">.</span></h2>
    <p style="color:#5A6473">A new lead just landed in the <b>New</b> column. SLA: first response in under 8 minutes.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      ${rows.map(([k, v]) => `<tr><td style="padding:8px 10px;border-top:1px solid #E6E8EC;color:#8A93A3;white-space:nowrap">${k}</td><td style="padding:8px 10px;border-top:1px solid #E6E8EC;color:#101C2B"><b>${esc(v)}</b></td></tr>`).join("")}
    </table>
    <p style="margin-top:20px"><a href="https://www.shipbay3pl.com/crm" style="background:#FF6B15;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;display:inline-block">Open salesdesk →</a></p>
  </div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from, to: to.split(",").map((s) => s.trim()),
      subject: `New lead: ${lead.brand ?? lead.name ?? "consultation booking"} — ${lead.slot ?? ""}`,
      html,
    }),
  });
  const out = await res.text();
  if (!res.ok) console.error("Resend error:", res.status, out);
  return new Response(JSON.stringify({ ok: res.ok }), { headers: { "Content-Type": "application/json" } });
});
