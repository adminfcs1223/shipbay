-- Re-enable the booked route after 20261123_wms_booking_receiving.disable.sql.
begin;
grant execute on function public.wms_bookings(uuid) to authenticated;
grant execute on function public.wms_receive_booking(uuid, uuid, jsonb, integer, text, text, text, text) to authenticated;
commit;
