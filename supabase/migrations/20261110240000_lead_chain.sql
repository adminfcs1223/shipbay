-- Lead → setter → closer (Derek, 2026-11-10 evening).
--   A lead is GIVEN to one setter (sales_leads.setter_id). Only that setter dials it.
--   A setter SETS FOR one closer (profiles.closer_id).
--   When the setter books the call, the lead moves to that closer (assigned_to) and keeps setter_id, so credit never moves.
-- Leads are handed out by the owner in random blocks of 100 from the unassigned call pool. Setters no longer see that pool.

alter table public.sales_leads add column if not exists setter_id uuid references public.profiles(id) on delete set null;
alter table public.sales_leads add column if not exists setter_assigned_at timestamptz;
create index if not exists sales_leads_setter_idx on public.sales_leads (setter_id) where setter_id is not null;

create or replace function public.is_my_setter(p uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from profiles where id = p and role = 'shipbay_setter' and closer_id = auth.uid())
$$;

-- setter_id keeps itself: whoever a lead is assigned to, if that is a setter, is its setter; a booking by a setter too.
-- Nobody but the owner can edit it by hand.
create or replace function public.sales_leads_chain() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if tg_op = 'UPDATE' and new.setter_id is distinct from old.setter_id and auth.uid() is not null and not public.is_owner() then
    new.setter_id := old.setter_id; new.setter_assigned_at := old.setter_assigned_at;
  end if;
  if new.assigned_to is not null and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to)
     and exists (select 1 from profiles where id = new.assigned_to and role = 'shipbay_setter') then
    new.setter_id := new.assigned_to; new.setter_assigned_at := now();
  end if;
  if new.setter_id is null and new.set_by is not null and exists (select 1 from profiles where id = new.set_by and role = 'shipbay_setter') then
    new.setter_id := new.set_by; new.setter_assigned_at := coalesce(new.setter_assigned_at, now());
  end if;
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'sales_leads_chain' and tgrelid = 'public.sales_leads'::regclass) then
    create trigger sales_leads_chain before insert or update on public.sales_leads for each row execute function public.sales_leads_chain();
  end if;
end $$;

update public.sales_leads l set setter_id = l.set_by, setter_assigned_at = coalesce(l.setter_assigned_at, l.updated_at)
 where l.setter_id is null and l.set_by is not null and exists (select 1 from public.profiles p where p.id = l.set_by and p.role = 'shipbay_setter');
update public.sales_leads l set setter_id = l.assigned_to, setter_assigned_at = coalesce(l.setter_assigned_at, l.updated_at)
 where l.setter_id is null and exists (select 1 from public.profiles p where p.id = l.assigned_to and p.role = 'shipbay_setter');

-- A setter works the leads given to them, nothing from the shared pool. Closers and the owner are unchanged.
alter policy sales_leads_rep on public.sales_leads
  using (public.is_sales_team() and (assigned_to = auth.uid() or (assigned_to is null and stage = 'new' and not public.is_setter())))
  with check (public.is_sales_team() and assigned_to = auth.uid());

-- Read-only: a setter still sees a lead after it moves to the closer; a closer sees what their setters are working.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_leads' and policyname = 'sales_leads_chain_read') then
    create policy sales_leads_chain_read on public.sales_leads for select
      using (setter_id is not null and (setter_id = auth.uid() or public.is_my_setter(setter_id)));
  end if;
end $$;

create or replace function public._can_work_lead(p_uid uuid, p_lead sales_leads) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select coalesce((select is_owner from profiles where id = p_uid), false)
      or (p_lead.assigned_to is null and not exists (select 1 from profiles s where s.id = p_uid and s.role = 'shipbay_setter'))
      or coalesce(p_lead.assigned_to = p_uid, false)      -- never null: "not null" would let the caller through
      or exists (select 1 from profiles s where s.id = p_uid and s.role = 'shipbay_setter' and s.closer_id = p_lead.assigned_to)
      or exists (select 1 from sales_meetings m where m.lead_id = p_lead.id and m.booked_by = p_uid)
$$;

