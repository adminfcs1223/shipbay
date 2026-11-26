-- Stage 1 cut-over to Nexus as the only location authority (Derek, 2026-11-25 "APPROVED STAGE 1 BUILD DIRECTIVE").
-- Needs 20261202 (the table rule that lets only the Nexus journal store a pallet in a shared position) and 20261203.
--   1. Archive, then clear, the position still written on voided pallets (the old ShipBay-only assignments). A voided pallet
--      holds no stock and no position; nothing else on the pallet changes. The archive keeps every cleared value.
--   2. ShipBay's position list follows Nexus HILLSBOROUGH map version 4: P-01..P-66, STG-01, STG-02, all marked shared.
--      P-65, P-66 and STG-02 are added; nothing is retired or deleted (pick shelves, open box, returns, OFF-FLOOR and the dock stay).
--   3. The old ShipBay-only ways of putting a pallet in a position, or of adding or editing positions, can no longer be called
--      by a signed-in user: the old Locations (Nexus v1) put-away, move and scan, the old WMS assign/put-away, and position
--      add/edit. Their text is unchanged; only who may call them. Restorable from backup_20261125.functions_before.acl.
-- Backup taken first: backup_20261125 (functions with their grants, triggers, wms_pallets, locations, inventory_moves, nexus_moves, wms_nexus_ops).
begin;
create table if not exists backup_20261125.void_pallet_positions as
  select p.id, p.psku, p.org_id, p.status, p.location_id, l.code as location_code, now() as archived_at
  from public.wms_pallets p join public.locations l on l.id = p.location_id where p.status = 'void';
update public.wms_pallets p set location_id = null
  where p.status = 'void' and p.location_id is not null and exists (select 1 from backup_20261125.void_pallet_positions a where a.id = p.id);

select public.nexus_registry_apply(jsonb_build_object('version', 4, 'warehouse', 'HILLSBOROUGH', 'locations',
  (select jsonb_agg(x) from (
     select jsonb_build_object('id', c, 'code', c, 'kind', 'pallet', 'zone', case when n <= 30 then 'inbound' else 'outbound' end, 'capacity', 1, 'status', 'active', 'version', 4) x
       from (select n, 'P-' || lpad(n::text, 2, '0') c from generate_series(1, 66) n) g
     union all
     select jsonb_build_object('id', c, 'code', c, 'kind', 'floor', 'zone', 'staging', 'capacity', null, 'status', 'active', 'version', 4) from unnest(array['STG-01', 'STG-02']) c) s)), false);
update public.locations set walk_seq = v.s from (values ('P-65', 77), ('P-66', 78), ('STG-02', 79)) v(c, s) where code = v.c and walk_seq is null;

revoke execute on function public.nexus_putaway(text, text) from public, anon, authenticated;
revoke execute on function public.nexus_move_pallet(text, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.nexus_api_scan(text, text, text) from public, anon, authenticated;
revoke execute on function public.wms_assign_location(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.wms_putaway(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.nexus_positions_add(text[], text, text) from public, anon, authenticated;
revoke execute on function public.nexus_position_edit(text, text, boolean) from public, anon, authenticated;

do $chk$ declare v_shared int; v_void int; v_open int; begin
  select count(*) into v_shared from public.locations where shared and active and (code ~ '^P-\d{2}$' or code ~ '^STG-\d{2}$');
  select count(*) into v_void from public.wms_pallets where status = 'void' and location_id is not null;
  select count(*) into v_open from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('nexus_putaway','nexus_move_pallet','nexus_api_scan','wms_assign_location','wms_putaway','nexus_positions_add','nexus_position_edit')
    and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'));
  if v_shared <> 68 or v_void <> 0 or v_open <> 0 then raise exception 'Cut-over check failed (shared %, void with position %, old paths open %). Nothing was changed.', v_shared, v_void, v_open; end if;
end $chk$;
commit;
