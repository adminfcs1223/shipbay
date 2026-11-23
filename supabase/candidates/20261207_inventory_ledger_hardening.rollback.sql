-- ROLLBACK for 20261207_inventory_ledger_hardening.sql. Puts ledger access back exactly as it was before: every signed-in
-- login and the public key hold every table privilege again, and admin, staff and sales can again write rows directly.
-- No DROP (the database connector refuses it): the three guard triggers are switched off, the three restrictive access rules
-- are opened so they refuse nothing, the privileges are granted back, and the stock-correction function is closed to logins.
-- Rows written while the hardening was on are kept. Applying the candidate again turns everything back on.
begin;
alter table public.inventory_moves disable trigger inventory_moves_append_only;
alter table public.inventory_moves disable trigger inventory_moves_no_truncate;
alter table public.inventory_moves disable trigger inventory_moves_insert_rules;
alter policy ledger_no_direct_insert on public.inventory_moves with check (true);
alter policy ledger_no_direct_update on public.inventory_moves using (true) with check (true);
alter policy ledger_no_direct_delete on public.inventory_moves using (true);
grant insert, update, delete, truncate, references, trigger on table public.inventory_moves to anon, authenticated;
revoke all on function public.wms_stock_correct(uuid, uuid, text, integer, text) from public, anon, authenticated;
commit;
