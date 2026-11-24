-- ROLLBACK for 20261207_inventory_ledger_hardening.sql. Puts ledger access back exactly as it was before: every signed-in
-- login and the public key hold every table privilege again, and admin, staff and sales can again write rows directly.
-- No DROP (the database connector refuses it): the three guard triggers are switched off, the three restrictive access rules
-- are opened so they refuse nothing, the privileges are granted back, and the stock-correction function is closed to logins.
-- Rows written while the hardening was on are kept. Applying the candidate again turns everything back on.
-- WARNING: after this rollback the demo reset can again be pointed at a real brand by renaming it. Roll back only to recover.
begin;
alter table public.inventory_moves disable trigger inventory_moves_append_only;
alter table public.inventory_moves disable trigger inventory_moves_no_truncate;
alter table public.inventory_moves disable trigger inventory_moves_insert_rules;
alter policy ledger_no_direct_insert on public.inventory_moves with check (true);
alter policy ledger_no_direct_update on public.inventory_moves using (true) with check (true);
alter policy ledger_no_direct_delete on public.inventory_moves using (true);
grant insert, update, delete, truncate, references, trigger on table public.inventory_moves to anon, authenticated;
revoke all on function public.wms_stock_correct(uuid, uuid, text, integer, text) from public, anon, authenticated;
-- the demo reset goes back to its text and permissions before the hardening (it finds the demo brand by its slug again). The
-- register table wms_demo_brand stays (no DROP), closed and unused; a demo brand registered meanwhile keeps working either way.
create or replace function public.wms_demo_reset() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_org uuid; v_key text := 'sbk_demo_' || encode(extensions.gen_random_bytes(20), 'hex'); r record; v_sku uuid; v_loc uuid; n int := 0;
begin
  if not is_wms_staff() then raise exception 'This login cannot reset the demo.'; end if;
  select id into v_org from orgs where slug = 'demo-brand';
  if v_org is null then
    insert into orgs (name, slug, status, client_code, notes) values ('Demo Brand', 'demo-brand', 'active', 'DEMO', 'Sample data for the WMS orders and picklist. Not a client.') returning id into v_org;
  end if;
  delete from wms_waves where org_id = v_org; delete from wms_picks where org_id = v_org;
  delete from order_lines where order_id in (select id from orders where org_id = v_org);
  delete from orders where org_id = v_org;
  delete from inventory_moves where org_id = v_org;
  for r in select * from (values
      ('DEMO-TEE-BLK-M', 'Logo Tee, Black, M',        'A-01', 40, '0F1B2A'),
      ('DEMO-TEE-WHT-M', 'Logo Tee, White, M',        'A-01', 25, 'C9C5BC'),
      ('DEMO-HOOD-GRY-L','Pullover Hoodie, Grey, L',  'A-02', 18, '6B7280'),
      ('DEMO-CAP-NVY',   'Dad Cap, Navy',             'A-03', 30, '1E3A8A'),
      ('DEMO-SOCK-3PK',  'Crew Socks, 3 Pack',        'A-04', 60, 'B45309'),
      ('DEMO-MUG-11',    'Ceramic Mug, 11 oz',        'B-01', 24, '0F766E'),
      ('DEMO-TOTE-NAT',  'Canvas Tote, Natural',      'B-02', 35, 'A16207'),
      ('DEMO-STKR-PK',   'Sticker Pack',              'B-02', 200,'BE123C'),
      ('DEMO-BTL-20',    'Steel Bottle, 20 oz',       'B-03', 2,  '334155'),
      ('DEMO-NOTE-A5',   'Notebook, A5',              'B-04', 45, '7C3AED'),
      ('DEMO-PIN-SET',   'Enamel Pin Set',            'B-04', 50, 'FF6B15'),
      ('DEMO-POSTER-18', 'Poster, 18 × 24',           null,   0,  '15803D')
    ) as t(sku, name, loc, qty, color)
  loop
    insert into skus (org_id, sku, name, active, image_url)
    values (v_org, r.sku, r.name, true, 'https://placehold.co/400x400/' || r.color || '/FFFFFF/png?text=' || replace(split_part(r.name, ',', 1), ' ', '+'))
    on conflict (org_id, sku) do update set name = excluded.name, image_url = excluded.image_url, active = true
    returning id into v_sku;
    if r.loc is not null and r.qty > 0 then
      select id into v_loc from locations where code = r.loc;
      insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, note, created_by, location_id)
      values (v_org, v_sku, r.qty, 'receive', 'demo', 'Demo stock', auth.uid(), v_loc);
      n := n + 1;
    end if;
  end loop;
  insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, note, created_by, location_id)
  select v_org, s.id, 12, 'receive', 'demo', 'Demo stock', auth.uid(), (select id from locations where code = 'B-01')
  from skus s where s.org_id = v_org and s.sku = 'DEMO-TEE-BLK-M';
  update wms_api_keys set revoked_at = now() where org_id = v_org and revoked_at is null;
  insert into wms_api_keys (org_id, label, key_hash, hint, created_by)
  values (v_org, 'Demo reset', encode(extensions.digest(v_key, 'sha256'), 'hex'), right(v_key, 4), auth.uid());
  return jsonb_build_object('org_id', v_org, 'client', 'DEMO', 'key', v_key, 'today', _wms_today());
end $$;
grant execute on function public.wms_demo_reset() to authenticated, service_role;
commit;
