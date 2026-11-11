-- Follow-ups (Derek, 2026-11-10 19:49 ET): every email a setter sends flags the lead for a follow-up.
-- Cadence (Claude's choice, Derek said "you decide"): 2 business days after the email, then 4, then 7. Three in all.
-- A follow-up is closed by: the setter's next email (which starts the next one), a call that reached a person,
-- Done (starts the next one), Stop, the lead replying / booking / going dead, or the lead leaving the setter.

create table if not exists public.sales_followups (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  n integer not null default 1,
  email_at timestamptz not null,
  due_on date not null,
  done_at timestamptz,
  done_how text,
  created_at timestamptz not null default now()
);
create unique index if not exists sales_followups_one_open on public.sales_followups (lead_id) where done_at is null;
create index if not exists sales_followups_owner_due on public.sales_followups (owner_id, due_on) where done_at is null;
create index if not exists sales_followups_owner_done on public.sales_followups (owner_id, done_at) where done_at is not null;
alter table public.sales_followups enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_followups' and policyname = 'sales_followups_read') then
    create policy sales_followups_read on public.sales_followups for select
      using (owner_id = auth.uid() or public.is_owner() or public.is_my_setter(owner_id));
  end if;
end $$;
revoke all on public.sales_followups from anon;
revoke insert, update, delete on public.sales_followups from authenticated;
grant select on public.sales_followups to authenticated;

create or replace function public._biz_add(p_from date, p_days integer) returns date
language plpgsql immutable as $$
declare d date := p_from; n int := 0;
begin
  while n < p_days loop d := d + 1; if extract(isodow from d) < 6 then n := n + 1; end if; end loop;
  return d;
end $$;

-- open the next follow-up in the chain (n = 1..3) for a lead still being worked
create or replace function public._followup_open(p_lead uuid, p_owner uuid, p_n integer, p_at timestamptz) returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_gap int := case p_n when 1 then 2 when 2 then 4 when 3 then 7 end;
begin
  if v_gap is null then return; end if;
  if not exists (select 1 from sales_leads where id = p_lead and stage in ('new', 'contacted')) then return; end if;
  insert into sales_followups (lead_id, owner_id, n, email_at, due_on)
  values (p_lead, p_owner, p_n, p_at, public._biz_add((p_at at time zone 'America/New_York')::date, v_gap))
  on conflict do nothing;
end $$;

-- a setter's email: closes the open follow-up and flags the next one
create or replace function public.followup_on_email() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_prev int;
begin
  if new.kind <> 'email_sent' or new.by_user is null or new.lead_id is null then return new; end if;
  if not exists (select 1 from profiles where id = new.by_user and role = 'shipbay_setter') then return new; end if;
  update sales_followups set done_at = now(), done_how = 'email' where lead_id = new.lead_id and done_at is null returning n into v_prev;
  perform public._followup_open(new.lead_id, new.by_user, coalesce(v_prev, 0) + 1, coalesce(new.at, now()));
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'sales_touches_followup' and tgrelid = 'public.sales_touches'::regclass) then
    create trigger sales_touches_followup after insert on public.sales_touches for each row execute function public.followup_on_email();
  end if;
end $$;

-- a call that reached a person is the follow-up
create or replace function public.followup_on_call() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.lead_id is not null and new.voided_at is null and new.outcome in ('gatekeeper', 'connected', 'booked', 'not_fit', 'dnc') then
    update sales_followups set done_at = now(), done_how = 'call' where lead_id = new.lead_id and done_at is null;
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'sales_calls_followup' and tgrelid = 'public.sales_calls'::regclass) then
    create trigger sales_calls_followup after insert on public.sales_calls for each row execute function public.followup_on_call();
  end if;
end $$;

-- the lead replied, booked, died, or left the setter: nothing left to follow up
create or replace function public.followup_on_lead() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.stage is distinct from old.stage and new.stage not in ('new', 'contacted') then
    update sales_followups set done_at = now(), done_how = new.stage where lead_id = new.id and done_at is null;
  elsif new.assigned_to is distinct from old.assigned_to then
    update sales_followups set done_at = now(), done_how = 'moved' where lead_id = new.id and done_at is null and owner_id is distinct from new.assigned_to;
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'sales_leads_followup' and tgrelid = 'public.sales_leads'::regclass) then
    create trigger sales_leads_followup after update on public.sales_leads for each row execute function public.followup_on_lead();
  end if;
end $$;

-- Done (followed up some other way: the next one is flagged) or Stop (no more follow-ups on this lead)
create or replace function public.followup_done(p_id uuid, p_stop boolean default false) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare f sales_followups%rowtype;
begin
  select * into f from sales_followups where id = p_id for update;
  if not found then raise exception 'Follow-up not found.'; end if;
  if f.owner_id <> auth.uid() and not public.is_owner() then raise exception 'That follow-up is not yours.' using errcode = '42501'; end if;
  if f.done_at is not null then return jsonb_build_object('ok', true, 'already', true); end if;
  update sales_followups set done_at = now(), done_how = case when p_stop then 'stopped' else 'done' end where id = p_id;
  if not p_stop then perform public._followup_open(f.lead_id, f.owner_id, f.n + 1, now()); end if;
  return jsonb_build_object('ok', true, 'next', (select due_on from sales_followups where lead_id = f.lead_id and done_at is null));
end $$;
revoke all on function public.followup_done(uuid, boolean) from public, anon;
grant execute on function public.followup_done(uuid, boolean) to authenticated;
revoke all on function public._followup_open(uuid, uuid, integer, timestamptz) from public, anon, authenticated;

-- emails setters already sent to leads still being worked
insert into public.sales_followups (lead_id, owner_id, n, email_at, due_on)
select distinct on (t.lead_id) t.lead_id, t.by_user, 1, t.at, public._biz_add((t.at at time zone 'America/New_York')::date, 2)
  from public.sales_touches t join public.profiles p on p.id = t.by_user and p.role = 'shipbay_setter'
  join public.sales_leads l on l.id = t.lead_id and l.stage in ('new', 'contacted') and l.assigned_to = t.by_user
 where t.kind = 'email_sent'
 order by t.lead_id, t.at desc
on conflict do nothing;
