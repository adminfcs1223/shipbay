-- ROLLBACK for 20261208_order_integrity.sql. Puts order access back exactly as it was before: signed-in logins hold every
-- table privilege on orders, order_lines, shipments, events, wms_picks and returns again (the public key too, except on orders,
-- where the security repair had already left it only REFERENCES and TRIGGER), and admin, staff and sales can again insert,
-- rewrite and delete those rows directly.
-- No DROP (the database connector refuses it): the ten guard triggers are switched off, the twelve restrictive access rules
-- are opened so they refuse nothing, the privileges are granted back, and the one callable function is closed to logins.
-- Nothing written while the hardening was on is touched. Applying the candidate again turns everything back on.
-- WARNING: after this rollback orders can again be deleted and re-homed through the API. Roll back only to recover.
begin;
alter table public.orders disable trigger orders_history_guard;
alter table public.orders disable trigger orders_direct_edit_guard;
alter table public.orders disable trigger orders_no_truncate;
alter table public.order_lines disable trigger order_lines_history_guard;
alter table public.order_lines disable trigger order_lines_no_truncate;
alter table public.order_lines disable trigger order_lines_sync_guard;
alter table public.shipments disable trigger shipments_history_guard;
alter table public.shipments disable trigger shipments_no_truncate;
alter table public.events disable trigger events_history_guard;
alter table public.events disable trigger events_no_truncate;
do $$ declare r record;
begin
  for r in select * from (values ('orders', 'insert'), ('orders', 'delete'), ('order_lines', 'insert'), ('order_lines', 'update'), ('order_lines', 'delete'),
      ('shipments', 'insert'), ('shipments', 'update'), ('shipments', 'delete'), ('events', 'insert'), ('events', 'update'), ('events', 'delete'), ('returns', 'delete')) v(tbl, cmd) loop
    execute format('alter policy %I on public.%I %s', r.tbl || '_no_direct_' || r.cmd, r.tbl, case r.cmd when 'insert' then 'with check (true)' when 'update' then 'using (true) with check (true)' else 'using (true)' end);
  end loop;
end $$;
grant insert, delete, truncate on table public.orders to authenticated;
grant references, trigger on table public.orders to anon, authenticated;
grant insert, update, delete, truncate, references, trigger on table public.order_lines to anon, authenticated;
grant insert, update, delete, truncate, references, trigger on table public.shipments to anon, authenticated;
grant insert, update, delete, truncate, references, trigger on table public.events to anon, authenticated;
grant insert, update, delete, truncate, references, trigger on table public.wms_picks to anon, authenticated;
grant delete, truncate on table public.returns to anon, authenticated;
revoke all on function public._order_commitment(uuid) from public, anon, authenticated, service_role;
commit;
