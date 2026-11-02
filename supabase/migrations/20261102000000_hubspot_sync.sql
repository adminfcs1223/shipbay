-- HubSpot is the system of record behind the portal CRM. Every account row carries its HubSpot ids; every call,
-- touch, meeting and mailbox message carries the engagement id it was written to (or read from). Sync state lives
-- in fin_settings.hubspot; the token in platform_secrets.HUBSPOT_TOKEN.
alter table sales_leads
  add column if not exists hs_contact_id text,
  add column if not exists hs_company_id text,
  add column if not exists hs_deal_id text,
  add column if not exists hs_owner_id text,
  add column if not exists hs_synced_at timestamptz;
create unique index if not exists sales_leads_hs_contact on sales_leads (hs_contact_id) where hs_contact_id is not null;
create index if not exists sales_leads_hs_deal on sales_leads (hs_deal_id) where hs_deal_id is not null;
alter table sales_calls add column if not exists hs_id text;
alter table sales_touches add column if not exists hs_id text;
alter table sales_meetings add column if not exists hs_id text;
alter table gmail_messages add column if not exists hs_id text;
create unique index if not exists sales_calls_hs on sales_calls (hs_id) where hs_id is not null;
create unique index if not exists sales_touches_hs on sales_touches (hs_id) where hs_id is not null;
create unique index if not exists sales_meetings_hs on sales_meetings (hs_id) where hs_id is not null;
create unique index if not exists gmail_messages_hs on gmail_messages (hs_id) where hs_id is not null;
-- updated_at moves on every change so the push knows what to send
create or replace trigger sales_leads_touch before update on sales_leads for each row execute function touch_updated_at();
-- staff may read their own HubSpot owner id
alter table profiles add column if not exists hs_owner_id text;
