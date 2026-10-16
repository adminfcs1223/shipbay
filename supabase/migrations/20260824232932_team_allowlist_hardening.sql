-- Only emails in team_members may use the CRM, even if public signups stay enabled.

create table if not exists public.team_members (
  email text primary key,
  added_at timestamptz not null default now()
);
alter table public.team_members enable row level security;
-- no policies: table is invisible to the API; manage it from the dashboard/SQL editor

create or replace function public.is_team()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.team_members
    where lower(email) = lower(coalesce(auth.jwt()->>'email',''))
  );
$$;

-- Seed the admin
insert into public.team_members (email) values
  ('derekh@fcsshipping.com'),
  ('derek@harrison-lewis.com')
on conflict do nothing;

-- Tighten lead access to approved team members
drop policy if exists "team can read leads" on public.leads;
drop policy if exists "team can update leads" on public.leads;
drop policy if exists "team can delete leads" on public.leads;
create policy "team can read leads"
  on public.leads for select to authenticated using (public.is_team());
create policy "team can update leads"
  on public.leads for update to authenticated using (public.is_team()) with check (public.is_team());
create policy "team can delete leads"
  on public.leads for delete to authenticated using (public.is_team());

drop policy if exists "team can read reps" on public.reps;
drop policy if exists "team can add reps" on public.reps;
drop policy if exists "team can update reps" on public.reps;
drop policy if exists "team can delete reps" on public.reps;
create policy "team can read reps"
  on public.reps for select to authenticated using (public.is_team());
create policy "team can add reps"
  on public.reps for insert to authenticated with check (public.is_team());
create policy "team can update reps"
  on public.reps for update to authenticated using (public.is_team()) with check (public.is_team());
create policy "team can delete reps"
  on public.reps for delete to authenticated using (public.is_team());
