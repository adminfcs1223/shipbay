-- shiphl. CRM schema: leads pipeline + sales team roster

create table if not exists public.leads (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  name          text not null,
  brand         text not null,
  email         text not null,
  phone         text,
  volume        text,
  current_setup text,
  notes         text,
  slot          text,
  source        text not null default 'website',
  stage         text not null default 'new'
                check (stage in ('new','contacted','booked','proposal','won','lost')),
  rep           uuid,
  activity      jsonb not null default '[]'::jsonb
);

alter table public.leads enable row level security;

create policy "website can submit leads"
  on public.leads for insert to anon with check (true);
create policy "team can read leads"
  on public.leads for select to authenticated using (true);
create policy "team can update leads"
  on public.leads for update to authenticated using (true) with check (true);
create policy "team can delete leads"
  on public.leads for delete to authenticated using (true);

create table if not exists public.reps (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name       text not null,
  color      text not null default '#D9611F'
);

alter table public.reps enable row level security;

create policy "team can read reps"
  on public.reps for select to authenticated using (true);
create policy "team can add reps"
  on public.reps for insert to authenticated with check (true);
create policy "team can update reps"
  on public.reps for update to authenticated using (true) with check (true);
create policy "team can delete reps"
  on public.reps for delete to authenticated using (true);

insert into public.reps (name, color) values
  ('Sales Rep 1', '#D9611F'),
  ('Sales Rep 2', '#1E9E6F'),
  ('Sales Rep 3', '#4F5DEF'),
  ('Sales Rep 4', '#B54F17');

alter publication supabase_realtime add table public.leads;
