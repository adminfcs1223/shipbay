-- Shared dock calendar: what ShipBay needs on its own shipment records to publish them to Nexus. CANDIDATE: not applied anywhere.
-- Additive only: five nullable columns on inbound_shipments, two checks, one trigger that touches only those columns, five functions.
-- Nothing here calls Nexus. The server-side bridge (supabase/functions/nexus-bridge) reads the plan and does the sending.
--
--   * A shipment keeps its date-only ETA (expected_at). A confirmed dock appointment is a separate, optional time window
--     (appt_starts_at / appt_ends_at). No time is ever derived from the date.
--   * The Nexus booking id of a shipment is derived from the shipment's own id (wms_booking_id), so a shipment can only
--     ever have one booking and publishing twice changes that same booking.
--   * A shipment with a date and no confirmed time is reported by the plan as held ("hold_date_only") and is never sent:
--     Nexus v1 has no date-only event. The plan carries the body it would send once Nexus has one.
begin;
alter table public.inbound_shipments
  add column if not exists appt_starts_at timestamptz,
  add column if not exists appt_ends_at timestamptz,
  add column if not exists nexus_publish_state text,
  add column if not exists nexus_published_hash text,
  add column if not exists nexus_published_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inbound_shipments_appt_ck') then
    alter table public.inbound_shipments add constraint inbound_shipments_appt_ck
      check ((appt_starts_at is null or expected_at is not null) and (appt_ends_at is null or (appt_starts_at is not null and appt_ends_at > appt_starts_at)));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inbound_shipments_publish_ck') then
    alter table public.inbound_shipments add constraint inbound_shipments_publish_ck check (nexus_publish_state is null or nexus_publish_state in ('published', 'cancelled'));
  end if;
end $$;

create or replace function public.wms_booking_id(p_shipment uuid) returns text language sql immutable as $$ select 'SB-INB-' || upper(p_shipment::text) $$;

-- When a shipment's date moves (or is removed), a time that was confirmed for the old date is no longer confirmed.
create or replace function public._inbound_appt_trg() returns trigger language plpgsql as $$
begin
  if new.appt_starts_at is not null and (new.expected_at is null or (new.appt_starts_at at time zone 'America/New_York')::date <> new.expected_at) then
    new.appt_starts_at := null; new.appt_ends_at := null;
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'inbound_shipments_appt' and tgrelid = 'public.inbound_shipments'::regclass) then
    create trigger inbound_shipments_appt before update of expected_at on public.inbound_shipments for each row execute function public._inbound_appt_trg();
  end if;
end $$;

-- Set or clear the confirmed appointment time (ShipBay admin or staff). Clearing returns the shipment to "time not confirmed".
create or replace function public.wms_shipment_set_appointment(p_id uuid, p_starts timestamptz, p_ends timestamptz default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare i inbound_shipments; v_role text;
begin
  select role into v_role from profiles where id = auth.uid() and active is not false;
  if v_role is null or v_role not in ('shipbay_admin', 'shipbay_staff') then raise exception 'Only ShipBay admin or staff can set an appointment time.'; end if;
  select * into i from inbound_shipments where id = p_id for update;
  if i.id is null then raise exception 'Shipment not found.'; end if;
  if p_starts is null then
    update inbound_shipments set appt_starts_at = null, appt_ends_at = null where id = p_id;
  else
    if i.expected_at is null then raise exception 'Set the expected date first.'; end if;
    if (p_starts at time zone 'America/New_York')::date <> i.expected_at then raise exception 'That time is not on the shipment''s date (%), Eastern Time.', to_char(i.expected_at, 'Mon FMDD'); end if;
    if p_ends is not null and p_ends <= p_starts then raise exception 'The appointment has to end after it starts.'; end if;
    update inbound_shipments set appt_starts_at = p_starts, appt_ends_at = p_ends where id = p_id;
  end if;
  return (select jsonb_build_object('id', id, 'expected_at', expected_at, 'appt_starts_at', appt_starts_at, 'appt_ends_at', appt_ends_at) from inbound_shipments where id = p_id);
end $$;

-- The ShipBay side of the Calendar screen: ShipBay's own shipments with their private detail. Staff only; never sent to Nexus.
create or replace function public.wms_calendar_shipments(p_from date, p_to date) returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'brand', g.name, 'reference', i.reference, 'carrier', i.carrier, 'expected_at', i.expected_at,
      'appt_starts_at', i.appt_starts_at, 'appt_ends_at', i.appt_ends_at, 'pallets', i.pallets, 'cartons', i.cartons, 'status', i.status, 'notes', i.notes,
      'publish_state', i.nexus_publish_state) order by i.expected_at nulls last, g.name, i.reference), '[]')
  from inbound_shipments i join orgs g on g.id = i.org_id
  where is_wms_staff() and i.approved_at is not null and not coalesce(g.external_wms, false)
    and (i.status <> 'cancelled' or i.nexus_publish_state = 'published')
    and ((i.status in ('expected', 'in_transit') and (i.expected_at is null or i.expected_at <= p_to)) or i.expected_at between p_from and p_to);
