-- 2026-11-14 (Derek, 15:50): the brand's portal gets a Warehouse page (orders, stock, pallets, problems, deliveries,
-- connection), and an admin can view any brand's portal as the client.
-- Applied live with execute_sql on 11-14. NOT IN THIS FILE YET: the bodies of wms_org_connector, wms_org_create_key,
-- wms_org_revoke_key, _is_shipbay_admin, _is_shipbay_staff (they exist only in the database).

-- a brand reads the problems reported on its own orders
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'wms_pick_problems' and policyname = 'client_read_problems') then
    create policy client_read_problems on wms_pick_problems for select using (org_id = current_org_id());
  end if;
end $$;

-- inventory_levels ran with its owner's rights, so any signed-in login could read every brand's stock levels through it.
-- It now runs with the caller's rights: a brand sees its own products only; ShipBay staff see all as before.
alter view inventory_levels set (security_invoker = true);
