-- Owner area v2: reply bodies on email sends, short list codes, strategies board, QuickBooks transactions in the ledger.
alter table sales_email_sends add column if not exists sl_lead_id text;
alter table sales_email_sends add column if not exists reply_subject text;
alter table sales_email_sends add column if not exists reply_body text;
alter table sales_email_sends add column if not exists reply_at timestamptz;

-- Lists: 'SL-A1-selfship-NJmetro-v2' → 'A1'
update sales_leads set filter_id = substring(filter_id from '^SL-([A-Z][0-9]+)-') where filter_id ~ '^SL-[A-Z][0-9]+-';

-- QuickBooks rows land in fin_transactions with source='qbo'; remember which account they hit
alter table fin_transactions add column if not exists account text;
alter table fin_transactions add column if not exists txn_type text;

create table if not exists sales_strategies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  channel text not null default 'mixed',       -- sales_sources.key or 'mixed'
  lists text[] not null default '{}',          -- list codes this play uses (A1, B1 …); empty = whole channel
  status text not null default 'active' check (status in ('idea','active','paused','done')),
  hypothesis text,                             -- one line: who we're going after and why it should work
  target text,                                 -- what "working" looks like, e.g. "2 booked calls / week"
  monthly_cost numeric(10,2) not null default 0,
  started date,
  notes text,
  log jsonb not null default '[]',             -- [{at, note}]
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table sales_strategies enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'sales_strategies' and policyname = 'sales_strategies_owner_all') then
    create policy sales_strategies_owner_all on sales_strategies for all using (is_owner()) with check (is_owner());
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'sales_strategies_touch') then
    create trigger sales_strategies_touch before update on sales_strategies for each row execute function touch_updated_at();
  end if;
end $$;

insert into sales_strategies (name, channel, lists, status, hypothesis, target, monthly_cost, started, notes) select * from (values
  ('Cold email — self-ship NJ brands', 'cold_email', '{A1}'::text[], 'active', 'Shopify brands within an hour of Hillsborough that still pack their own orders; local pickup + "only pay for what you use" is the hook.', '1%+ positive reply rate · 2 booked calls / week', 450, '2026-10-28'::date, 'Smartlead campaign 4039101, 6 mailboxes. Replies tagged in Sales → Email.'),
  ('Cold calling — Storeleads lists', 'cold_call', '{A1,A3,B1,C1,C2,A4,X0}'::text[], 'active', 'Same brands by phone; a founder picks up and a 3-minute conversation beats 5 emails.', '30+ dials / session · grade B or better on at least one list', 250, '2026-10-31'::date, 'Dialer TBD. Grades per list live in Sales → Calls.'),
  ('Fulfill.com referral network', 'fulfill_com', '{}'::text[], 'active', 'Brands already shopping for a 3PL get matched to us; we pay per intro + 5% for 36 months.', '1 qualified intro / month that converts within 60 days', 249, '2026-11-01'::date, 'Signed 10/30. Add each intro under Sales → Third party.'),
  ('fulfilment.com (UK) listing', 'fulfilment_com', '{}'::text[], 'active', 'UK/EU brands entering the US need an East-coast node; the listing puts ShipBay in front of them.', '1 inbound enquiry / month', 0, '2026-10-28'::date, 'One-time listing fee $2,667.80.'),
  ('Lead-gen agency (Alex Makowski)', 'agency', '{}'::text[], 'paused', 'Outsourced appointment setting.', 'Booked calls delivered vs the $7,500 paid', 0, '2026-09-02'::date, 'No leads logged yet — chase for a status report.')
) v(name, channel, lists, status, hypothesis, target, monthly_cost, started, notes) where not exists (select 1 from sales_strategies);
