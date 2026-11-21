-- Nexus floor map + label-print visibility. Applied to production 2026-11-20 (after 20261124_nexus.sql). Additive.
begin;
create or replace view public.v_nexus_pallets as
select p.id, p.psku, p.org_id, g.name as org_name, p.status, p.location_id, l.code as location_code, l.zone, p.sku_id, p.item_no, p.item_name, p.mixed,
  p.cartons, p.units_total, p.received_at, p.stored_at, coalesce((to_jsonb(p) ->> 'held')::boolean, false) as held,
  greatest(0, floor(extract(epoch from (now() - p.received_at)) / 86400))::int as age_days,
  coalesce(p.label_prints, 0) as label_prints, p.last_printed_at
from public.wms_pallets p join public.orgs g on g.id = p.org_id left join public.locations l on l.id = p.location_id
where p.status <> 'void';
revoke all on public.v_nexus_pallets from public, anon, authenticated, service_role;
create or replace function public.nexus_map() returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform 1 from _nexus_staff();
  return jsonb_build_object('as_of', now(),
    'positions', (select coalesce(jsonb_agg(jsonb_build_object('code', l.code, 'kind', l.kind, 'zone', l.zone,
        'pallets', (select coalesce(jsonb_agg(jsonb_build_object('psku', v.psku, 'brand', v.org_name, 'item', v.item_name, 'status', v.status, 'held', v.held,
            'cartons', v.cartons, 'units', v.units_total, 'received_at', v.received_at, 'age_days', v.age_days, 'label_prints', v.label_prints) order by v.received_at), '[]')
          from v_nexus_pallets v where v.location_id = l.id)) order by l.code), '[]')
      from locations l where l.active and l.kind in ('pallet', 'floor', 'dock')),
    'unplaced', (select coalesce(jsonb_agg(jsonb_build_object('psku', v.psku, 'brand', v.org_name, 'item', v.item_name, 'status', v.status, 'held', v.held, 'label_prints', v.label_prints, 'received_at', v.received_at) order by v.received_at desc), '[]')
      from v_nexus_pallets v where v.location_id is null));
end $$;
revoke all on function public.nexus_map() from public, anon, service_role;
grant execute on function public.nexus_map() to authenticated;
commit;
