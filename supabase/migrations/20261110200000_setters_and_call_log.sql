-- Appointment setters, a server-side call log, and booking from the portal. (Derek, 2026-11-10)
--
-- What this adds
--   * role shipbay_setter + profiles.closer_id (the closer a setter books for)
--   * sales_scripts (team call script + a personal copy each), sales_availability (a closer's bookable hours)
--   * log_call(jsonb)      one transaction per dial: the call row, every effect on the lead, an optional booking. Idempotent on client_id.
--   * book_meeting(jsonb)  books a call on a closer's calendar; refuses a double-booking; one live booking per lead
--   * open_slots(...)      a closer's free times from their hours minus what is already on their calendar
--   * cancel_meeting, void_call, call_email_result, setter_board
-- Additive and connector-safe: create-or-replace, guarded policies. Section 9b (commented) closes direct inserts to
-- sales_calls; apply it once every open portal tab is on the build that uses log_call.

-- ============================================================ 1. the setter role
alter table public.profiles add column if not exists closer_id uuid references public.profiles(id) on delete set null;
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('shipbay_admin', 'shipbay_staff', 'shipbay_setter', 'client_admin', 'client_user'));

create or replace function public.is_setter() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'shipbay_setter' and active is not false from profiles where id = auth.uid()), false)
$$;

-- closers, the owner, and setters
create or replace function public.is_sales_team() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (is_sales or is_owner or role = 'shipbay_setter') and active is not false from profiles where id = auth.uid()), false)
$$;

-- someone a call can be booked for
create or replace function public.is_closer(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = p and active is not false and (is_sales or is_owner) and role in ('shipbay_admin', 'shipbay_staff'))
$$;

-- ============================================================ 2. columns
alter table public.sales_leads add column if not exists set_by uuid references public.profiles(id) on delete set null;

alter table public.sales_meetings
  add column if not exists booked_by uuid references public.profiles(id) on delete set null,
  add column if not exists booked_at timestamptz,
  add column if not exists call_id uuid,
  add column if not exists invite_sent_at timestamptz,
  add column if not exists invite_error text,
  add column if not exists canceled_at timestamptz,
  add column if not exists canceled_by uuid,
  add column if not exists cancel_reason text;
create index if not exists sales_meetings_closer_time on public.sales_meetings (assigned_to, starts_at);
create index if not exists sales_meetings_booked_by on public.sales_meetings (booked_by, booked_at desc);

alter table public.sales_calls
  add column if not exists client_id uuid,
  add column if not exists session_id uuid references public.sales_call_sessions(id) on delete set null,
  add column if not exists meeting_id uuid references public.sales_meetings(id) on delete set null,
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid,
  add column if not exists void_reason text;
create unique index if not exists sales_calls_client_id_key on public.sales_calls (client_id) where client_id is not null;
create index if not exists sales_calls_by_user_time on public.sales_calls (by_user, started_at desc);

-- ============================================================ 3. scripts + availability
create table if not exists public.sales_scripts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.profiles(id) on delete cascade,     -- null = the team script
  body text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
create unique index if not exists sales_scripts_one_each on public.sales_scripts (owner_id) where owner_id is not null;
create unique index if not exists sales_scripts_one_team on public.sales_scripts ((true)) where owner_id is null;
alter table public.sales_scripts enable row level security;

create table if not exists public.sales_availability (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  tz text not null default 'America/New_York',
  days int[] not null default '{1,2,3,4,5}',          -- ISO weekday, 1 = Monday
  start_min int not null default 540 check (start_min between 0 and 1439),
  end_min int not null default 1020 check (end_min between 1 and 1440),
  slot_min int not null default 20 check (slot_min between 5 and 240),
  step_min int not null default 30 check (step_min between 5 and 240),
  notice_min int not null default 60 check (notice_min >= 0),
  horizon_days int not null default 14 check (horizon_days between 1 and 90),
  location text,
  updated_at timestamptz not null default now(),
  check (end_min > start_min)
);
alter table public.sales_availability enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_scripts' and policyname = 'sales_scripts_team_read') then
    create policy sales_scripts_team_read on public.sales_scripts for select using (public.is_sales_team());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_scripts' and policyname = 'sales_scripts_own') then
    create policy sales_scripts_own on public.sales_scripts for all using (owner_id = auth.uid() and public.is_sales_team()) with check (owner_id = auth.uid() and public.is_sales_team());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_scripts' and policyname = 'sales_scripts_owner_all') then
    create policy sales_scripts_owner_all on public.sales_scripts for all using (public.is_owner()) with check (public.is_owner());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_availability' and policyname = 'sales_availability_team_read') then
    create policy sales_availability_team_read on public.sales_availability for select using (public.is_sales_team());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_availability' and policyname = 'sales_availability_own') then
    create policy sales_availability_own on public.sales_availability for all using (user_id = auth.uid() and public.is_sales()) with check (user_id = auth.uid() and public.is_sales());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_availability' and policyname = 'sales_availability_owner_all') then
    create policy sales_availability_owner_all on public.sales_availability for all using (public.is_owner()) with check (public.is_owner());
  end if;
  -- setters can see who is on the sales team (names for "book it for", their closer)
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'sales_team_profiles') then
    create policy sales_team_profiles on public.profiles for select using (public.is_sales_team() and role like 'shipbay%');
  end if;
  -- a setter keeps sight of the calls they booked after the lead moves to the closer
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_meetings' and policyname = 'sales_meetings_booker') then
    create policy sales_meetings_booker on public.sales_meetings for select using (booked_by = auth.uid());
  end if;
