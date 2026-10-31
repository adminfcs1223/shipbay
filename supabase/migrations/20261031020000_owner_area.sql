-- Owner area: a section of shipbay.dashboard only the business owner (Derek) can open, behind the normal login
-- AND a second passphrase (verified by the `owner` edge function; hash kept in platform_secrets).
-- Everything here is owner-only at the database level: RLS checks is_owner(), so staff and clients never see these rows.
-- Connector-safe: no DROP statements; policies guarded with pg_policies checks.

alter table profiles add column if not exists is_owner boolean not null default false;
update profiles set is_owner = true where email = 'derekh@shipbay3pl.com';

create or replace function is_owner() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_owner from profiles where id = auth.uid()), false)
$$;
revoke all on function is_owner() from public;
grant execute on function is_owner() to authenticated;

-- ---------- Finance (ShipBay's own book of record until QuickBooks is clean) ----------
create table if not exists fin_transactions (
  id uuid primary key default gen_random_uuid(),
  txn_date date not null,
  kind text not null check (kind in ('revenue','expense','capex','owner_contribution','owner_draw')),
  category text not null,
  counterparty text,
  description text,
  amount numeric(12,2) not null check (amount >= 0),
  paid boolean not null default true,
  source text not null default 'manual',          -- manual | import | qbo
  external_id text unique,                          -- QuickBooks txn id when synced
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists fin_transactions_date on fin_transactions (txn_date);

create table if not exists fin_recurring (
  id uuid primary key default gen_random_uuid(),
  item text not null,
  category text not null,
  amount numeric(12,2) not null,
  starts date not null,
  ends date,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists fin_pipeline (
  id uuid primary key default gen_random_uuid(),
  client text not null,
  status text not null default 'prospect',          -- prospect | quoted | signed | live | lost
  model text,
  orders_mo integer,
  services_mo numeric(12,2) not null default 0,
  probability numeric(4,3) not null default 0.5 check (probability between 0 and 1),
  start_month date,
  notes text,
  lead_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists fin_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- QuickBooks Online: tokens are service-role only (no policies); status + cached reports are owner-readable.
create table if not exists fin_qbo_tokens (
  realm_id text primary key,
  access_token text not null,
  refresh_token text not null,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create table if not exists fin_qbo_status (
  id int primary key default 1 check (id = 1),
  realm_id text,
  company_name text,
  connected_at timestamptz,
  last_sync_at timestamptz,
  last_error text
);
insert into fin_qbo_status (id) values (1) on conflict (id) do nothing;
create table if not exists fin_qbo_reports (
  id uuid primary key default gen_random_uuid(),
  report text not null,                 -- ProfitAndLoss | BalanceSheet | TransactionList
  period_start date,
  period_end date,
  data jsonb not null,
  fetched_at timestamptz not null default now()
);
create index if not exists fin_qbo_reports_kind on fin_qbo_reports (report, fetched_at desc);

-- ---------- Sales ----------
-- One row per company/person across every channel. in_email / in_calls say which machines have touched it.
create table if not exists sales_leads (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'other',  -- cold_email | cold_call | fulfill_com | fulfilment_com | agency | referral | inbound | linkedin | other
  filter_id text,                         -- Storeleads set (SL-A1-…) or partner list name
  company text,
  domain text,
  contact_name text,
  email text,
  phone text,
  title text,
  city text,
  state text,
  est_sales_usd integer,
  orders_est text,
  products integer,
  rank integer,
  plan text,
  categories text,
  stage text not null default 'new' check (stage in ('new','contacted','replied','call_booked','quoted','signed','lost','dnc')),
  in_email boolean not null default false,
  in_calls boolean not null default false,
  attempts integer not null default 0,
  last_outcome text,
  last_touch_at timestamptz,
  next_action_at timestamptz,
  hubspot_id text,
  notes text,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists sales_leads_domain_uq on sales_leads (lower(domain)) where domain is not null and domain <> '';
create unique index if not exists sales_leads_email_uq on sales_leads (lower(email)) where email is not null and email <> '' and (domain is null or domain = '');
create index if not exists sales_leads_stage on sales_leads (stage);
create index if not exists sales_leads_filter on sales_leads (filter_id);

create table if not exists sales_email_sends (
  id uuid primary key default gen_random_uuid(),
  external_id text unique,                -- Smartlead stats_id
  lead_id uuid references sales_leads(id) on delete set null,
  lead_email text not null,
  lead_name text,
  campaign text not null,
  step integer,
  variant text,
  subject text,
  sent_at timestamptz not null,
  opened boolean not null default false,
  open_count integer not null default 0,
  replied boolean not null default false,
  bounced boolean not null default false,
  reply_type text,                        -- Positive | Neutral | Negative | Auto-reply | Bounce-back
  created_at timestamptz not null default now()
);
create index if not exists sales_email_sends_lead on sales_email_sends (lead_id);
create index if not exists sales_email_sends_sent on sales_email_sends (sent_at);

create table if not exists sales_calls (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references sales_leads(id) on delete set null,
  started_at timestamptz not null,
  ended_at timestamptz,
  seconds integer not null default 0,
  outcome text not null check (outcome in ('no_answer','voicemail','gatekeeper','connected','booked','not_fit','wrong_number','dnc')),
  note text,
  by_user uuid,
  created_at timestamptz not null default now()
);
create index if not exists sales_calls_lead on sales_calls (lead_id);
create index if not exists sales_calls_started on sales_calls (started_at);

create table if not exists sales_call_sessions (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  ended_at timestamptz,
  seconds integer not null default 0,
  by_user uuid,
  note text
);

create table if not exists sales_sources (
  key text primary key,
  label text not null,
  kind text not null default 'manual',   -- manual | api | csv
  monthly_cost numeric(10,2) not null default 0,
  one_time_cost numeric(10,2) not null default 0,
  per_lead_cost numeric(10,2) not null default 0,
  rev_share numeric(5,4) not null default 0,
  integration_status text not null default 'none',  -- none | planned | connected
  notes text
);
insert into sales_sources (key, label, kind, monthly_cost, one_time_cost, per_lead_cost, rev_share, notes) values
  ('cold_email', 'Cold email (Smartlead)', 'api', 450, 0, 0, 0, 'Smartlead + Apollo + Storeleads + domains'),
  ('cold_call', 'Cold calling', 'manual', 0, 0, 0, 0, 'Storeleads lists, dialed from the Calls tab'),
  ('fulfill_com', 'Fulfill.com referral network', 'manual', 249, 0, 50, 0.05, 'Per-lead fee $50–$500 on introduction; 5% of service fees for 36 months'),
  ('fulfilment_com', 'fulfilment.com (UK marketplace)', 'manual', 0, 2667.80, 0, 0, 'Listing fee billed as 3PLs.ai'),
  ('agency', 'Lead-gen agency (Alex Makowski)', 'manual', 0, 7500, 0, 0, ''),
  ('referral', 'Referral partners', 'manual', 0, 0, 0, 0, 'Felix/FCS, packaging reps, carrier reps, agencies'),
  ('inbound', 'Website / Google Business', 'manual', 0, 0, 0, 0, ''),
  ('linkedin', 'LinkedIn / founder content', 'manual', 0, 0, 0, 0, ''),
  ('other', 'Other', 'manual', 0, 0, 0, 0, '')
on conflict (key) do nothing;

-- ---------- RLS: owner only ----------
do $$
declare t text;
begin
  foreach t in array array['fin_transactions','fin_recurring','fin_pipeline','fin_settings','fin_qbo_status','fin_qbo_reports','sales_leads','sales_email_sends','sales_calls','sales_call_sessions','sales_sources'] loop
    execute format('alter table %I enable row level security', t);
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_owner_all') then
      execute format('create policy %I on %I for all using (is_owner()) with check (is_owner())', t || '_owner_all', t);
    end if;
  end loop;
end $$;
alter table fin_qbo_tokens enable row level security;   -- no policies: service role only

-- updated_at touch
create or replace function touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
do $$
declare t text;
begin
  foreach t in array array['fin_transactions','fin_pipeline','sales_leads'] loop
    if not exists (select 1 from pg_trigger where tgname = t || '_touch') then
      execute format('create trigger %I before update on %I for each row execute function touch_updated_at()', t || '_touch', t);
    end if;
  end loop;
end $$;
