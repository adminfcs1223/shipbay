-- Careers: job postings shown on shipbay3pl.com/careers, edited in the portal (Admin → Admin settings → Careers),
-- and applications sent from the site. Connector-safe form (no DROP / DELETE).

create table if not exists public.job_postings (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  team text,
  location text,
  work_mode text,
  employment_type text,
  pay text,                                   -- free text, e.g. "$19/hr" or "$45k base + commission"; blank = not shown
  schedule text,
  summary text,
  description text,
  responsibilities text[] not null default '{}',
  requirements text[] not null default '{}',
  status text not null default 'open' check (status in ('open', 'paused', 'closed')),  -- only 'open' shows on the site
  sort int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.job_applications (
  id uuid primary key default gen_random_uuid(),
  posting_id uuid references public.job_postings(id) on delete set null,
  posting_title text,
  name text not null check (char_length(name) between 1 and 200),
  email text not null check (char_length(email) between 3 and 320),
  phone text check (phone is null or char_length(phone) <= 40),
  city text check (city is null or char_length(city) <= 200),
  link text check (link is null or char_length(link) <= 500),
  message text check (message is null or char_length(message) <= 5000),
  status text not null default 'new' check (status in ('new', 'reviewed', 'interview', 'hired', 'rejected')),
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists job_applications_posting_idx on public.job_applications (posting_id, created_at desc);

create or replace trigger job_postings_touch before update on public.job_postings
  for each row execute function public.touch_updated_at();

alter table public.job_postings enable row level security;
alter table public.job_applications enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'job_postings' and policyname = 'job_postings_public_read') then
    create policy job_postings_public_read on public.job_postings for select to anon, authenticated using (status = 'open');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'job_postings' and policyname = 'job_postings_owner_all') then
    create policy job_postings_owner_all on public.job_postings for all to authenticated using (public.is_owner()) with check (public.is_owner());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'job_applications' and policyname = 'job_applications_public_insert') then
    create policy job_applications_public_insert on public.job_applications for insert to anon, authenticated
      with check (status = 'new' and notes is null and exists (select 1 from public.job_postings p where p.id = posting_id and p.status = 'open'));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'job_applications' and policyname = 'job_applications_owner_all') then
    create policy job_applications_owner_all on public.job_applications for all to authenticated using (public.is_owner()) with check (public.is_owner());
  end if;
end $$;

grant select on public.job_postings to anon, authenticated;
grant insert on public.job_applications to anon, authenticated;
grant all on public.job_postings, public.job_applications to authenticated;

-- The two openings Derek asked for (2026-11-08). Pay and employment type are left blank on purpose — set them in Admin.
insert into public.job_postings (slug, title, team, location, work_mode, schedule, summary, description, responsibilities, requirements, sort)
values
('sales', 'Sales representative', 'Sales', 'Hillsborough, NJ or remote', 'In person or virtual', null,
 'Work leads from the first call to a signed account, for ecommerce brands that need fulfillment.',
 'You''ll sell ShipBay''s fulfillment to direct-to-consumer brands, working alongside the founder. Every lead lives in shipbay.dashboard, so you see your own pipeline, your calls and your numbers. Work from the Hillsborough office or from home.',
 array['Call and email the leads in your queue every day',
       'Run discovery calls: orders a month, SKUs, how the brand ships today',
       'Build quotes from the ShipBay rate card inside the dashboard',
       'Log every call and follow-up so the pipeline stays accurate',
       'Hand signed brands over to onboarding'],
 array['Comfortable on the phone with business owners',
       'Organized: you follow up when you said you would',
       'Sales or ecommerce experience is a plus'],
 10),
('warehouse-associate', 'Warehouse associate', 'Warehouse', 'Hillsborough, NJ', 'In person', 'Warehouse hours: Mon–Sat, 9am–6pm',
 'Receive, store, pick, pack and ship orders for the brands we fulfill.',
 'You''ll run the floor at our Hillsborough warehouse: stock coming in, orders going out the same day. Everything is scanned through shipbay.dashboard, so you always know what''s next.',
 array['Receive inbound pallets and cartons and count them in by SKU',
       'Put stock away in its location',
       'Pick and pack orders and get them out by the 2pm same-day cutoff',
       'Print labels and hand packages off to carriers',
       'Keep the floor clean and organized'],
 array['Detail-oriented: the right item in the right box, every time',
       'Comfortable on your feet and lifting boxes through the day',
       'Reliable on schedule'],
 20)
on conflict (slug) do nothing;
