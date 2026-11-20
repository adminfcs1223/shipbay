-- FIX-FORWARD (preferred if anything is wrong after release): turn the booked route off, keep every record.
-- Booked receipts, their pallets and links, and every HOLD stay exactly as they are; the HOLD gate stays on, so a held
-- pallet still cannot be stocked. The WMS shows no booking list when wms_bookings is not available and receives unbooked
-- through the unchanged legacy route. Re-enable with 20261123_wms_booking_receiving.enable.sql.
begin;
revoke execute on function public.wms_bookings(uuid) from authenticated;
revoke execute on function public.wms_receive_booking(uuid, uuid, jsonb, integer, text, text, text, text) from authenticated;
-- the lookup and the HOLD disposition stay available: stations can still settle a receipt sent before the switch, and an
-- admin can still release or void a held pallet
commit;