end $$;

-- setters work the same pool a rep does: the untouched leads and their own
alter policy sales_leads_rep on public.sales_leads
  using (public.is_sales_team() and (assigned_to = auth.uid() or (assigned_to is null and stage = 'new')))
  with check (public.is_sales_team() and assigned_to = auth.uid());
alter policy sales_sources_rep on public.sales_sources using (public.is_sales_team());
alter policy fin_settings_sales_goals on public.fin_settings using (public.is_sales_team() and key = any (array['sales_goals', 'booking_link']));

-- the team script every new setter starts from (draft: edit it in Appt. Setting → Calls → Script)
insert into public.sales_scripts (owner_id, body)
select null, E'OPEN\nHi {first}, it''s {me} at ShipBay in Hillsborough, New Jersey. Did I catch you with thirty seconds?\n\nWHY I''M CALLING\nWe pick, pack and ship orders for brands like {company}. No order minimums, no setup fee, and postage stays on your own carrier account. Orders in by 2pm Eastern go out the same day.\n\nASK (these are the debrief answers)\n1. Who ships your orders today: you, a 3PL, or Amazon?\n2. Roughly how many orders a month?\n3. What is the worst part of it right now: space, time, cost, or the holidays?\n\nBOOK IT\nThe next step is 15 minutes with {closer}. They price your actual month on the call. I have a couple of times open: which works?\n(Press "Book a call" while they are on the line.)\n\nIF THEY SAY\n"Send me something": Happy to. What is the best email? I will send it right after this call, and can I put 20 minutes on the calendar so you have the numbers in front of you?\n"We already use a 3PL": Understood. Who are you with? (Log it: Not a fit → Already on a 3PL.)\n"Not interested": No problem. If that changes we are at shipbay3pl.com. (Soft no. If they say never call again: Hard no.)\n\nVOICEMAIL\nHi {first}, {me} at ShipBay in Hillsborough, New Jersey. We ship orders for small brands: no minimums, same-day on a 2pm cutoff. I will send a short email as well.'
where not exists (select 1 from public.sales_scripts where owner_id is null);

-- ============================================================ 4. booking
-- who may act on a lead: the owner, whoever it is assigned to, anyone if it is unassigned,
-- a setter on their closer's lead, and whoever booked its call
create or replace function public._can_work_lead(p_uid uuid, p_lead public.sales_leads) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_owner from profiles where id = p_uid), false)
      or p_lead.assigned_to is null
      or p_lead.assigned_to = p_uid
      or exists (select 1 from profiles s where s.id = p_uid and s.role = 'shipbay_setter' and s.closer_id = p_lead.assigned_to)
      or exists (select 1 from sales_meetings m where m.lead_id = p_lead.id and m.booked_by = p_uid)
$$;

