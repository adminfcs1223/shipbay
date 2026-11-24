-- Staging for supabase/tests/deno/mvp-http.test.ts (LOCAL test database only): one product MVP-H of the session brand, received
-- as 2 cartons of 10 by the floor login and stored at P-50 through the Nexus journal (the commit done here as the service
-- login, in place of the bridge). Committed: the local database is rebuilt before every run.
do $$ declare o1 uuid := '5a000000-0000-4000-8000-0000000000a1'; k uuid; p wms_pallets; c record; j jsonb;
begin
  insert into skus (org_id, sku, name, barcode) values (o1, 'MVP-H', 'MVP HTTP product', 'MVP-H-BC') returning id into k;
  perform set_config('request.jwt.claims', json_build_object('sub', '5b000000-0000-4000-8000-000000000002', 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true);
  select * into p from wms_receive(o1, jsonb_build_array(jsonb_build_object('sku', k, 'cartons', 2, 'units_per_carton', 10)), 1, 'MVP HTTP test', 'mvp-http-rcv');
  perform set_config('role', 'postgres', true);
  for c in select code from wms_cartons where pallet_id = p.id loop perform set_config('role', 'authenticated', true); perform wms_scan_carton(c.code); perform set_config('role', 'postgres', true); end loop;
  perform set_config('role', 'authenticated', true); perform wms_complete_count(p.id); j := wms_putaway_begin(p.psku, 'P-50');
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', '{"role":"service_role"}', true); perform wms_nexus_op_commit((j ->> 'op')::uuid);
  perform set_config('role', 'postgres', true);
  if (select sum(qty) from inventory_moves where sku_id = k) <> 20 then raise exception 'staging failed'; end if;
end $$;