$$;

-- What has to be sent to Nexus so the shared calendar matches ShipBay's records. Read-only. The body holds direction, time,
-- pallets and status and nothing else: brand, reference, carrier and notes never leave ShipBay.
create or replace function public.wms_calendar_plan() returns jsonb language sql stable security definer set search_path to 'public' as $$
  with s as (
    select i.*, (i.approved_at is not null and i.status in ('expected', 'in_transit') and not coalesce(g.external_wms, false)) as open,
      jsonb_strip_nulls(jsonb_build_object('direction', 'inbound',
        'starts_at', to_char(i.appt_starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'ends_at', to_char(i.appt_ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'pallets', nullif(i.pallets, 0), 'status', 'scheduled')) as body
    from inbound_shipments i join orgs g on g.id = i.org_id
  ), a as (
    select s.*, md5(s.body::text) as hash,
      case
        when s.open and s.expected_at is not null and s.appt_starts_at is not null
          then case when s.nexus_publish_state = 'published' and s.nexus_published_hash = md5(s.body::text) then null else 'put' end
        when s.nexus_publish_state = 'published' and s.status in ('expected', 'in_transit', 'cancelled') then 'cancel'
        when s.open and s.expected_at is not null then 'hold_date_only'
      end as action
    from s
  )
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('shipment', a.id, 'booking_id', wms_booking_id(a.id), 'action', a.action,
      'body', case when a.action = 'put' then a.body end, 'hash', case when a.action = 'put' then a.hash end,
      'reason', case when a.action = 'cancel' then case when a.status = 'cancelled' then 'shipment cancelled' when a.expected_at is null then 'date removed' else 'time no longer confirmed' end
                     when a.action = 'hold_date_only' then 'date known, time not confirmed: Nexus v1 has no date-only event' end,
      'proposed', case when a.action = 'hold_date_only' then jsonb_strip_nulls(jsonb_build_object('direction', 'inbound', 'date', a.expected_at, 'time_confirmed', false, 'pallets', nullif(a.pallets, 0), 'status', 'scheduled')) end))
    order by a.expected_at nulls last, a.id), '[]')
  from a where a.action is not null;
$$;

-- Record what Nexus accepted. Called by the bridge only.
create or replace function public.wms_calendar_mark(p_shipment uuid, p_state text, p_hash text default null) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if p_state not in ('published', 'cancelled') then raise exception 'Unknown publish state.'; end if;
  update inbound_shipments set nexus_publish_state = p_state, nexus_published_hash = case when p_state = 'published' then p_hash end, nexus_published_at = now() where id = p_shipment;
  if not found then raise exception 'Shipment not found.'; end if;
end $$;

revoke all on function public.wms_shipment_set_appointment(uuid, timestamptz, timestamptz), public.wms_calendar_shipments(date, date), public.wms_calendar_plan(), public.wms_calendar_mark(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.wms_shipment_set_appointment(uuid, timestamptz, timestamptz), public.wms_calendar_shipments(date, date) to authenticated;
grant execute on function public.wms_calendar_plan(), public.wms_calendar_mark(uuid, text, text) to service_role;
commit;