create or replace function public._book_meeting(p_uid uuid, p_lead uuid, p_closer uuid, p_starts timestamptz, p_minutes int, p_note text, p_email text, p_call uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_lead sales_leads%rowtype; v_me profiles%rowtype; v_closer profiles%rowtype; v_av sales_availability%rowtype;
  v_ends timestamptz; v_id uuid; v_tz text; v_first text;
begin
  if p_starts is null then raise exception 'Pick a time.'; end if;
  if p_starts < now() - interval '2 minutes' then raise exception 'That time has already passed.'; end if;
  if p_starts > now() + interval '120 days' then raise exception 'That is more than four months out.'; end if;
  select * into v_me from profiles where id = p_uid;
  if p_closer is null then p_closer := case when v_me.role = 'shipbay_setter' then v_me.closer_id else p_uid end; end if;
  if p_closer is null then raise exception 'You have no closer assigned yet. Ask Derek to set it under Admin → Team.'; end if;
  if not public.is_closer(p_closer) then raise exception 'Pick someone on the sales team to take the call.'; end if;
  select * into v_closer from profiles where id = p_closer;
  v_first := split_part(coalesce(nullif(v_closer.full_name, ''), v_closer.email), ' ', 1);
  if v_me.role = 'shipbay_setter' and v_me.closer_id is not null and p_closer <> v_me.closer_id then
    raise exception 'You book calls for %.', (select split_part(coalesce(nullif(full_name, ''), email), ' ', 1) from profiles where id = v_me.closer_id);
  end if;
  select * into v_av from sales_availability where user_id = p_closer;
  v_tz := coalesce(v_av.tz, 'America/New_York');
  p_minutes := least(240, greatest(5, coalesce(p_minutes, v_av.slot_min, 20)));
  v_ends := p_starts + make_interval(mins => p_minutes);

  select * into v_lead from sales_leads where id = p_lead for update;
  if not found then raise exception 'Lead not found.'; end if;
  if not public._can_work_lead(p_uid, v_lead) then raise exception 'That lead belongs to someone else now.' using errcode = '42501'; end if;
  if v_lead.stage = 'dnc' then raise exception 'This lead is marked do-not-contact.'; end if;
  p_email := nullif(lower(btrim(coalesce(p_email, ''))), '');
  if p_email is not null and p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That does not look like an email address.'; end if;

  -- one booking at a time per closer: two setters clicking the same slot cannot both win
  perform pg_advisory_xact_lock(hashtextextended('book:' || p_closer::text, 0));
  if exists (select 1 from sales_meetings m
              where m.assigned_to = p_closer and m.status <> 'canceled' and coalesce(m.all_day, false) = false
                and m.starts_at < v_ends and coalesce(m.ends_at, m.starts_at + interval '30 minutes') > p_starts
                and not (m.lead_id = p_lead and m.source = 'portal')) then
    raise exception '% already has a call then. Pick another time.', v_first using errcode = '23P01';
  end if;
  -- a lead holds one live portal booking: booking again moves it
  update sales_meetings set status = 'canceled', canceled_at = now(), canceled_by = p_uid, cancel_reason = 'rebooked'
   where lead_id = p_lead and source = 'portal' and status = 'active' and starts_at > now();

  insert into sales_meetings (external_id, source, name, starts_at, ends_at, status, invitee_name, invitee_email, location, lead_id, assigned_to, notes, booked_by, booked_at, call_id)
  values ('portal:' || gen_random_uuid(), 'portal',
          'Discovery call — ' || coalesce(nullif(v_lead.company, ''), nullif(v_lead.domain, ''), v_lead.email, 'lead'),
          p_starts, v_ends, 'active', v_lead.contact_name, coalesce(p_email, v_lead.email), v_av.location, p_lead, p_closer,
          nullif(concat_ws(E'\n', case when p_uid <> p_closer then 'Booked by ' || coalesce(nullif(v_me.full_name, ''), v_me.email) end, nullif(btrim(coalesce(p_note, '')), '')), ''),
          p_uid, now(), p_call)
  returning id into v_id;

  update sales_leads
     set assigned_to = p_closer,
         stage = case when stage in ('new', 'contacted', 'replied', 'call_booked', 'lost') then 'call_booked' else stage end,
         next_action_at = p_starts, last_touch_at = now(),
         set_by = case when p_uid <> p_closer then p_uid else set_by end,
         email = coalesce(nullif(email, ''), p_email)
   where id = p_lead;

  insert into sales_touches (lead_id, kind, note, at, by_user)
  values (p_lead, 'meeting_note', 'Booked a call' || case when p_uid <> p_closer then ' for ' || v_first else '' end || ' · ' || to_char(p_starts at time zone v_tz, 'Dy Mon FMDD, FMHH12:MI AM'), now(), p_uid);

  return (select to_jsonb(m) || jsonb_build_object('closer_name', coalesce(nullif(v_closer.full_name, ''), v_closer.email), 'closer_email', v_closer.email, 'tz', v_tz, 'company', v_lead.company)
            from sales_meetings m where m.id = v_id);
end $$;

create or replace function public.book_meeting(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_sales_team() then raise exception 'Sales team only.' using errcode = '42501'; end if;
  return public._book_meeting(auth.uid(), (p->>'lead_id')::uuid, nullif(p->>'closer_id', '')::uuid, nullif(p->>'starts_at', '')::timestamptz,
                              nullif(p->>'minutes', '')::int, p->>'note', p->>'invitee_email', null);
end $$;

create or replace function public.open_slots(p_closer uuid, p_from date default null, p_days int default 7)
returns table (slot timestamptz, minutes int)
language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text := 'America/New_York'; v_dow int[] := '{1,2,3,4,5}'; v_start int := 540; v_end int := 1020;
  v_len int := 20; v_step int := 30; v_notice int := 60; v_horizon int := 14; v_from date;
begin
  if auth.uid() is null or not public.is_sales_team() then raise exception 'Sales team only.' using errcode = '42501'; end if;
  select a.tz, a.days, a.start_min, a.end_min, a.slot_min, a.step_min, a.notice_min, a.horizon_days
    into v_tz, v_dow, v_start, v_end, v_len, v_step, v_notice, v_horizon
    from sales_availability a where a.user_id = p_closer;
  if not found then
    v_tz := 'America/New_York'; v_dow := '{1,2,3,4,5}'; v_start := 540; v_end := 1020; v_len := 20; v_step := 30; v_notice := 60; v_horizon := 14;
  end if;
  v_from := coalesce(p_from, (now() at time zone v_tz)::date);
  p_days := least(31, greatest(1, coalesce(p_days, 7)));
  return query
  with days as (select gs::date as d from generate_series(v_from::timestamp, (v_from + (p_days - 1))::timestamp, interval '1 day') gs),
  cand as (
    select ((days.d::timestamp + make_interval(mins => m)) at time zone v_tz) as s
      from days cross join generate_series(v_start, v_end - v_len, v_step) m
     where extract(isodow from days.d)::int = any (v_dow)
  )
  select c.s, v_len from cand c
   where c.s >= now() + make_interval(mins => v_notice)
     and c.s <= now() + make_interval(days => v_horizon)
     and not exists (select 1 from sales_meetings mt
                      where mt.assigned_to = p_closer and mt.status <> 'canceled' and coalesce(mt.all_day, false) = false
                        and mt.starts_at < c.s + make_interval(mins => v_len)
                        and coalesce(mt.ends_at, mt.starts_at + interval '30 minutes') > c.s)
   order by c.s;
end $$;

create or replace function public.cancel_meeting(p_meeting uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m sales_meetings%rowtype; uid uuid := auth.uid();
begin
  if uid is null or not public.is_sales_team() then raise exception 'Sales team only.' using errcode = '42501'; end if;
  select * into m from sales_meetings where id = p_meeting for update;
  if not found then raise exception 'Call not found.'; end if;
  if not (public.is_owner() or m.assigned_to = uid or m.booked_by = uid) then raise exception 'Only whoever booked it or takes it can cancel it.' using errcode = '42501'; end if;
  if m.status = 'canceled' then return to_jsonb(m); end if;
  update sales_meetings set status = 'canceled', canceled_at = now(), canceled_by = uid, cancel_reason = nullif(btrim(coalesce(p_reason, '')), '') where id = p_meeting returning * into m;
  if m.lead_id is not null then
    update sales_leads set next_action_at = now(), last_touch_at = now()
     where id = m.lead_id and stage = 'call_booked'
       and not exists (select 1 from sales_meetings x where x.lead_id = m.lead_id and x.status = 'active' and x.starts_at > now());
    insert into sales_touches (lead_id, kind, note, at, by_user)
    values (m.lead_id, 'meeting_note', 'Canceled the call' || coalesce(' · ' || nullif(btrim(coalesce(p_reason, '')), ''), ''), now(), uid);
  end if;
  return to_jsonb(m);
end $$;

-- ============================================================ 5. the call log
create or replace function public.log_call(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  v_client uuid; v_session uuid; v_meeting uuid;
  v_lead sales_leads%rowtype; v_call sales_calls%rowtype; v_mtg sales_meetings%rowtype;
  v_dial text := nullif(p->>'dial_result', '');
  v_result text := nullif(p->>'result', '');
  v_fit text := nullif(p->>'fit', '');
  v_picked text := nullif(p->>'picked_up', '');
  v_setup text := nullif(p->>'current_setup', '');
  v_pain text := nullif(p->>'pain', '');
  v_nfr text; v_nfd text;
  v_outcome text;
  v_now timestamptz := now();
  v_started timestamptz; v_seconds int; v_callback timestamptz; v_orders int;
  v_note text := nullif(btrim(left(coalesce(p->>'note', ''), 2000)), '');
  v_email text := nullif(lower(btrim(coalesce(p->>'to_email', ''))), '');
  v_next timestamptz; v_attempts int; v_stage text; v_in_calls boolean; v_in_email boolean; v_tags text[]; v_notes text;
  v_book jsonb := p->'book'; v_m jsonb;
  v_day text := to_char(now() at time zone 'America/New_York', 'FMMM/FMDD/YYYY');
  v_dial_lbl text; v_res_lbl text;
begin
  if uid is null or not public.is_sales_team() then raise exception 'Sales team only.' using errcode = '42501'; end if;
  begin v_client := nullif(p->>'client_id', '')::uuid; exception when others then v_client := null; end;
  begin v_session := nullif(p->>'session_id', '')::uuid; exception when others then v_session := null; end;
  begin v_meeting := nullif(p->>'meeting_id', '')::uuid; exception when others then v_meeting := null; end;

  if v_dial is not null and v_dial not in ('no_answer', 'voicemail', 'bad_number', 'gatekeeper', 'decision_maker') then raise exception 'Unknown dial result: %', v_dial; end if;
  if v_result is not null and v_result not in ('booked', 'callback', 'send_info', 'soft_no', 'hard_no') then raise exception 'Unknown outcome: %', v_result; end if;
  if v_fit is not null and v_fit not in ('fit', 'not_fit', 'unknown') then raise exception 'Unknown fit: %', v_fit; end if;

  -- the outcome the boards and stages run on. A booking or a hard no counts whoever picked up.
  v_outcome := case
    when v_dial = 'no_answer' then 'no_answer'
    when v_dial = 'voicemail' then 'voicemail'
    when v_dial = 'bad_number' then 'wrong_number'
    when v_dial in ('gatekeeper', 'decision_maker') and v_result = 'booked' then 'booked'
    when v_dial in ('gatekeeper', 'decision_maker') and v_result = 'hard_no' then 'dnc'
    when v_dial = 'gatekeeper' then 'gatekeeper'
    when v_dial = 'decision_maker' and v_fit = 'not_fit' then 'not_fit'
    when v_dial = 'decision_maker' then 'connected'
    else nullif(p->>'outcome', '') end;
  if v_outcome is null or v_outcome not in ('no_answer', 'voicemail', 'gatekeeper', 'connected', 'booked', 'not_fit', 'wrong_number', 'dnc') then
    raise exception 'Pick a dial result.';
  end if;

  select * into v_lead from sales_leads where id = (p->>'lead_id')::uuid for update;
  if not found then raise exception 'Lead not found.'; end if;
  -- the same save arriving twice (a retry after a dropped connection) is one call
  if v_client is not null then
    select * into v_call from sales_calls where client_id = v_client;
    if found then return jsonb_build_object('call_id', v_call.id, 'outcome', v_call.outcome, 'meeting_id', v_call.meeting_id, 'duplicate', true); end if;
  end if;
  if not public._can_work_lead(uid, v_lead) then raise exception 'That lead belongs to someone else now.' using errcode = '42501'; end if;

  -- times come from the browser; keep them sane
  begin v_started := nullif(p->>'started_at', '')::timestamptz; exception when others then v_started := null; end;
  if v_started is null or v_started > v_now + interval '5 minutes' or v_started < v_now - interval '12 hours' then v_started := v_now; end if;
  v_seconds := least(14400, greatest(0, coalesce(nullif(p->>'seconds', '')::int, extract(epoch from v_now - v_started)::int)));
  begin v_callback := case when v_result = 'callback' then nullif(p->>'callback_at', '')::timestamptz end; exception when others then v_callback := null; end;
  begin v_orders := nullif(p->>'orders_month', '')::numeric::int; exception when others then v_orders := null; end;
  if v_orders is not null and (v_orders < 0 or v_orders > 10000000) then v_orders := null; end if;
  if v_fit = 'not_fit' then v_nfr := nullif(p->>'not_fit_reason', ''); v_nfd := nullif(btrim(left(coalesce(p->>'not_fit_detail', ''), 200)), ''); end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_email := null; end if;

  insert into sales_calls (lead_id, started_at, ended_at, seconds, outcome, note, by_user, list_id, hour_block, dial_result, picked_up, fit, not_fit_reason, not_fit_detail,
                           orders_month, current_setup, pain, result, callback_at, client_id, session_id)
  values (v_lead.id, v_started, v_now, v_seconds, v_outcome, v_note, uid, v_lead.filter_id, extract(hour from v_started at time zone 'America/New_York')::int,
          v_dial, v_picked, v_fit, v_nfr, v_nfd, v_orders, v_setup, v_pain, v_result, v_callback, v_client, v_session)
  returning * into v_call;

  -- what the call does to the lead
  v_attempts := coalesce(v_lead.attempts, 0) + 1;
  v_stage := v_lead.stage; v_in_calls := v_lead.in_calls; v_in_email := v_lead.in_email; v_tags := coalesce(v_lead.tags, '{}'); v_notes := v_lead.notes;
  v_next := coalesce(v_callback, case v_outcome when 'no_answer' then v_now + interval '2 days' when 'voicemail' then v_now + interval '3 days'
                                                when 'gatekeeper' then v_now + interval '1 day' when 'connected' then v_now + interval '7 days' end);
  if v_outcome = 'booked' then v_stage := 'call_booked';
  elsif v_outcome = 'dnc' then v_stage := 'dnc'; v_in_calls := false; v_in_email := false; v_next := null;
  elsif v_outcome = 'not_fit' then v_stage := 'lost';
  elsif v_outcome = 'wrong_number' then v_in_calls := false; if not ('bad_number' = any (v_tags)) then v_tags := array_append(v_tags, 'bad_number'); end if;
  elsif v_lead.stage = 'new' then v_stage := 'contacted';
  end if;
  if v_result = 'soft_no' then v_next := v_now + interval '45 days'; end if;
  if v_attempts >= 4 and v_outcome not in ('booked', 'connected', 'gatekeeper') then v_in_calls := false; end if;   -- four tries with no human: park it
  if v_email is not null and v_email is distinct from lower(coalesce(v_lead.email, '')) then
    v_notes := concat_ws(E'\n', v_notes, v_day || ' email changed ' || coalesce(nullif(v_lead.email, ''), '—') || ' → ' || v_email);
  else v_email := null;
  end if;
  if v_note is not null then
    v_dial_lbl := case v_dial when 'no_answer' then 'No answer' when 'voicemail' then 'Voicemail' when 'bad_number' then 'Bad number' when 'gatekeeper' then 'Gatekeeper'
                              when 'decision_maker' then 'Reached decision-maker' else initcap(replace(v_outcome, '_', ' ')) end;
    v_res_lbl := case v_result when 'booked' then 'Booked' when 'callback' then 'Callback' when 'send_info' then 'Send info' when 'soft_no' then 'Soft no' when 'hard_no' then 'Hard no (DNC)' end;
    v_notes := concat_ws(E'\n', v_notes, v_day || ' ' || v_dial_lbl || coalesce(' → ' || v_res_lbl, '') || ': ' || v_note);
  end if;

  update sales_leads
     set attempts = v_attempts, last_outcome = v_outcome, last_touch_at = v_now,
         assigned_to = coalesce(assigned_to, uid),
         next_action_at = case when v_outcome = 'booked' then next_action_at else v_next end,
         stage = v_stage, in_calls = v_in_calls, in_email = v_in_email, tags = v_tags, notes = v_notes,
         picked_up = coalesce(v_picked, picked_up),
         orders_month_actual = coalesce(v_orders, orders_month_actual),
         current_setup = coalesce(v_setup, current_setup),
         pain = case when v_pain is not null and v_pain <> 'none' then v_pain else pain end,
         not_fit_reason = coalesce(v_nfr, not_fit_reason),
         email = coalesce(v_email, email)
   where id = v_lead.id;

  -- a booking: either made during the call (meeting_id) or right here from the debrief (book)
  if v_outcome = 'booked' then
    if v_meeting is not null then
      select * into v_mtg from sales_meetings where id = v_meeting and lead_id = v_lead.id;
      if not found then raise exception 'That booking is not on this lead.'; end if;
      update sales_meetings set call_id = v_call.id where id = v_meeting;
    elsif v_book is not null and nullif(v_book->>'starts_at', '') is not null then
      v_m := public._book_meeting(uid, v_lead.id, nullif(v_book->>'closer_id', '')::uuid, (v_book->>'starts_at')::timestamptz,
                                  nullif(v_book->>'minutes', '')::int, v_note, coalesce(v_book->>'invitee_email', v_email), v_call.id);
      v_meeting := (v_m->>'id')::uuid;
    else
      update sales_leads set next_action_at = null where id = v_lead.id;      -- booked somewhere else: off the queue
    end if;
    if v_meeting is not null then update sales_calls set meeting_id = v_meeting where id = v_call.id; end if;
  end if;

  return jsonb_build_object('call_id', v_call.id, 'outcome', v_outcome, 'meeting_id', v_meeting, 'meeting', v_m,
                            'lead', (select jsonb_build_object('id', l.id, 'stage', l.stage, 'assigned_to', l.assigned_to, 'attempts', l.attempts, 'in_calls', l.in_calls, 'next_action_at', l.next_action_at, 'email', l.email)
                                       from sales_leads l where l.id = v_lead.id));
end $$;

-- what happened to the email the rep sent after the call
create or replace function public.call_email_result(p_call uuid, p_result text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_result not in ('sent', 'failed') then raise exception 'Unknown result.'; end if;
  update sales_calls set email_result = p_result where id = p_call and (by_user = auth.uid() or public.is_owner());
end $$;

-- a call logged by mistake is voided, never deleted: it drops out of every count and the lead gets its try back
create or replace function public.void_call(p_call uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c sales_calls%rowtype; uid uuid := auth.uid();
begin
  if uid is null or not public.is_sales_team() then raise exception 'Sales team only.' using errcode = '42501'; end if;
  select * into c from sales_calls where id = p_call for update;
  if not found then raise exception 'Call not found.'; end if;
  if c.voided_at is not null then return jsonb_build_object('call_id', c.id, 'voided', true); end if;
  if not (public.is_owner() or (c.by_user = uid and c.created_at > now() - interval '24 hours')) then
    raise exception 'You can void your own calls for a day. After that, ask Derek.' using errcode = '42501';
  end if;
  update sales_calls set voided_at = now(), voided_by = uid, void_reason = nullif(btrim(coalesce(p_reason, '')), '') where id = p_call;
  if c.lead_id is not null then update sales_leads set attempts = greatest(0, coalesce(attempts, 0) - 1) where id = c.lead_id; end if;
  return jsonb_build_object('call_id', c.id, 'voided', true);
end $$;

-- ============================================================ 6. what a closer sees about their setters
-- owner: everyone who dials · closer: their setters and themselves · setter: themselves
create or replace function public.setter_board(p_days int default 7) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); me profiles%rowtype; v_since timestamptz; v_today timestamptz; v_out jsonb;
begin
  if uid is null or not public.is_sales_team() then raise exception 'Sales team only.' using errcode = '42501'; end if;
  select * into me from profiles where id = uid;
  p_days := least(120, greatest(1, coalesce(p_days, 7)));
  v_today := date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York';
  v_since := v_today - make_interval(days => p_days - 1);
  select coalesce(jsonb_agg(x order by (x->>'is_setter')::boolean desc, x->>'name'), '[]'::jsonb) into v_out from (
    select jsonb_build_object(
      'id', p.id, 'name', coalesce(nullif(p.full_name, ''), p.email), 'email', p.email, 'is_setter', p.role = 'shipbay_setter', 'closer_id', p.closer_id, 'last_seen_at', p.last_seen_at,
      'today', (select jsonb_build_object('dials', count(*), 'connects', count(*) filter (where c.outcome in ('gatekeeper', 'connected', 'booked', 'not_fit', 'dnc')), 'booked', count(*) filter (where c.outcome = 'booked'))
                  from sales_calls c where c.by_user = p.id and c.voided_at is null and c.started_at >= v_today),
      'range', (select jsonb_build_object('dials', count(*), 'connects', count(*) filter (where c.outcome in ('gatekeeper', 'connected', 'booked', 'not_fit', 'dnc')),
                                          'dm', count(*) filter (where c.dial_result = 'decision_maker'), 'booked', count(*) filter (where c.outcome = 'booked'),
                                          'talk_seconds', coalesce(sum(c.seconds) filter (where c.outcome in ('gatekeeper', 'connected', 'booked', 'not_fit', 'dnc')), 0),
                                          'last_call_at', max(c.started_at))
                  from sales_calls c where c.by_user = p.id and c.voided_at is null and c.started_at >= v_since),
      'session_seconds', (select coalesce(sum(least(28800, coalesce(s.seconds, extract(epoch from (coalesce(s.ended_at, now()) - s.started_at))::int))), 0) from sales_call_sessions s where s.by_user = p.id and s.started_at >= v_since),
      'meetings', (select jsonb_build_object('booked', count(*), 'canceled', count(*) filter (where m.status = 'canceled'),
                                             'upcoming', count(*) filter (where m.status <> 'canceled' and m.starts_at >= now()),
                                             'held', count(*) filter (where m.status <> 'canceled' and m.starts_at < now() and m.outcome is not null and m.outcome <> 'no_show'),
                                             'no_show', count(*) filter (where m.outcome = 'no_show'),
                                             'unmarked', count(*) filter (where m.status <> 'canceled' and m.starts_at < now() and m.outcome is null))
                     from sales_meetings m where m.booked_by = p.id and m.booked_at >= v_since),
      'upcoming', (select coalesce(jsonb_agg(u order by u->>'starts_at'), '[]'::jsonb) from (
                     select jsonb_build_object('id', m.id, 'starts_at', m.starts_at, 'name', m.name, 'invitee', coalesce(m.invitee_name, m.invitee_email), 'closer', (select split_part(coalesce(nullif(full_name, ''), email), ' ', 1) from profiles where id = m.assigned_to), 'invite_sent', m.invite_sent_at is not null) u
                       from sales_meetings m where m.booked_by = p.id and m.status <> 'canceled' and m.starts_at >= now() order by m.starts_at limit 12) q),
      'recent', (select coalesce(jsonb_agg(r order by r->>'at' desc), '[]'::jsonb) from (
                   select jsonb_build_object('id', c.id, 'at', c.started_at, 'outcome', c.outcome, 'result', c.result, 'seconds', c.seconds, 'note', c.note, 'company', coalesce(nullif(l.company, ''), l.domain, l.email)) r
                     from sales_calls c left join sales_leads l on l.id = c.lead_id where c.by_user = p.id and c.voided_at is null order by c.started_at desc limit 12) q)
    ) x
    from profiles p
    where p.active is not false and p.role like 'shipbay%'
      and case when me.is_owner then (p.role = 'shipbay_setter' or p.is_sales or p.is_owner)
               when me.role = 'shipbay_setter' then p.id = uid
               else (p.closer_id = uid or p.id = uid) end
  ) t;
  return jsonb_build_object('days', p_days, 'since', v_since, 'people', v_out);
end $$;

-- ============================================================ 7. who may call what
revoke execute on function public._book_meeting(uuid, uuid, uuid, timestamptz, int, text, text, uuid) from public, anon, authenticated;
revoke execute on function public._can_work_lead(uuid, public.sales_leads) from public, anon, authenticated;
revoke execute on function public.log_call(jsonb) from public, anon;
revoke execute on function public.book_meeting(jsonb) from public, anon;
revoke execute on function public.open_slots(uuid, date, int) from public, anon;
revoke execute on function public.cancel_meeting(uuid, text) from public, anon;
revoke execute on function public.call_email_result(uuid, text) from public, anon;
revoke execute on function public.void_call(uuid, text) from public, anon;
revoke execute on function public.setter_board(int) from public, anon;
grant execute on function public.log_call(jsonb), public.book_meeting(jsonb), public.open_slots(uuid, date, int), public.cancel_meeting(uuid, text),
  public.call_email_result(uuid, text), public.void_call(uuid, text), public.setter_board(int) to authenticated, service_role;
grant execute on function public.is_setter(), public.is_sales_team(), public.is_closer(uuid) to anon, authenticated, service_role;

-- ============================================================ 9. the call log is written by log_call
-- 9a. Nobody but the owner edits or deletes a logged call (reps and setters read their own; mistakes go through void_call).
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_calls' and policyname = 'sales_calls_owner_only_update') then
    create policy sales_calls_owner_only_update on public.sales_calls as restrictive for update using (public.is_owner());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_calls' and policyname = 'sales_calls_owner_only_delete') then
    create policy sales_calls_owner_only_delete on public.sales_calls as restrictive for delete using (public.is_owner());
  end if;
end $$;
-- 9b. NOT APPLIED YET (2026-11-10): close direct inserts too, so log_call is the only way a call is written.
--     Run it once every open portal tab is on the build that uses log_call; an older tab would lose its calls silently.
-- alter policy sales_calls_rep on public.sales_calls using (by_user = auth.uid()) with check (false);
