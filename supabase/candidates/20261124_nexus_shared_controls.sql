-- Applied to production 2026-11-20. Brands run on their own WMS (orgs.external_wms) leave the ShipBay WMS brand lists;
-- positions are added through Nexus (nexus_positions_add, admin only). See the live definitions of wms_brands / wms_order_brands.
alter table public.orgs add column if not exists external_wms boolean not null default false;