-- Hand a setter a random block of leads from the unassigned call pool. Blocks of 100.
create or replace function public.assign_leads(p_setter uuid, p_count integer, p_list text default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_n int; v_pool int;
begin
  if not public.is_owner() then raise exception 'Only the owner hands out leads.' using errcode = '42501'; end if;
  if not exists (select 1 from profiles where id = p_setter and role = 'shipbay_setter' and active is not false) then raise exception 'Pick an active appointment setter.'; end if;
  if p_count is null or p_count < 100 or p_count > 2000 or p_count % 100 <> 0 then raise exception 'Leads go out in blocks of 100.'; end if;
  p_list := nullif(btrim(coalesce(p_list, '')), '');
  with pick as (
    select id from sales_leads
     where in_calls and nullif(btrim(phone), '') is not null and assigned_to is null and stage = 'new' and (p_list is null or filter_id = p_list)
     order by random() limit p_count for update skip locked)
  update sales_leads l set assigned_to = p_setter from pick where l.id = pick.id;
  get diagnostics v_n = row_count;
  select count(*) into v_pool from sales_leads where in_calls and nullif(btrim(phone), '') is not null and assigned_to is null and stage = 'new';
  return jsonb_build_object('assigned', v_n, 'asked', p_count, 'pool', v_pool);
end $$;

-- Take back leads a setter has not dialed yet (all of them, or a number). They return to the pool.
create or replace function public.release_leads(p_setter uuid, p_count integer default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_n int;
begin
  if not public.is_owner() then raise exception 'Only the owner takes leads back.' using errcode = '42501'; end if;
  with pick as (
    select id from sales_leads where assigned_to = p_setter and stage = 'new' and coalesce(attempts, 0) = 0
     order by random() limit coalesce(p_count, 100000) for update skip locked)
  update sales_leads l set assigned_to = null, setter_id = null, setter_assigned_at = null from pick where l.id = pick.id;
  get diagnostics v_n = row_count;
  return jsonb_build_object('released', v_n);
end $$;

-- The setters' own scoreboard: every setter, ranked, headline numbers only (no notes, no names of who was called).
create or replace function public.setter_scoreboard(p_days integer default 7) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare uid uuid := auth.uid(); v_owner boolean; v_since timestamptz; v_today timestamptz; v_rows jsonb; v_pool jsonb;
begin
  if uid is null or not public.is_sales_team() then raise exception 'Sales team only.' using errcode = '42501'; end if;
  v_owner := public.is_owner();
  p_days := least(120, greatest(1, coalesce(p_days, 7)));
  v_today := date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York';
  v_since := v_today - make_interval(days => p_days - 1);
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rows from (
    select jsonb_build_object(
      'id', p.id, 'name', coalesce(nullif(p.full_name, ''), p.email), 'closer_id', p.closer_id,
      'closer', (select coalesce(nullif(c.full_name, ''), c.email) from profiles c where c.id = p.closer_id),
      'calls', (select jsonb_build_object('dials', count(*), 'connects', count(*) filter (where c.outcome in ('gatekeeper', 'connected', 'booked', 'not_fit', 'dnc')),
                                          'dm', count(*) filter (where c.dial_result = 'decision_maker'),
                                          'today', count(*) filter (where c.started_at >= v_today), 'last_call_at', max(c.started_at))
                  from sales_calls c where c.by_user = p.id and c.voided_at is null and c.started_at >= v_since),
      'meetings', (select jsonb_build_object('booked', count(*) filter (where m.status <> 'canceled'), 'canceled', count(*) filter (where m.status = 'canceled'),
                                             'booked_today', count(*) filter (where m.status <> 'canceled' and m.booked_at >= v_today),
                                             'upcoming', count(*) filter (where m.status <> 'canceled' and m.starts_at >= now()),
                                             'held', count(*) filter (where m.status <> 'canceled' and m.starts_at < now() and m.outcome is not null and m.outcome <> 'no_show'),
                                             'no_show', count(*) filter (where m.outcome = 'no_show'))
                     from sales_meetings m where m.booked_by = p.id and m.booked_at >= v_since),
      'session_seconds', (select coalesce(sum(least(28800, coalesce(s.seconds, extract(epoch from (coalesce(s.ended_at, now()) - s.started_at))::int))), 0) from sales_call_sessions s where s.by_user = p.id and s.started_at >= v_since),
      'leads', (select jsonb_build_object('given', count(*),
                                          'untouched', count(*) filter (where l.assigned_to = p.id and l.stage = 'new' and coalesce(l.attempts, 0) = 0),
                                          'working', count(*) filter (where l.assigned_to = p.id and not (l.stage = 'new' and coalesce(l.attempts, 0) = 0) and l.stage not in ('dnc', 'lost', 'signed')),
                                          'dead', count(*) filter (where l.assigned_to = p.id and l.stage in ('dnc', 'lost')),
                                          'with_closer', count(*) filter (where l.assigned_to is distinct from p.id and l.stage not in ('signed', 'dnc', 'lost')),
                                          'won', count(*) filter (where l.stage = 'signed'))
                  from sales_leads l where l.setter_id = p.id)
    ) x
    from profiles p where p.role = 'shipbay_setter' and p.active is not false
    order by coalesce(nullif(p.full_name, ''), p.email)
  ) t;
  if v_owner then
    select jsonb_build_object('total', coalesce(sum(n), 0), 'lists', coalesce(jsonb_agg(jsonb_build_object('list', f, 'n', n) order by n desc), '[]'::jsonb)) into v_pool
      from (select coalesce(filter_id, '') f, count(*) n from sales_leads where in_calls and nullif(btrim(phone), '') is not null and assigned_to is null and stage = 'new' group by 1) s;
  end if;
  return jsonb_build_object('days', p_days, 'since', v_since, 'setters', v_rows, 'pool', v_pool, 'me', uid);
end $$;

revoke all on function public.assign_leads(uuid, integer, text) from public, anon;
revoke all on function public.release_leads(uuid, integer) from public, anon;
revoke all on function public.setter_scoreboard(integer) from public, anon;
revoke all on function public.is_my_setter(uuid) from public, anon;
grant execute on function public.assign_leads(uuid, integer, text) to authenticated;
grant execute on function public.release_leads(uuid, integer) to authenticated;
grant execute on function public.setter_scoreboard(integer) to authenticated;
grant execute on function public.is_my_setter(uuid) to authenticated;

-- The team booking link the emails use (was empty, so {booking} printed nothing). Derek's one Calendly event.
update public.fin_settings set value = jsonb_build_object('url', 'https://calendly.com/derekh-shipbay3pl/30min')
 where key = 'booking_link' and coalesce(value->>'url', '') = '';
