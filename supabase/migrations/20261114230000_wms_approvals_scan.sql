-- 2026-11-14 (Derek, 16:07): shipments a brand books wait for ShipBay's approval before they reach the warehouse
-- schedule; picking a product that has a barcode on file takes a scan of it.
-- Applied live with execute_sql on 11-14. NOT IN THIS FILE YET (they exist only in the database): the bodies of
-- _inbound_approval_guard, wms_today (approved shipments only, 6 weeks ahead, open problems count), _wms_needs_scan,
-- _wms_scan_ok, wms_scan_needed, wms_pick_scan, wms_pick (now calls wms_pick_scan with no code).
alter table inbound_shipments add column if not exists approved_at timestamptz;
alter table inbound_shipments add column if not exists approved_by uuid;
alter table inbound_shipments add column if not exists approved_by_name text;
-- everything booked before approvals existed counts as approved
update inbound_shipments set approved_at = coalesce(created_at, now()) where approved_at is null and created_at < '2026-11-14 21:30:00+00';
-- trigger inbound_approval_guard (before insert or update): a shipment booked by ShipBay staff is approved on the
-- spot; one booked by a brand starts unapproved, and a brand cannot set or change the approval fields.
