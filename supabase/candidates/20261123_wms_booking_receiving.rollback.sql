-- FULL ROLLBACK of 20261123_wms_booking_receiving.sql. Only for a database where the booked route was never used:
-- it stops, changing nothing, while any booked receipt or any HOLD exists (those are records; use the disable script).
begin;
do $$ begin
  if exists (select 1 from public.wms_receipt_links) then
    raise exception 'Rollback stopped: % booked receipt(s) exist. Keep them: use 20261123_wms_booking_receiving.disable.sql.', (select count(*) from public.wms_receipt_links);
  end if;
  if exists (select 1 from public.wms_pallets where held or hold_disposition is not null or inbound_id is not null) then
    raise exception 'Rollback stopped: pallets linked to a booking or with a HOLD exist. Use the disable script.';
  end if;
end $$;
drop function public.wms_receipt_lookup(uuid, uuid, text, integer, jsonb, integer, text, text, text);
drop function public._wms_receipt_sig_v1(uuid, uuid, jsonb, integer, text, text, text);
drop function public.wms_hold_disposition(uuid, text, text);
drop function public.wms_receive_booking(uuid, uuid, jsonb, integer, text, text, text, text);
drop function public.wms_bookings(uuid);
drop function public._active_caller();
drop view public.v_inbound_receiving;
drop table public.wms_receipt_links;
drop trigger wms_pallets_hold_gate on public.wms_pallets;
drop function public._wms_hold_gate();
drop index if exists public.wms_pallets_inbound_id_idx;
alter table public.wms_pallets drop column hold_disposition_ref, drop column hold_disposed_by, drop column hold_disposed_at,
  drop column hold_disposition, drop column hold_reason, drop column held, drop column inbound_id;
commit;
