-- Checks the security repair on a database that holds ONLY the synthetic records (supabase/dev/seed.sql). Rolls itself back.
-- A pass ends with: ROLLBACK-OK ...   Never run it on production: it creates logins and orders (and refuses to start there).
do $t$
declare
  o1 uuid := '5a000000-0000-4000-8000-0000000000a1'; o2 uuid := '5a000000-0000-4000-8000-0000000000a2';
  ua uuid := '5b000000-0000-4000-8000-000000000001'; uf uuid := '5b000000-0000-4000-8000-000000000002'; us uuid := '5b000000-0000-4000-8000-000000000003'; uc uuid := '5b000000-0000-4000-8000-000000000004';
  x uuid := '5e000000-0000-4000-8000-0000000000b1'; n1 uuid := '5e000000-0000-4000-8000-0000000000b2'; n2 uuid := '5e000000-0000-4000-8000-0000000000b3'; n3 uuid := '5e000000-0000-4000-8000-0000000000b4'; n4 uuid := '5e000000-0000-4000-8000-0000000000b5';
  r text[] := '{}'; k text; j jsonb; t0 timestamptz; o orgs; v_c timestamptz; s1 uuid; k1 uuid; n int;
  claims text;
begin
  if exists (select 1 from orgs where id not in (o1, o2)) then raise exception 'FAIL 0: not the synthetic database'; end if;
  select id into s1 from inbound_shipments where reference = 'SYN-PO-1001'; select id into k1 from skus where sku = 'SYN-LP-001'; select * into o from orgs where id = o1;

  -- A. sign-up data grants nothing
  insert into auth.users (id, email, raw_user_meta_data) values (x, 'untrusted@example.test', jsonb_build_object('role', 'shipbay_admin', 'org_id', o1, 'is_owner', true, 'is_sales', true, 'full_name', 'Mallory'));
  if (select role || '/' || coalesce(org_id::text, 'no brand') || '/' || coalesce(is_owner, false)::text || '/' || coalesce(is_sales, false)::text from profiles where id = x) <> 'client_user/no brand/false/false' then raise exception 'FAIL A: %', (select to_jsonb(p) from profiles p where id = x); end if;
  perform set_config('request.jwt.claims', json_build_object('sub', x, 'role', 'authenticated', 'user_metadata', json_build_object('role', 'shipbay_admin'))::text, true); perform set_config('role', 'authenticated', true);
  if is_wms_staff() or is_shipbay() or is_owner() or _is_shipbay_admin() or _is_shipbay_staff() or current_org_id() is not null then raise exception 'FAIL A: reads as staff'; end if;
  if (select count(*) from wms_pallets) + (select count(*) from orgs) + (select count(*) from inventory_moves) + (select count(*) from orders) + (select count(*) from skus) <> 0 then raise exception 'FAIL A: sees data'; end if;
  begin update profiles set role = 'shipbay_admin' where id = x; raise exception 'FAIL A: raised own role'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  perform set_config('role', 'postgres', true);
  r := r || 'A sign-up data asking for admin, a brand, owner and sales yields a client login with no brand that sees nothing and cannot raise itself'::text;

  -- B. the admin screens' way of creating logins still works: create the login (role only in sign-up data, as they send it), then the service role writes the profile
  perform set_config('request.jwt.claims', '{}', true);   -- the Auth service creates logins with no caller identity
  insert into auth.users (id, email, raw_user_meta_data) values (n1, 'new-staff@example.test', '{"full_name":"New Staff","role":"shipbay_staff"}'), (n2, 'new-sales@example.test', '{"full_name":"New Sales","role":"shipbay_sales"}'),
    (n3, 'new-client@example.test', jsonb_build_object('full_name', 'New Client', 'role', 'client_admin', 'org_id', o2)), (n4, 'emp-test@wms.example.test', '{"full_name":"New Floor","role":"wms_employee"}');
  if (select count(*) from profiles where id in (n1, n2, n3, n4) and role = 'client_user' and org_id is null) <> 4 then raise exception 'FAIL B: the trigger alone granted something'; end if;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true); perform set_config('role', 'service_role', true);
  insert into profiles (id, email, full_name, role, org_id, phone, active) values (n1, 'new-staff@example.test', 'New Staff', 'shipbay_staff', null, null, true) on conflict (id) do update set email = excluded.email, full_name = excluded.full_name, role = excluded.role, org_id = excluded.org_id, phone = excluded.phone, active = excluded.active;
  insert into profiles (id, email, full_name, role, org_id, phone, active, is_sales) values (n2, 'new-sales@example.test', 'New Sales', 'shipbay_sales', null, null, true, true) on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, active = excluded.active, is_sales = excluded.is_sales;
  insert into profiles (id, email, full_name, role, org_id, active) values (n3, 'new-client@example.test', 'New Client', 'client_admin', o2, true) on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, active = excluded.active;
  insert into profiles (id, email, full_name, role, org_id, active, employee_no) values (n4, 'emp-test@wms.example.test', 'New Floor', 'wms_employee', null, true, 424242) on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, active = excluded.active, employee_no = excluded.employee_no;
  perform wms_set_pin(n4, '135790');
  update profiles set role = 'shipbay_admin', org_id = null where id = n1;   -- Admin -> Users "change role"
  perform set_config('role', 'postgres', true);
  if (select string_agg(role || coalesce('@' || org_id::text, '') || case when is_sales then '+sales' else '' end, ',' order by email) from profiles where id in (n1, n2, n3, n4)) <> 'wms_employee,client_admin@' || o2 || ',shipbay_sales+sales,shipbay_admin' then
    raise exception 'FAIL B: %', (select string_agg(role || coalesce('@' || org_id::text, ''), ',' order by email) from profiles where id in (n1, n2, n3, n4)); end if;
  if (wms_pin_login(424242, '135790') ->> 'ok')::boolean is not true then raise exception 'FAIL B: the new floor login cannot sign in with its PIN'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', n4, 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true);
  if not is_wms_staff() then raise exception 'FAIL B: new floor login is not floor staff'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', n1, 'role', 'authenticated')::text, true);
  if not _is_shipbay_admin() then raise exception 'FAIL B: role change did not take'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', n3, 'role', 'authenticated')::text, true);
  if current_org_id() is distinct from o2 or (select count(*) from orgs) <> 1 then raise exception 'FAIL B: new client login'; end if;
  perform set_config('role', 'postgres', true);
  r := r || 'B staff, sales, client and floor logins created the way the admin screens do it get the right role, brand, sales flag, employee number and PIN; a role change takes effect'::text;

  -- C. connector keys
  perform set_config('request.jwt.claims', json_build_object('sub', uc, 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true);
  k := wms_org_create_key(o1, 'own brand'); j := wms_org_connector(o1);
  if k not like 'sbk_%' or jsonb_array_length(j -> 'keys') <> 1 then raise exception 'FAIL C: a client could not manage its own keys'; end if;
  begin perform wms_org_create_key(o2, 'x'); raise exception 'FAIL C: client made a key for another brand'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%Not your account%' then raise exception 'FAIL C: %', sqlerrm; end if; end;
  begin perform wms_org_connector(o2); raise exception 'FAIL C: client read another brand''s keys'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%Not your account%' then raise exception 'FAIL C: %', sqlerrm; end if; end;
  foreach claims in array array[json_build_object('sub', x, 'role', 'authenticated')::text, json_build_object('sub', uf, 'role', 'authenticated')::text, json_build_object('sub', n2, 'role', 'authenticated')::text] loop
    perform set_config('request.jwt.claims', claims, true);
    begin perform wms_org_create_key(o1, 'x'); raise exception 'FAIL C: a login with no brand made a key (%)', claims; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%Not your account%' then raise exception 'FAIL C: %', sqlerrm; end if; end;
    begin perform wms_org_connector(o1); raise exception 'FAIL C: a login with no brand read a key list (%)', claims; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%Not your account%' then raise exception 'FAIL C: %', sqlerrm; end if; end;
  end loop;
  perform set_config('request.jwt.claims', json_build_object('sub', us, 'role', 'authenticated')::text, true);
  j := wms_org_connector(o1);
  begin perform wms_org_create_key(o1, 'x'); raise exception 'FAIL C: non-admin staff made a key'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  k := wms_org_create_key(o2, 'by admin'); j := wms_org_connector(o2); if jsonb_array_length(j -> 'keys') <> 1 then raise exception 'FAIL C: admin'; end if;
  perform set_config('role', 'postgres', true);
  if (select count(*) from wms_api_keys) <> 2 then raise exception 'FAIL C: % keys exist', (select count(*) from wms_api_keys); end if;
  r := r || 'C a client manages keys for its own brand only; logins with no brand (untrusted, floor, sales) can neither create nor read; staff can read, admin can do both'::text;

  -- D. orders
  perform set_config('request.jwt.claims', '{"role":"anon"}', true); perform set_config('role', 'anon', true); t0 := clock_timestamp();
  begin insert into orders (org_id, order_number, status) values (o1, 'HACK', 'new'); raise exception 'FAIL D: not signed in, order written';
  exception when insufficient_privilege then null; when others then if sqlerrm like 'FAIL%' then raise; end if; raise exception 'FAIL D: expected a permission refusal, got %', sqlerrm; end;
  begin update orders set status = 'cancelled'; raise exception 'FAIL D: not signed in, update allowed'; exception when insufficient_privilege then null; when others then if sqlerrm like 'FAIL%' then raise; end if; raise exception 'FAIL D: %', sqlerrm; end;
  begin delete from orders; raise exception 'FAIL D: not signed in, delete allowed'; exception when insufficient_privilege then null; when others then if sqlerrm like 'FAIL%' then raise; end if; raise exception 'FAIL D: %', sqlerrm; end;
  begin truncate orders cascade; raise exception 'FAIL D: not signed in, truncate allowed'; exception when insufficient_privilege then null; when others then if sqlerrm like 'FAIL%' then raise; end if; raise exception 'FAIL D: %', sqlerrm; end;
  perform set_config('request.jwt.claims', json_build_object('sub', x, 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true);
  begin insert into orders (org_id, order_number, status) values (o1, 'HACK', 'new'); raise exception 'FAIL D: untrusted login wrote an order'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin insert into orders (org_id, order_number, status) values (gen_random_uuid(), 'HACK', 'new'); raise exception 'FAIL D: order for a brand that does not exist'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  perform set_config('role', 'postgres', true);
  if clock_timestamp() - t0 > interval '1 second' then raise exception 'FAIL D: the refusals took % (the loop is still there)', clock_timestamp() - t0; end if;
  r := r || ('D order writes: not signed in -> insert, update, delete and truncate all refused for lack of permission; untrusted login -> refused; all six refusals took ' || round(extract(epoch from clock_timestamp() - t0)::numeric * 1000) || ' ms');
  -- the cut-off is computed exactly as before for real orders: Friday before the cut-off, Friday after it, Saturday
  insert into orders (org_id, order_number, channel, source, status, total_units, received_at) values (o1, 'CUT-1', 'manual', 'manual', 'new', 1, ('2026-11-20'::date + (o.cutoff_time - interval '1 hour')) at time zone o.timezone) returning cutoff_at into v_c;
  if v_c is distinct from ('2026-11-20'::date + o.cutoff_time) at time zone o.timezone then raise exception 'FAIL D: cut-off before the hour: %', v_c; end if;
  insert into orders (org_id, order_number, channel, source, status, total_units, received_at) values (o1, 'CUT-2', 'manual', 'manual', 'new', 1, ('2026-11-20'::date + (o.cutoff_time + interval '1 hour')) at time zone o.timezone) returning cutoff_at into v_c;
  if v_c is distinct from ((case when o.ships_saturday then '2026-11-21' else '2026-11-23' end)::date + o.cutoff_time) at time zone o.timezone then raise exception 'FAIL D: cut-off after the hour: %', v_c; end if;
  insert into orders (org_id, order_number, channel, source, status, total_units, received_at) values (o1, 'CUT-3', 'manual', 'manual', 'new', 1, ('2026-11-22'::date + time '09:00') at time zone o.timezone) returning cutoff_at into v_c;
  if v_c is distinct from ('2026-11-23'::date + o.cutoff_time) at time zone o.timezone then raise exception 'FAIL D: Sunday order: %', v_c; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true);
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o1, 'STAFF-1', 'manual', 'manual', 'new', 1);
  perform set_config('role', 'postgres', true);
  if (select count(*) from orders where cutoff_at is not null and order_number in ('CUT-1', 'CUT-2', 'CUT-3', 'STAFF-1')) <> 4 then raise exception 'FAIL D: staff order'; end if;
  r := r || 'D ship-by cut-off for real orders is unchanged (before the hour, after it, weekend); staff can still enter an order'::text;

  -- E. receiving and stock are untouched by the repair
  n := (select count(*) from inventory_moves);
  perform set_config('request.jwt.claims', json_build_object('sub', uf, 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true);
  perform 1 from wms_receive_booking(s1, o1, jsonb_build_array(jsonb_build_object('sku', k1, 'cartons', 4, 'units_per_carton', 10)), 2, null, 'repair-check-1', 'partial', null);
  perform set_config('role', 'postgres', true);
  if (select count(*) from wms_pallets where batch_key = 'repair-check-1') <> 2 or (select count(*) from wms_cartons c join wms_pallets p on p.id = c.pallet_id where p.batch_key = 'repair-check-1') <> 8 or (select count(*) from inventory_moves) <> n then raise exception 'FAIL E'; end if;
  r := r || 'E receiving still creates pallets and cartons and posts no stock'::text;
  raise exception 'ROLLBACK-OK %', array_to_string(r, E'\n');
end $t$;
