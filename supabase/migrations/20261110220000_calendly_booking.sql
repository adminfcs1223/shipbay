-- Appointments are booked in Calendly. (Derek, 2026-11-10 17:21 ET)
-- The portal embeds the closer's Calendly page; Calendly owns availability, the invite, reminders and the Meet link.
-- When a booking completes, the "appt" edge function reads the event back from Calendly and calls
-- _record_calendly_booking, which writes the portal's side in one transaction: the meeting row (who booked it, for which
-- lead), the lead moving to the closer, the touch. Whoever's Calendly the event landed on is the closer.
-- The setter is added to the Calendly event as a guest, so the call is on both calendars.
-- Connector-safe: additive, create-or-replace, guarded.

alter table public.sales_availability add column if not exists calendly_url text;
alter table public.sales_meetings add column if not exists reschedule_url text, add column if not exists cancel_url text;

create or replace function public._record_calendly_booking(p_uid uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me profiles%rowtype; v_lead sales_leads%rowtype; v_ex sales_meetings%rowtype; v_closer_row profiles%rowtype;
  v_closer uuid; v_id uuid; v_uri text := nullif(p->>'event_uri', '');
  v_starts timestamptz := (p->>'starts_at')::timestamptz; v_ends timestamptz := nullif(p->>'ends_at', '')::timestamptz;
  v_email text := nullif(lower(btrim(coalesce(p->>'invitee_email', ''))), '');
begin
  if v_uri is null or v_uri !~ '^https://api\.calendly\.com/scheduled_events/[A-Za-z0-9-]+$' then raise exception 'Not a Calendly event.'; end if;
  if v_starts is null then raise exception 'The Calendly event has no start time.'; end if;
  select * into v_me from profiles where id = p_uid;
  if not found or v_me.active is false or not (v_me.is_sales or v_me.is_owner or v_me.role = 'shipbay_setter') then
    raise exception 'Sales team only.' using errcode = '42501';
  end if;
  select * into v_lead from sales_leads where id = (p->>'lead_id')::uuid for update;
  if not found then raise exception 'Lead not found.'; end if;
  if not public._can_work_lead(p_uid, v_lead) then raise exception 'That lead belongs to someone else now.' using errcode = '42501'; end if;

  select * into v_ex from sales_meetings where external_id = v_uri;
  if found and v_ex.booked_by is not null and v_ex.booked_by <> p_uid then raise exception 'That Calendly booking is already recorded by someone else.' using errcode = '42501'; end if;
  if found and v_ex.lead_id is not null and v_ex.lead_id <> v_lead.id and v_ex.booked_by is not null then raise exception 'That Calendly booking belongs to another lead.'; end if;

  -- the host of the Calendly event takes the call; fall back to the closer asked for, then the setter's closer
  select id into v_closer from profiles
   where lower(email) = lower(nullif(p->>'host_email', '')) and active is not false and (is_sales or is_owner) and role in ('shipbay_admin', 'shipbay_staff', 'shipbay_sales') limit 1;
  v_closer := coalesce(v_closer, nullif(p->>'closer_id', '')::uuid, case when v_me.role = 'shipbay_setter' then v_me.closer_id else p_uid end);
  if v_closer is null or not public.is_closer(v_closer) then raise exception 'Nobody on the sales team owns that Calendly event.'; end if;
  select * into v_closer_row from profiles where id = v_closer;

  insert into sales_meetings (external_id, source, name, starts_at, ends_at, status, invitee_name, invitee_email, location, lead_id, assigned_to, notes,
                              booked_by, booked_at, invite_sent_at, reschedule_url, cancel_url)
  values (v_uri, 'calendly', coalesce(nullif(p->>'name', ''), 'Discovery call'), v_starts, coalesce(v_ends, v_starts + interval '20 minutes'), 'active',
          coalesce(nullif(p->>'invitee_name', ''), v_lead.contact_name), v_email, nullif(p->>'location', ''), v_lead.id, v_closer,
          nullif(concat_ws(E'\n', case when p_uid <> v_closer then 'Booked by ' || coalesce(nullif(v_me.full_name, ''), v_me.email) end, nullif(btrim(coalesce(p->>'note', '')), '')), ''),
          p_uid, now(), now(), nullif(p->>'reschedule_url', ''), nullif(p->>'cancel_url', ''))
  on conflict (external_id) do update
     set name = excluded.name, starts_at = excluded.starts_at, ends_at = excluded.ends_at, status = 'active',
         invitee_name = excluded.invitee_name, invitee_email = excluded.invitee_email, location = excluded.location,
         lead_id = excluded.lead_id, assigned_to = excluded.assigned_to,
         booked_by = coalesce(sales_meetings.booked_by, excluded.booked_by), booked_at = coalesce(sales_meetings.booked_at, excluded.booked_at),
         invite_sent_at = coalesce(sales_meetings.invite_sent_at, excluded.invite_sent_at),
         reschedule_url = excluded.reschedule_url, cancel_url = excluded.cancel_url, notes = coalesce(sales_meetings.notes, excluded.notes),
         canceled_at = null, canceled_by = null, cancel_reason = null
  returning id into v_id;

  update sales_leads
     set assigned_to = v_closer,
         stage = case when stage in ('new', 'contacted', 'replied', 'call_booked', 'lost') then 'call_booked' else stage end,
         next_action_at = v_starts, last_touch_at = now(),
         set_by = case when p_uid <> v_closer then p_uid else set_by end,
         email = coalesce(nullif(email, ''), v_email)
   where id = v_lead.id;

  if v_ex.id is null or v_ex.booked_by is null then
    insert into sales_touches (lead_id, kind, note, at, by_user)
    values (v_lead.id, 'meeting_note', 'Booked on Calendly' || case when p_uid <> v_closer then ' for ' || split_part(coalesce(nullif(v_closer_row.full_name, ''), v_closer_row.email), ' ', 1) else '' end
            || ' · ' || to_char(v_starts at time zone 'America/New_York', 'Dy Mon FMDD, FMHH12:MI AM') || ' ET', now(), p_uid);
  end if;

  return (select to_jsonb(m) || jsonb_build_object('closer_name', coalesce(nullif(v_closer_row.full_name, ''), v_closer_row.email), 'closer_email', v_closer_row.email, 'company', v_lead.company)
            from sales_meetings m where m.id = v_id);
end $$;
revoke execute on function public._record_calendly_booking(uuid, jsonb) from public, anon, authenticated;
grant execute on function public._record_calendly_booking(uuid, jsonb) to service_role;

-- The Calendly sync matches a meeting to a lead by the invitee's email. When the setter booked it for a lead whose email
-- differs, the sync must not wipe who booked it or which lead it is for.
create or replace function public.sales_meetings_keep_booking() returns trigger
language plpgsql set search_path = public as $$
begin
  -- (a deleted lead or login still clears the field: the row it pointed to is gone by then)
  if old.booked_by is not null then
    if new.lead_id is null and old.lead_id is not null and exists (select 1 from sales_leads where id = old.lead_id) then new.lead_id := old.lead_id; end if;
    if new.booked_by is null and exists (select 1 from profiles where id = old.booked_by) then new.booked_by := old.booked_by; end if;
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'sales_meetings_keep_booking' and tgrelid = 'public.sales_meetings'::regclass) then
    create trigger sales_meetings_keep_booking before update on public.sales_meetings for each row execute function public.sales_meetings_keep_booking();
  end if;
end $$;

-- Calendly is the only way a call is booked: the portal's own slot booking is closed to the apps (the code stays, unused).
revoke execute on function public.book_meeting(jsonb) from authenticated;
revoke execute on function public.open_slots(uuid, date, int) from authenticated;

-- Keep the portal in step with Calendly (a prospect who cancels or reschedules from their email): sync every 10 minutes.
-- Same call the Smartlead sync job makes, with the action swapped; the key is copied from that job, not written here.
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'shipbay-calendly-sync') then
    perform cron.schedule('shipbay-calendly-sync', '*/10 * * * *',
      (select replace(replace(command, 'smartlead_sync', 'calendly_sync'), '150000', '60000') from cron.job where jobname = 'shipbay-smartlead-sync'));
  end if;
end $$;
