-- WMS activity log for billing. Every floor action is recorded by table triggers, so no screen or function can skip it.
-- A tracking failure never blocks the floor: each trigger swallows its own errors. Additive; nothing existing is changed.
begin;
create table if not exists public.wms_activity (
  id bigserial primary key, at timestamptz not null default clock_timestamp(), org_id uuid, kind text not null, qty integer not null default 1,
  ref text, actor uuid, actor_name text, detail jsonb);
create index if not exists wms_activity_org_at on public.wms_activity (org_id, at);
alter table public.wms_activity enable row level security;
revoke all on public.wms_activity from public, anon, authenticated, service_role;
revoke all on sequence public.wms_activity_id_seq from public, anon, authenticated, service_role;

create or replace function public._wms_track() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_org uuid; v_kind text; v_qty int := 1; v_ref text; v_detail jsonb;
begin
  begin
    if tg_table_name = 'wms_pallets' then
      v_org := new.org_id; v_ref := new.psku;
      if tg_op = 'INSERT' then v_kind := 'pallet_received'; v_detail := jsonb_build_object('cartons', new.cartons, 'booking', new.inbound_id);
      else
        if coalesce(new.label_prints, 0) > coalesce(old.label_prints, 0) then
          insert into wms_activity (org_id, kind, qty, ref, actor, actor_name) values (v_org, 'pallet_label_print', new.label_prints - coalesce(old.label_prints, 0), v_ref, auth.uid(), (select coalesce(full_name, email) from profiles where id = auth.uid()));
        end if;
        if new.held and not old.held then insert into wms_activity (org_id, kind, ref, actor, detail) values (v_org, 'pallet_hold', v_ref, auth.uid(), jsonb_build_object('reason', new.hold_reason)); end if;
        if new.hold_disposition is not null and old.hold_disposition is null then insert into wms_activity (org_id, kind, ref, actor) values (v_org, 'pallet_hold_' || new.hold_disposition, v_ref, auth.uid()); end if;
        if new.status is distinct from old.status then
          v_kind := case new.status when 'counted' then 'pallet_counted' when 'stored' then 'pallet_putaway' when 'void' then 'pallet_voided' end;
          v_detail := jsonb_build_object('location', (select code from locations where id = new.location_id), 'units', new.units_total);
        end if;
      end if;
    elsif tg_table_name = 'wms_cartons' then
      v_org := new.org_id; v_ref := new.code;
      if tg_op = 'INSERT' then v_kind := 'carton_received';
      elsif new.scanned_at is not null and old.scanned_at is null then v_kind := 'carton_scan';
      elsif new.open_box_at is not null and old.open_box_at is null then v_kind := 'carton_open_box'; v_qty := coalesce(new.open_units, 1);
      end if;
    elsif tg_table_name = 'wms_picks' then
      select o.org_id, o.order_number into v_org, v_ref from order_lines l join orders o on o.id = l.order_id where l.id = new.line_id;
      if tg_op = 'INSERT' then v_kind := 'pick'; v_qty := new.qty;
      elsif new.undone_at is not null and old.undone_at is null then v_kind := 'pick_undone'; v_qty := new.qty; end if;
    elsif tg_table_name = 'order_lines' then
      if new.qty_verified > old.qty_verified then
        select o.org_id, o.order_number into v_org, v_ref from orders o where o.id = new.order_id;
        v_kind := 'pack_scan'; v_qty := new.qty_verified - old.qty_verified;
      end if;
    elsif tg_table_name = 'shipments' then
      v_org := new.org_id; v_kind := 'shipment'; v_ref := new.tracking; v_detail := jsonb_build_object('carrier', new.carrier, 'order', new.order_id);
    elsif tg_table_name = 'nexus_count_lines' then
      if new.counted_at is not null and (tg_op = 'INSERT' or old.counted_at is distinct from new.counted_at) then v_org := new.org_id; v_kind := 'cycle_count_scan'; v_ref := new.psku; end if;
    end if;
    if v_kind is not null then
      insert into wms_activity (org_id, kind, qty, ref, actor, actor_name, detail)
      values (v_org, v_kind, coalesce(v_qty, 1), v_ref, auth.uid(), (select coalesce(full_name, email) from profiles where id = auth.uid()), v_detail);
    end if;
  exception when others then null;   -- tracking must never stop the floor
  end;
  return null;
end $$;
revoke all on function public._wms_track() from public, anon, authenticated, service_role;
create or replace trigger wms_track after insert or update on public.wms_pallets for each row execute function public._wms_track();
create or replace trigger wms_track after insert or update on public.wms_cartons for each row execute function public._wms_track();
create or replace trigger wms_track after insert or update on public.wms_picks for each row execute function public._wms_track();
create or replace trigger wms_track after update of qty_verified on public.order_lines for each row execute function public._wms_track();
create or replace trigger wms_track after insert on public.shipments for each row execute function public._wms_track();
create or replace trigger wms_track after insert or update on public.nexus_count_lines for each row execute function public._wms_track();

-- Admin billing view: active ShipBay admin/staff only.
create or replace function public._billing_staff() returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from profiles where id = auth.uid() and active and role in ('shipbay_admin', 'shipbay_staff'));
$$;
revoke all on function public._billing_staff() from public, anon, authenticated, service_role;
create or replace function public.wms_activity_summary(p_month date) returns table (org_id uuid, brand text, kind text, events bigint, qty bigint, first_at timestamptz, last_at timestamptz)
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not _billing_staff() then raise exception 'Only ShipBay admin or staff can see billing activity.'; end if;
  return query select a.org_id, g.name, a.kind, count(*), sum(a.qty)::bigint, min(a.at), max(a.at)
  from wms_activity a left join orgs g on g.id = a.org_id
  where a.at >= date_trunc('month', p_month) at time zone 'America/New_York' and a.at < (date_trunc('month', p_month) + interval '1 month') at time zone 'America/New_York'
  group by a.org_id, g.name, a.kind order by g.name, a.kind;
end $$;
create or replace function public.wms_activity_recent(p_org uuid default null, p_limit integer default 200) returns table (at timestamptz, brand text, kind text, qty integer, ref text, actor_name text)
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not _billing_staff() then raise exception 'Only ShipBay admin or staff can see billing activity.'; end if;
  return query select a.at, g.name, a.kind, a.qty, a.ref, a.actor_name from wms_activity a left join orgs g on g.id = a.org_id
  where p_org is null or a.org_id = p_org order by a.id desc limit least(greatest(coalesce(p_limit, 200), 1), 1000);
end $$;
revoke all on function public.wms_activity_summary(date) from public, anon, service_role; grant execute on function public.wms_activity_summary(date) to authenticated;
revoke all on function public.wms_activity_recent(uuid, integer) from public, anon, service_role; grant execute on function public.wms_activity_recent(uuid, integer) to authenticated;
commit;
