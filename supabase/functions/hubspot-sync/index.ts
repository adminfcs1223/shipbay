// hubspot-sync — pushes every new website lead into HubSpot, consolidated:
//   contact (owner-assigned) → company (found or created, by domain/name)
//   → ONE open deal per contact (new submissions append to it, never duplicate)
//   → note with the full submission → follow-up task assigned to the owner.
// Called by a Postgres trigger on public.leads; guarded by a shared secret.
// Secrets: WEBHOOK_SECRET, HUBSPOT_TOKEN (private app: contacts, companies, deals + engagements write). Optional: HUBSPOT_OWNER_ID.
// NOTE: cold-outreach leads never go through here (rule 2026-09-28) — only website inbound.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET")!;
const HS = "https://api.hubapi.com";
const FREE_MAIL = /gmail|yahoo|outlook|hotmail|aol|icloud|proton|live\.|msn/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!WEBHOOK_SECRET || req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });

  // deno-lint-ignore no-explicit-any
  let lead: Record<string, any>;
  try {
    const body = await req.json();
    lead = (body.record ?? body) as Record<string, unknown>;
  } catch (_) { return new Response("bad request", { status: 400 }); }

  const email = String(lead.email ?? "").trim().toLowerCase();
  if (!email) return json({ ok: false, skipped: "lead has no email" });

  const token = Deno.env.get("HUBSPOT_TOKEN");
  if (!token) {
    console.error("HUBSPOT_TOKEN is not set — lead not synced:", email);
    return json({ ok: false, skipped: "missing HUBSPOT_TOKEN" });
  }
  const OWNER = Deno.env.get("HUBSPOT_OWNER_ID") ?? "98126585"; // Derek
  const h = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };

  const name = String(lead.name ?? "").trim();
  const [firstname, ...rest] = name.split(/\s+/);
  const brand = String(lead.brand ?? "").trim();
  const src = String(lead.source ?? "");
  const isApplication = lead.intake != null || /start|get started|migrate|intake|application/i.test(src);
  const leadType = /rate card/i.test(src) ? "Rate card request" : isApplication ? "Account application" : "Booked call";

  // ---- 1) upsert contact (owner-assigned) ----
  const contactProps: Record<string, string> = {
    email, firstname: firstname ?? "", lastname: rest.join(" "),
    phone: String(lead.phone ?? ""), company: brand,
    lifecyclestage: "lead", hubspot_owner_id: OWNER,
  };
  let contactId: string | undefined;
  let contactWasNew = false;
  let r = await fetch(`${HS}/crm/v3/objects/contacts`, { method: "POST", headers: h, body: JSON.stringify({ properties: contactProps }) });
  if (r.status === 409) {
    const t = await r.json();
    contactId = (String(t.message ?? "").match(/Existing ID: (\d+)/) ?? [])[1];
    if (contactId) {
      await fetch(`${HS}/crm/v3/objects/contacts/${contactId}`, { method: "PATCH", headers: h, body: JSON.stringify({ properties: contactProps }) });
    }
  } else if (r.ok) { contactId = (await r.json()).id; contactWasNew = true; }
  else { console.error("HubSpot contact error:", r.status, await r.text()); return json({ ok: false, step: "contact" }); }
  if (!contactId) return json({ ok: false, step: "contact-id" });

  // ---- 2) find or create the company, associate contact → company ----
  const domain = email.split("@")[1] ?? "";
  const bizDomain = domain && !FREE_MAIL.test(domain) ? domain : "";
  let companyId: string | undefined;
  if (brand || bizDomain) {
    if (bizDomain) {
      r = await fetch(`${HS}/crm/v3/objects/companies/search`, {
        method: "POST", headers: h,
        body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: bizDomain }] }], limit: 1 }),
      });
      if (r.ok) companyId = (await r.json()).results?.[0]?.id;
    }
    if (!companyId && brand) {
      r = await fetch(`${HS}/crm/v3/objects/companies/search`, {
        method: "POST", headers: h,
        body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "name", operator: "EQ", value: brand }] }], limit: 1 }),
      });
      if (r.ok) companyId = (await r.json()).results?.[0]?.id;
    }
    if (!companyId) {
      const props: Record<string, string> = { name: brand || bizDomain, hubspot_owner_id: OWNER };
      if (bizDomain) props.domain = bizDomain;
      r = await fetch(`${HS}/crm/v3/objects/companies`, { method: "POST", headers: h, body: JSON.stringify({ properties: props }) });
      if (r.ok) companyId = (await r.json()).id;
      else console.error("HubSpot company error (add crm.objects.companies.write scope to the private app if 403):", r.status, await r.text());
    }
    if (companyId) {
      await fetch(`${HS}/crm/v4/objects/contacts/${contactId}/associations/default/companies/${companyId}`, { method: "PUT", headers: h });
    }
  }

  // ---- 3) ONE open deal per contact: reuse it, else create ----
  let dealId: string | undefined;
  let dealWasNew = false;
  r = await fetch(`${HS}/crm/v4/objects/contacts/${contactId}/associations/deals?limit=50`, { headers: h });
  if (r.ok) {
    const ids = ((await r.json()).results ?? []).map((x: { toObjectId: number }) => String(x.toObjectId));
    if (ids.length) {
      r = await fetch(`${HS}/crm/v3/objects/deals/batch/read`, {
        method: "POST", headers: h,
        body: JSON.stringify({ properties: ["dealstage", "pipeline", "dealname"], inputs: ids.map((id: string) => ({ id })) }),
      });
      if (r.ok) {
        const open = (await r.json()).results?.find((d: { properties: Record<string, string> }) =>
          d.properties.pipeline === "default" && !["closedwon", "closedlost"].includes(d.properties.dealstage));
        if (open) dealId = open.id;
      }
    }
  }
  if (!dealId) {
    r = await fetch(`${HS}/crm/v3/objects/deals`, {
      method: "POST", headers: h,
      body: JSON.stringify({
        properties: { dealname: `${brand || name || email} — ${leadType}`, pipeline: "default", dealstage: "appointmentscheduled", hubspot_owner_id: OWNER },
        associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }] }],
      }),
    });
    if (r.ok) { dealId = (await r.json()).id; dealWasNew = true; }
    else console.error("HubSpot deal error:", r.status, await r.text());
  }
  if (dealId && companyId) {
    await fetch(`${HS}/crm/v4/objects/deals/${dealId}/associations/default/companies/${companyId}`, { method: "PUT", headers: h });
  }

  // ---- 4) note with the full submission (appends to the same deal) ----
  const esc = (v: unknown) => String(v ?? "—").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows: Array<[string, unknown]> = [
    ["Type", leadType], ["Name", lead.name], ["Brand", lead.brand], ["Email", lead.email],
    ["Phone", lead.phone], ["Requested slot", lead.slot], ["Monthly volume", lead.volume],
    ["Current setup", lead.current_setup], ["Notes", lead.notes], ["Source", lead.source],
  ];
  let noteBody = `<strong>shipbay website — ${esc(leadType)}</strong><br/>` +
    rows.map(([k, v]) => `${esc(k)}: <strong>${esc(v)}</strong>`).join("<br/>");
  if (lead.intake != null) {
    noteBody += `<br/><br/><strong>Full intake answers:</strong><br/><pre>${esc(JSON.stringify(lead.intake, null, 2)).slice(0, 40000)}</pre>`;
  }
  const noteAssoc = [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }];
  if (dealId) noteAssoc.push({ to: { id: dealId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 214 }] });
  r = await fetch(`${HS}/crm/v3/objects/notes`, {
    method: "POST", headers: h,
    body: JSON.stringify({ properties: { hs_note_body: noteBody, hs_timestamp: String(Date.now()) }, associations: noteAssoc }),
  });
  if (!r.ok) console.error("HubSpot note error:", r.status, await r.text());

  // ---- 5) follow-up task assigned to the owner → triggers a HubSpot notification ----
  r = await fetch(`${HS}/crm/v3/objects/tasks`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      properties: {
        hs_task_subject: `${contactWasNew ? "NEW CONTACT" : "New activity"} — ${leadType}: ${brand || name || email}`,
        hs_task_body: `Came in via the website (${src || "website"}). ${dealWasNew ? "New deal created." : "Added to the existing open deal."}`,
        hs_timestamp: String(Date.now() + 60 * 60 * 1000),
        hs_task_status: "NOT_STARTED", hs_task_type: "TODO", hs_task_priority: "HIGH",
        hubspot_owner_id: OWNER,
      },
      associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 204 }] }],
    }),
  });
  if (!r.ok) console.error("HubSpot task error:", r.status, await r.text());

  console.log(`Synced ${email} → contact ${contactId}${contactWasNew ? " (new)" : ""}, company ${companyId ?? "none"}, deal ${dealId ?? "none"}${dealWasNew ? " (new)" : " (existing)"}`);
  return json({ ok: true, contactId, companyId, dealId });
});
