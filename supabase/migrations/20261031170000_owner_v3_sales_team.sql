-- Owner v3: answered replies, lead assignment to sales reps, Calendly meetings, rep-level access to their own leads.
alter table sales_leads add column if not exists answered_at timestamptz;          -- we replied to their reply
alter table sales_leads add column if not exists assigned_to uuid references profiles(id);
alter table profiles add column if not exists is_sales boolean not null default false;
update profiles set is_sales = true where email in ('derekh@shipbay3pl.com', 'xavierd@shipbay3pl.com');

create table if not exists sales_meetings (
  id uuid primary key default gen_random_uuid(),
  external_id text unique,                 -- Calendly event uri
  source text not null default 'calendly',
  name text,                               -- event type name
  starts_at timestamptz not null,
  ends_at timestamptz,
  status text not null default 'active',   -- active | canceled | done | no_show
  invitee_name text,
  invitee_email text,
  location text,                           -- join link / phone
  lead_id uuid references sales_leads(id) on delete set null,
  assigned_to uuid references profiles(id),
  notes text,
  outcome text,                            -- after the call: quoted | not_fit | follow_up | signed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sales_meetings_start on sales_meetings (starts_at);
alter table sales_meetings enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'sales_meetings' and policyname = 'sales_meetings_owner_all') then
    create policy sales_meetings_owner_all on sales_meetings for all using (is_owner()) with check (is_owner());
  end if;
  -- sales reps: see and update what is assigned to them
  if not exists (select 1 from pg_policies where tablename = 'sales_meetings' and policyname = 'sales_meetings_rep') then
    create policy sales_meetings_rep on sales_meetings for all using (assigned_to = auth.uid()) with check (assigned_to = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'sales_leads' and policyname = 'sales_leads_rep') then
    create policy sales_leads_rep on sales_leads for all using (assigned_to = auth.uid()) with check (assigned_to = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'sales_calls' and policyname = 'sales_calls_rep') then
    create policy sales_calls_rep on sales_calls for all using (by_user = auth.uid()) with check (by_user = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'sales_email_sends' and policyname = 'sales_email_sends_rep') then
    create policy sales_email_sends_rep on sales_email_sends for select using (exists (select 1 from sales_leads l where l.id = sales_email_sends.lead_id and l.assigned_to = auth.uid()));
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'sales_meetings_touch') then
    create trigger sales_meetings_touch before update on sales_meetings for each row execute function touch_updated_at();
  end if;
end $$;

-- staff can see who the sales reps are (names for the assign dropdown): profiles already readable by staff via existing policies.
