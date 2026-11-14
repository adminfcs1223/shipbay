-- 2026-11-14 (Derek + "WMS build instructions: Orders connector and Picklist"):
--   1. Stock by location. Units per carton is required at receiving; a pallet's units are posted to its position when it
--      is put away (and re-posted whenever the pallet or its cartons change). Units for pallets already stored are
--      entered with wms_set_units.
--   2. Orders connector. An outside program (one per brand) posts orders with a brand key. Only the fields in the spec
--      are accepted; customer names, addresses and prices are never stored. Orders live in the existing orders /
--      order_lines tables (source = 'connector'), so the brand's portal sees the same rows.
--   3. Picklist: lines paired with current stock by location, pick / undo as normal stock movements.
--   4. Today: what is scheduled in and what has to go out.
--   5. Demo Brand reset.
-- Connector-safe form: additive, create-or-replace, guarded policies.

-- ───────────────────────── 1. stock by location ─────────────────────────
alter table wms_pallets add column if not exists units_total int;   -- units on a pallet that has no carton rows

-- What a pallet holds, by product and location, from its cartons. Open boxes sit on the open-box shelf.
create or replace function _wms_post_stock(p_pallet uuid) returns int
language plpgsql security definer set search_path = public as $$
declare p wms_pallets; r record; v_sum int := 0;
begin
  select * into p from wms_pallets where id = p_pallet;
  if p.id is null then return 0; end if;
  for r in
    with target as (
      select t.sku_id, t.location_id, sum(t.qty)::int as qty from (
        -- counted cartons still closed: at the pallet's position
        select coalesce(c.sku_id, p.sku_id) as sku_id, p.location_id, c.units_per_carton as qty
        from wms_cartons c where c.pallet_id = p.id and not c.cle and c.open_box_at is null and c.units_per_carton is not null
        union all
        -- an NCC product: its marker row carries the units on the pallet, when someone has entered them
        select coalesce(c.sku_id, p.sku_id), p.location_id, c.units_per_carton
        from wms_cartons c where c.pallet_id = p.id and c.cle and c.units_per_carton is not null
        union all
        -- open boxes: the loose units, on their shelf
        select u.sku_id, u.location_id, 1 from wms_units u where u.pallet_id = p.id and u.status = 'shelved'
        union all
        -- a pallet with no carton rows at all
        select p.sku_id, p.location_id, p.units_total
        where p.units_total is not null and not exists (select 1 from wms_cartons c where c.pallet_id = p.id)
      ) t
      where p.status = 'stored' and t.sku_id is not null and t.location_id is not null and t.qty is not null
      group by 1, 2
    ), posted as (
      select m.sku_id, m.location_id, sum(m.qty)::int as qty from inventory_moves m
      where m.ref_type = 'wms_pallet' and m.ref_id = p.id group by 1, 2
    )
    select coalesce(t.sku_id, d.sku_id) as sku_id, coalesce(t.location_id, d.location_id) as location_id,
           coalesce(t.qty, 0) - coalesce(d.qty, 0) as diff, (d.sku_id is null) as first_time
    from target t full join posted d on d.sku_id = t.sku_id and d.location_id is not distinct from t.location_id
  loop
    if r.diff <> 0 then
      insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, created_by, location_id)
      values (p.org_id, r.sku_id, r.diff, case when r.first_time and r.diff > 0 then 'receive' else 'adjust' end, 'wms_pallet', p.id,
              p.psku || case when r.first_time and r.diff > 0 then ' put away' else ' corrected' end, auth.uid(), r.location_id);
      v_sum := v_sum + r.diff;
    end if;
  end loop;
  return v_sum;
end $$;
revoke all on function _wms_post_stock(uuid) from public, anon, authenticated;

create or replace function _wms_pallet_stock_trg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'wms_pallets' then perform _wms_post_stock(new.id);
  else perform _wms_post_stock(new.pallet_id);
  end if;
  return null;
end $$;
create or replace trigger wms_pallets_stock after update of status, location_id, units_total on wms_pallets
  for each row execute function _wms_pallet_stock_trg();
create or replace trigger wms_cartons_stock after update of units_per_carton, open_box_at, sku_id on wms_cartons
  for each row execute function _wms_pallet_stock_trg();
create or replace trigger wms_units_stock after insert or update of status, location_id on wms_units
  for each row execute function _wms_pallet_stock_trg();

-- Units for a pallet already on the floor. p_item = the product's item number on that pallet (null = the pallet's only product).
-- For counted cartons p_units is units per carton; for an NCC product or a pallet with no cartons it is the units on the pallet.
create or replace function wms_set_units(p_pallet uuid, p_item text, p_units int) returns int
language plpgsql security definer set search_path = public as $$
declare p wms_pallets; v_n int; v_item text := nullif(trim(p_item), '');
begin
  if not is_wms_staff() then raise exception 'This login cannot change a pallet.'; end if;
  if p_units is null or p_units < 0 or p_units > 1000000 then raise exception 'Units must be a whole number.'; end if;
  select * into p from wms_pallets where id = p_pallet for update;
  if p.id is null then raise exception 'Pallet not found.'; end if;
  if p.status = 'void' then raise exception '% is void.', p.psku; end if;
  if exists (select 1 from wms_cartons c where c.pallet_id = p.id) then
    update wms_cartons c set units_per_carton = p_units
    where c.pallet_id = p.id and ((v_item is null and not p.mixed) or c.item_no = v_item);
    get diagnostics v_n = row_count;
    if v_n = 0 then raise exception 'That product is not on %.', p.psku; end if;
    if not p.mixed and not p.cle then update wms_pallets set units_per_carton = p_units where id = p.id; end if;
  else
    update wms_pallets set units_total = p_units where id = p.id;
  end if;
  return _wms_post_stock(p.id);
end $$;
revoke all on function wms_set_units(uuid, text, int) from public, anon;
grant execute on function wms_set_units(uuid, text, int) to authenticated;

-- On hand by product and location for a brand (what the picklist pairs against).
create or replace function wms_stock(p_org uuid)
returns table (sku_id uuid, location_id uuid, code text, zone text, on_hand int, first_in timestamptz)
language sql stable security definer set search_path = public as $$
  select m.sku_id, m.location_id, l.code, l.zone, sum(m.qty)::int, min(m.created_at) filter (where m.qty > 0)
  from inventory_moves m join locations l on l.id = m.location_id
  where is_wms_staff() and m.org_id = p_org
  group by 1, 2, 3, 4 having sum(m.qty) <> 0;
$$;
revoke all on function wms_stock(uuid) from public, anon;
grant execute on function wms_stock(uuid) to authenticated;

-- ───────────────────────── 2. orders connector ─────────────────────────
alter table orgs add column if not exists client_code text;
create unique index if not exists orgs_client_code_uq on orgs (upper(client_code)) where client_code is not null;
update orgs set client_code = 'SOULED' where slug = 'souled-worldwide' and client_code is null;

alter table orders add column if not exists closed_at timestamptz;
create unique index if not exists orders_connector_uq on orders (org_id, order_number) where source = 'connector';
alter table order_lines add column if not exists image_url text;
alter table order_lines add column if not exists picked_at timestamptz;
alter table order_lines add column if not exists picked_by uuid;
alter table order_lines add column if not exists picked_by_name text;

create table if not exists wms_api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  label text,
  key_hash text not null unique,
  hint text not null,                       -- last 4 characters, to tell keys apart
  created_by uuid, created_at timestamptz not null default now(),
  last_used_at timestamptz, revoked_at timestamptz
);
alter table wms_api_keys enable row level security;   -- no policies: only the functions below touch it

create table if not exists wms_picks (
  id uuid primary key default gen_random_uuid(),
  line_id uuid not null references order_lines(id),
  order_id uuid not null, org_id uuid not null, sku_id uuid not null,
  location_id uuid not null references locations(id),
  qty int not null check (qty > 0),
  picked_by uuid, picked_by_name text, picked_at timestamptz not null default now(),
  undone_at timestamptz, undone_by_name text
);
create index if not exists wms_picks_line on wms_picks (line_id) where undone_at is null;
alter table wms_picks enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'wms_picks' and policyname = 'wms_staff_read_picks') then
    create policy wms_staff_read_picks on wms_picks for select using (is_wms_staff());
  end if;
end $$;

-- available stock no longer counts a line as reserved once it is picked (the pick already took it off the shelf) or its order is closed
create or replace view inventory_levels as
 select id as sku_id, org_id, sku, name, variant, packaging, low_stock_threshold, active, is_physical,
    (coalesce(( select sum(m.qty) from inventory_moves m where m.sku_id = s.id), 0::bigint))::integer as on_hand,
    (coalesce(( select sum(ol.qty) from order_lines ol join orders o on o.id = ol.order_id
          where ol.sku_id = s.id and ol.picked_at is null and o.closed_at is null
            and o.status = any (array['new'::text, 'on_hold'::text, 'backordered'::text, 'picked'::text, 'packed'::text])), 0::bigint))::integer as reserved
   from skus s;

create or replace function _wms_key_org(p_key text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_hash text := encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex');
begin
  update wms_api_keys set last_used_at = now() where key_hash = v_hash and revoked_at is null returning org_id into v_org;
  return v_org;
end $$;
revoke all on function _wms_key_org(text) from public, anon, authenticated;

create or replace function _wms_order_json(p_order uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('order_number', o.order_number, 'client', g.client_code, 'ship_by', o.ship_by, 'notes', o.notes,
    'status', case when o.closed_at is not null then 'closed' when o.status = 'picked' then 'picked' else 'open' end,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('sku', l.sku, 'name', l.name, 'image_url', l.image_url, 'quantity', l.qty, 'picked', l.picked_at is not null) order by l.id)
                       from order_lines l where l.order_id = o.id), '[]'::jsonb))
  from orders o join orgs g on g.id = o.org_id where o.id = p_order;
$$;
revoke all on function _wms_order_json(uuid) from public, anon, authenticated;

-- POST /api/orders. Returns {status, body}. Unknown fields are refused so that customer data can never be stored.
create or replace function wms_api_create_order(p_key text, p_body jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_org uuid; g orgs; k text; l jsonb; v_id uuid; v_units int := 0; v_no text; v_ship date; i int := 0;
  bad constant text := 'bad_request';
begin
  v_org := _wms_key_org(p_key);
  if v_org is null then return jsonb_build_object('status', 401, 'body', jsonb_build_object('error', 'unauthorized', 'message', 'Missing or unknown key.')); end if;
  select * into g from orgs where id = v_org;
  if p_body is null or jsonb_typeof(p_body) <> 'object' then return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', bad, 'message', 'The body must be a JSON object.')); end if;
  for k in select jsonb_object_keys(p_body) loop
    if k not in ('order_number', 'client', 'ship_by', 'notes', 'lines') then
      return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', bad, 'message', format('Unknown field "%s". Nothing was stored.', k)));
    end if;
  end loop;
  if jsonb_typeof(p_body->'client') is distinct from 'string' or trim(p_body->>'client') = '' then return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', bad, 'message', 'client is required.')); end if;
  if g.client_code is null or upper(trim(p_body->>'client')) <> upper(g.client_code) then
    return jsonb_build_object('status', 403, 'body', jsonb_build_object('error', 'forbidden', 'message', 'This key does not belong to that client.'));
  end if;
  if jsonb_typeof(p_body->'order_number') is distinct from 'string' or trim(p_body->>'order_number') = '' or length(p_body->>'order_number') > 120 then
    return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', bad, 'message', 'order_number is required (text, up to 120 characters).')); end if;
  v_no := trim(p_body->>'order_number');
  if jsonb_typeof(p_body->'ship_by') not in ('string', 'null') or (jsonb_typeof(p_body->'ship_by') = 'string' and p_body->>'ship_by' !~ '^\d{4}-\d{2}-\d{2}$') then
    return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', bad, 'message', 'ship_by must be YYYY-MM-DD or null.')); end if;
  begin v_ship := nullif(p_body->>'ship_by', '')::date;
  exception when others then return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', bad, 'message', 'ship_by is not a real date.')); end;
  if jsonb_typeof(p_body->'notes') not in ('string', 'null') or length(coalesce(p_body->>'notes', '')) > 1000 then
    return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', bad, 'message', 'notes must be text (up to 1000 characters) or null.')); end if;
  if jsonb_typeof(p_body->'lines') is distinct from 'array' or jsonb_array_length(p_body->'lines') < 1 or jsonb_array_length(p_body->'lines') > 500 then
    return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', bad, 'message', 'lines is required: 1 to 500 lines.')); end if;
  for l in select * from jsonb_array_elements(p_body->'lines') loop
    i := i + 1;
    if jsonb_typeof(l) <> 'object' then return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', bad, 'message', format('Line %s must be an object.', i))); end if;
    for k in select jsonb_object_keys(l) loop
      if k not in ('sku', 'name', 'image_url', 'quantity') then
        return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', bad, 'message', format('Unknown field "%s" on line %s. Nothing was stored.', k, i)));
      end if;
    end loop;
    if jsonb_typeof(l->'sku') is distinct from 'string' or trim(l->>'sku') = '' or length(l->>'sku') > 200 then
      return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', bad, 'message', format('Line %s: sku is required.', i))); end if;
    if jsonb_typeof(l->'quantity') is distinct from 'number' or (l->>'quantity') !~ '^\d{1,6}$' or (l->>'quantity')::int < 1 then
      return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', bad, 'message', format('Line %s: quantity must be a whole number above 0.', i))); end if;
    if jsonb_typeof(l->'name') not in ('string', 'null') or length(coalesce(l->>'name', '')) > 300 then
      return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', bad, 'message', format('Line %s: name must be text or null.', i))); end if;
    if jsonb_typeof(l->'image_url') not in ('string', 'null') or length(coalesce(l->>'image_url', '')) > 2000
       or (jsonb_typeof(l->'image_url') = 'string' and l->>'image_url' !~* '^https://') then
      return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', bad, 'message', format('Line %s: image_url must be an https link or null.', i))); end if;
    v_units := v_units + (l->>'quantity')::int;
  end loop;

  select id into v_id from orders where org_id = v_org and source = 'connector' and order_number = v_no;
  if v_id is not null then return jsonb_build_object('status', 200, 'body', _wms_order_json(v_id)); end if;

  begin
    insert into orders (org_id, order_number, channel, source, status, ship_by, notes, total_units)
    values (v_org, v_no, 'connector', 'connector', 'new', v_ship, nullif(trim(p_body->>'notes'), ''), v_units)
    returning id into v_id;
  exception when unique_violation then   -- the same order arriving twice at once
    select id into v_id from orders where org_id = v_org and source = 'connector' and order_number = v_no;
    return jsonb_build_object('status', 200, 'body', _wms_order_json(v_id));
  end;
  insert into order_lines (order_id, sku_id, sku, name, qty, image_url)
  select v_id, (select s.id from skus s where s.org_id = v_org and lower(s.sku) = lower(trim(x->>'sku')) limit 1),
         trim(x->>'sku'), coalesce(nullif(trim(x->>'name'), ''), trim(x->>'sku')), (x->>'quantity')::int, nullif(x->>'image_url', '')
  from jsonb_array_elements(p_body->'lines') with ordinality as t(x, n) order by n;
  return jsonb_build_object('status', 201, 'body', _wms_order_json(v_id));
end $$;
revoke all on function wms_api_create_order(text, jsonb) from public, anon, authenticated;
grant execute on function wms_api_create_order(text, jsonb) to service_role;

-- POST /api/orders/{order_number}/close
create or replace function wms_api_close_order(p_key text, p_order_number text, p_body jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_org uuid; g orgs; k text; o orders;
begin
  v_org := _wms_key_org(p_key);
  if v_org is null then return jsonb_build_object('status', 401, 'body', jsonb_build_object('error', 'unauthorized', 'message', 'Missing or unknown key.')); end if;
  select * into g from orgs where id = v_org;
  if p_body is null or jsonb_typeof(p_body) <> 'object' then return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', 'bad_request', 'message', 'The body must be {"client": "..."}.')); end if;
  for k in select jsonb_object_keys(p_body) loop
    if k <> 'client' then return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', 'bad_request', 'message', format('Unknown field "%s".', k))); end if;
  end loop;
  if jsonb_typeof(p_body->'client') is distinct from 'string' then return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', 'bad_request', 'message', 'client is required.')); end if;
  if g.client_code is null or upper(trim(p_body->>'client')) <> upper(g.client_code) then
    return jsonb_build_object('status', 403, 'body', jsonb_build_object('error', 'forbidden', 'message', 'This key does not belong to that client.'));
  end if;
  select * into o from orders where org_id = v_org and source = 'connector' and order_number = trim(p_order_number) for update;
  if o.id is null then return jsonb_build_object('status', 404, 'body', jsonb_build_object('error', 'not_found', 'message', 'No such order for this client.')); end if;
  if o.closed_at is null and o.status <> 'picked' then
    update orders set closed_at = now() where id = o.id;
  end if;
  return jsonb_build_object('status', 200, 'body', _wms_order_json(o.id));
end $$;
revoke all on function wms_api_close_order(text, text, jsonb) from public, anon, authenticated;
grant execute on function wms_api_close_order(text, text, jsonb) to service_role;

-- Keys: made by an admin, shown once.
create or replace function wms_create_api_key(p_org uuid, p_label text default null) returns text
language plpgsql security definer set search_path = public as $$
declare v_key text := 'sbk_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not exists (select 1 from profiles where id = auth.uid() and role = 'shipbay_admin' and active is not false) then raise exception 'Only an admin can make a connector key.'; end if;
  if not exists (select 1 from orgs where id = p_org and client_code is not null) then raise exception 'Give the brand a client code first.'; end if;
  insert into wms_api_keys (org_id, label, key_hash, hint, created_by)
  values (p_org, nullif(trim(p_label), ''), encode(extensions.digest(v_key, 'sha256'), 'hex'), right(v_key, 4), auth.uid());
  return v_key;
end $$;
create or replace function wms_list_api_keys()
returns table (id uuid, org_id uuid, brand text, client_code text, label text, hint text, created_at timestamptz, last_used_at timestamptz, revoked_at timestamptz)
language sql stable security definer set search_path = public as $$
  select k.id, k.org_id, g.name, g.client_code, k.label, k.hint, k.created_at, k.last_used_at, k.revoked_at
  from wms_api_keys k join orgs g on g.id = k.org_id
  where exists (select 1 from profiles where id = auth.uid() and role = 'shipbay_admin' and active is not false)
  order by k.created_at desc;
$$;
create or replace function wms_revoke_api_key(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from profiles where id = auth.uid() and role = 'shipbay_admin' and active is not false) then raise exception 'Only an admin can revoke a key.'; end if;
  update wms_api_keys set revoked_at = now() where id = p_id and revoked_at is null;
end $$;
create or replace function wms_set_client_code(p_org uuid, p_code text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from profiles where id = auth.uid() and role = 'shipbay_admin' and active is not false) then raise exception 'Only an admin can set a client code.'; end if;
  if coalesce(trim(p_code), '') !~ '^[A-Za-z0-9_-]{2,30}$' then raise exception 'A client code is 2 to 30 letters, numbers, dashes or underscores.'; end if;
  update orgs set client_code = upper(trim(p_code)) where id = p_org;
end $$;
revoke all on function wms_create_api_key(uuid, text) from public, anon;
revoke all on function wms_list_api_keys() from public, anon;
revoke all on function wms_revoke_api_key(uuid) from public, anon;
revoke all on function wms_set_client_code(uuid, text) from public, anon;
grant execute on function wms_create_api_key(uuid, text) to authenticated;
grant execute on function wms_list_api_keys() to authenticated;
grant execute on function wms_revoke_api_key(uuid) to authenticated;
grant execute on function wms_set_client_code(uuid, text) to authenticated;

-- ───────────────────────── 3. picklist ─────────────────────────
create or replace function _wms_today() returns date language sql stable as $$ select (now() at time zone 'America/New_York')::date $$;

-- Brands with their open connector orders, for Orders → brand list.
create or replace function wms_order_brands()
returns table (id uuid, name text, client_code text, due_orders int, due_units int, open_orders int, ready int)
language sql stable security definer set search_path = public as $$
  select g.id, g.name, g.client_code,
    count(distinct o.id) filter (where o.status = 'new' and (o.ship_by is null or o.ship_by <= _wms_today()))::int,
    coalesce(sum(l.qty) filter (where l.picked_at is null and o.status = 'new' and (o.ship_by is null or o.ship_by <= _wms_today())), 0)::int,
    count(distinct o.id) filter (where o.status = 'new')::int,
    count(distinct o.id) filter (where o.status = 'picked')::int
  from orgs g
  left join orders o on o.org_id = g.id and o.source = 'connector' and o.closed_at is null and o.status in ('new', 'picked')
  left join order_lines l on l.order_id = o.id
  where is_wms_staff() and g.status <> 'churned' and (g.client_code is not null or o.id is not null)
  group by g.id, g.name, g.client_code order by g.name;
$$;
revoke all on function wms_order_brands() from public, anon;
grant execute on function wms_order_brands() to authenticated;

-- The picklist for a brand: every line of the orders in view, plus the brand's stock by location, read fresh each time.
create or replace function wms_picklist(p_org uuid, p_day date default null, p_all boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_day date := coalesce(p_day, _wms_today());
begin
  if not is_wms_staff() then raise exception 'This login cannot see orders.'; end if;
  return jsonb_build_object(
    'day', v_day, 'today', _wms_today(),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'order_id', o.id, 'order_number', o.order_number, 'ship_by', o.ship_by, 'notes', o.notes,
               'sku', l.sku, 'sku_id', l.sku_id, 'name', l.name, 'image_url', coalesce(l.image_url, s.image_url), 'qty', l.qty,
               'picked_at', l.picked_at, 'picked_by_name', l.picked_by_name,
               'picked_from', (select string_agg(distinct lc.code, ', ') from wms_picks k join locations lc on lc.id = k.location_id where k.line_id = l.id and k.undone_at is null))
             order by o.ship_by nulls first, o.order_number, l.id)
      from orders o join order_lines l on l.order_id = o.id left join skus s on s.id = l.sku_id
      where o.org_id = p_org and o.source = 'connector' and o.closed_at is null and o.status in ('new', 'picked')
        and (p_all or case when p_day is null then (o.ship_by is null or o.ship_by <= v_day) else o.ship_by = v_day end)), '[]'::jsonb),
    'stock', coalesce((select jsonb_agg(to_jsonb(t)) from wms_stock(p_org) t), '[]'::jsonb),
    'ready', coalesce((select jsonb_agg(jsonb_build_object('order_number', o.order_number, 'ship_by', o.ship_by, 'units', o.total_units) order by o.updated_at desc)
                       from orders o where o.org_id = p_org and o.source = 'connector' and o.closed_at is null and o.status = 'picked'), '[]'::jsonb));
end $$;
revoke all on function wms_picklist(uuid, date, boolean) from public, anon;
grant execute on function wms_picklist(uuid, date, boolean) to authenticated;

-- Pick lines: takes each line's quantity from the brand's locations (open-box shelf first, then oldest stock), as normal stock movements.
-- A line that cannot be filled completely is left alone and reported back.
create or replace function wms_pick(p_lines uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l record; r record; v_name text; v_need int; v_take int; v_done int := 0; v_short jsonb := '[]'::jsonb; v_avail int;
begin
  if not is_wms_staff() then raise exception 'This login cannot pick.'; end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  for l in
    select ol.*, o.org_id, o.order_number, o.status as ostatus, o.closed_at
    from order_lines ol join orders o on o.id = ol.order_id
    where ol.id = any (p_lines) and o.source = 'connector'
    order by o.ship_by nulls first, o.order_number, ol.id
    for update of ol
  loop
    if l.picked_at is not null or l.closed_at is not null then continue; end if;
    if l.sku_id is null then v_short := v_short || jsonb_build_object('id', l.id, 'order_number', l.order_number, 'why', 'No location'); continue; end if;
    perform pg_advisory_xact_lock(hashtext(l.sku_id::text));
    select coalesce(sum(q), 0) into v_avail from (select sum(m.qty) q from inventory_moves m where m.sku_id = l.sku_id and m.location_id is not null group by m.location_id having sum(m.qty) > 0) x;
    if v_avail < l.qty then
      v_short := v_short || jsonb_build_object('id', l.id, 'order_number', l.order_number, 'why', case when v_avail = 0 then 'No location' else 'Short' end, 'on_hand', v_avail); continue;
    end if;
    v_need := l.qty;
    for r in
      select m.location_id, sum(m.qty)::int as on_hand
      from inventory_moves m join locations lc on lc.id = m.location_id
      where m.sku_id = l.sku_id group by m.location_id, lc.zone, lc.code having sum(m.qty) > 0
      order by (lc.zone = 'open box') desc, min(m.created_at) filter (where m.qty > 0), lc.code
    loop
      exit when v_need = 0;
      v_take := least(v_need, r.on_hand);
      insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, created_by, location_id)
      values (l.org_id, l.sku_id, -v_take, 'pick', 'order_line', l.id, 'Order ' || l.order_number, auth.uid(), r.location_id);
      insert into wms_picks (line_id, order_id, org_id, sku_id, location_id, qty, picked_by, picked_by_name)
      values (l.id, l.order_id, l.org_id, l.sku_id, r.location_id, v_take, auth.uid(), v_name);
      v_need := v_need - v_take;
    end loop;
    update order_lines set picked_at = now(), picked_by = auth.uid(), picked_by_name = v_name where id = l.id;
    v_done := v_done + 1;
    if not exists (select 1 from order_lines x where x.order_id = l.order_id and x.picked_at is null) then
      update orders set status = 'picked' where id = l.order_id and status = 'new';
    end if;
  end loop;
  return jsonb_build_object('picked', v_done, 'not_picked', v_short);
end $$;
revoke all on function wms_pick(uuid[]) from public, anon;
grant execute on function wms_pick(uuid[]) to authenticated;

create or replace function wms_unpick(p_lines uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l record; k record; v_name text; v_done int := 0;
begin
  if not is_wms_staff() then raise exception 'This login cannot pick.'; end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  for l in
    select ol.*, o.org_id, o.order_number, o.closed_at from order_lines ol join orders o on o.id = ol.order_id
    where ol.id = any (p_lines) and o.source = 'connector' for update of ol
  loop
    if l.picked_at is null then continue; end if;
    for k in select * from wms_picks where line_id = l.id and undone_at is null for update loop
      insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, created_by, location_id)
      values (l.org_id, k.sku_id, k.qty, 'pick', 'order_line', l.id, 'Pick undone · order ' || l.order_number, auth.uid(), k.location_id);
      update wms_picks set undone_at = now(), undone_by_name = v_name where id = k.id;
    end loop;
    update order_lines set picked_at = null, picked_by = null, picked_by_name = null where id = l.id;
    update orders set status = 'new' where id = l.order_id and status = 'picked';
    v_done := v_done + 1;
  end loop;
  return jsonb_build_object('undone', v_done);
end $$;
revoke all on function wms_unpick(uuid[]) from public, anon;
grant execute on function wms_unpick(uuid[]) to authenticated;

-- ───────────────────────── 4. today ─────────────────────────
create or replace function wms_today() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d date := _wms_today();
begin
  if not is_wms_staff() then raise exception 'This login cannot see the floor.'; end if;
  return jsonb_build_object(
    'today', d,
    'inbound', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'brand', g.name, 'reference', i.reference, 'carrier', i.carrier, 'expected_at', i.expected_at,
                           'pallets', i.pallets, 'cartons', i.cartons, 'status', i.status) order by i.expected_at nulls last, g.name)
                         from inbound_shipments i join orgs g on g.id = i.org_id
                         where i.status in ('expected', 'in_transit') and (i.expected_at is null or i.expected_at <= d + 7)), '[]'::jsonb),
    'pallets', (select jsonb_build_object(
                  'received_today', count(*) filter (where (p.received_at at time zone 'America/New_York')::date = d and p.status <> 'void'),
                  'to_scan', count(*) filter (where p.status = 'open'),
                  'to_put_away', count(*) filter (where p.status = 'counted'),
                  'stored_today', count(*) filter (where p.status = 'stored' and (p.stored_at at time zone 'America/New_York')::date = d)) from wms_pallets p),
    'orders', coalesce((select jsonb_agg(to_jsonb(x) order by x.ship_by nulls first, x.brand) from (
                  select g.id as org_id, g.name as brand, o.ship_by,
                         count(distinct o.id)::int as orders,
                         count(distinct o.id) filter (where o.status = 'picked')::int as ready,
                         coalesce(sum(l.qty), 0)::int as units,
                         coalesce(sum(l.qty) filter (where l.picked_at is not null), 0)::int as picked_units
                  from orders o join orgs g on g.id = o.org_id join order_lines l on l.order_id = o.id
                  where o.source = 'connector' and o.closed_at is null and o.status in ('new', 'picked') and (o.ship_by is null or o.ship_by <= d + 7)
                  group by g.id, g.name, o.ship_by) x), '[]'::jsonb),
    'picked_today', (select coalesce(sum(k.qty), 0) from wms_picks k where k.undone_at is null and (k.picked_at at time zone 'America/New_York')::date = d),
    'closed_today', (select count(*) from orders o where o.source = 'connector' and (o.closed_at at time zone 'America/New_York')::date = d));
end $$;
revoke all on function wms_today() from public, anon;
grant execute on function wms_today() to authenticated;

-- ───────────────────────── 5. demo brand ─────────────────────────
-- Rebuilds Demo Brand's products and stock, clears its orders, and hands back a fresh key for the demo orders to be
-- posted through the real endpoint. Touches nothing outside Demo Brand.
create or replace function wms_demo_reset() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_key text := 'sbk_demo_' || encode(extensions.gen_random_bytes(20), 'hex'); r record; v_sku uuid; v_loc uuid; n int := 0;
begin
  if not is_wms_staff() then raise exception 'This login cannot reset the demo.'; end if;
  select id into v_org from orgs where slug = 'demo-brand';
  if v_org is null then
    insert into orgs (name, slug, status, client_code, notes) values ('Demo Brand', 'demo-brand', 'active', 'DEMO', 'Sample data for the WMS orders and picklist. Not a client.') returning id into v_org;
  end if;
  delete from wms_picks where org_id = v_org;
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
  -- the tee also sits in a second location, to show "pick from here first, also in…"
  insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, note, created_by, location_id)
  select v_org, s.id, 12, 'receive', 'demo', 'Demo stock', auth.uid(), (select id from locations where code = 'B-01')
  from skus s where s.org_id = v_org and s.sku = 'DEMO-TEE-BLK-M';
  update wms_api_keys set revoked_at = now() where org_id = v_org and revoked_at is null;
  insert into wms_api_keys (org_id, label, key_hash, hint, created_by)
  values (v_org, 'Demo reset', encode(extensions.digest(v_key, 'sha256'), 'hex'), right(v_key, 4), auth.uid());
  return jsonb_build_object('org_id', v_org, 'client', 'DEMO', 'key', v_key, 'today', _wms_today());
end $$;
revoke all on function wms_demo_reset() from public, anon;
grant execute on function wms_demo_reset() to authenticated;

-- ───────────────────────── 6. receiving: units per carton is required for counted cartons ─────────────────────────
-- wms_receive as of 20261114110000 with that one check added
create or replace function wms_receive(p_org uuid, p_lines jsonb, p_pallets int default 1, p_notes text default null, p_key text default null)
returns setof wms_pallets
language plpgsql security definer set search_path = public as $$
declare
  v_n int := coalesce(p_pallets, 1);
  v_key text := coalesce(nullif(trim(p_key), ''), gen_random_uuid()::text);
  v_who text; v_lines int; v_total int := 0; v_mixed boolean; v_allfba boolean := true;
  l jsonb; s skus; i int; g int; v_id uuid; v_num text; v_w int; v_seq int; v_c int; v_upc int; v_name text; v_fba boolean; v_cle boolean; v_allcle boolean := true; v_log int := 0;
begin
  if not is_wms_staff() then raise exception 'This login cannot receive pallets.'; end if;
  if v_n < 1 or v_n > 60 then raise exception 'Receive between 1 and 60 pallets at a time.'; end if;
  if not exists (select 1 from orgs where id = p_org) then raise exception 'Pick a brand first.'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1 then raise exception 'Pick the product.'; end if;
  v_lines := jsonb_array_length(p_lines);
  if v_lines > 20 then raise exception 'A pallet takes up to 20 products here.'; end if;
  v_mixed := v_lines > 1;

  -- check every line before anything is written
  for l in select * from jsonb_array_elements(p_lines) loop
    v_cle := coalesce((l->>'cle')::boolean, false);
    v_c := case when v_cle then 1 else coalesce(nullif(l->>'cartons', '')::int, 0) end;   -- a CLE product has no carton count: one marker row stands for it
    if v_c < 0 or v_c > 500 then raise exception 'A line holds between 0 and 500 cartons.'; end if;
    if v_mixed and v_c < 1 then raise exception 'On a mixed pallet every product needs its carton count.'; end if;
    if nullif(l->>'units_per_carton', '') is not null and (l->>'units_per_carton')::int < 1 then raise exception 'Units per carton starts at 1.'; end if;
    if not v_cle and v_c > 0 and nullif(l->>'units_per_carton', '') is null then raise exception 'Units per carton is needed: it is what puts the stock on the shelf.'; end if;
    if nullif(l->>'sku', '') is not null then
      if not exists (select 1 from skus where id = (l->>'sku')::uuid and org_id = p_org) then raise exception 'One of those products is not on this brand''s list.'; end if;
    elsif coalesce(trim(l->>'name'), '') = '' then raise exception 'Pick the product, or say what it is.';
    end if;
    v_total := v_total + v_c;
    v_allfba := v_allfba and coalesce((l->>'fba')::boolean, false);
    v_allcle := v_allcle and v_cle;
    if not v_cle then v_log := v_log + v_c; end if;   -- cartons that are counted, labelled and scanned
  end loop;
  if v_total > 500 then raise exception 'A pallet holds up to 500 cartons here.'; end if;

  if exists (select 1 from wms_pallets where batch_key = v_key) then
    return query select * from wms_pallets where batch_key = v_key order by batch_pos; return;
  end if;

  select coalesce(full_name, email) into v_who from profiles where id = auth.uid();
  v_w := greatest(2, length(v_total::text));
  for i in 1..v_n loop
    select num into v_num from wms_psku_holds where batch_key = v_key and pos = i;   -- a number held when the labels were printed first
    if v_num is null then v_num := lpad(nextval('wms_psku_seq')::text, 6, '0'); end if;
    l := p_lines->0; s := null;
    if not v_mixed and nullif(l->>'sku', '') is not null then select * into s from skus where id = (l->>'sku')::uuid; end if;
    insert into wms_pallets (psku, org_id, status, mixed, fba, cle, sku_id, item_no, item_name, cartons, units_per_carton, notes, batch_key, batch_pos, batch_size, client_key,
                             received_by, received_by_name, counted_at, counted_by_name)
    values ('PSKU-' || v_num, p_org, case when v_log > 0 then 'open' else 'counted' end, v_mixed, v_allfba, v_allcle,
            case when v_mixed then null else s.id end, case when v_mixed then null else s.sku end,
            case when v_mixed then 'Mixed pallet · ' || v_lines || ' products' else coalesce(s.name, left(trim(l->>'name'), 300)) end,
            nullif(v_log, 0), case when v_mixed then null else nullif(l->>'units_per_carton', '')::int end, nullif(trim(p_notes), ''),
            v_key, i, v_n, v_key || ':' || i, auth.uid(), v_who,
            case when v_log > 0 then null else now() end, case when v_log > 0 then null else v_who end)
    returning id into v_id;
    v_seq := 0;
    for l in select * from jsonb_array_elements(p_lines) loop
      s := null;
      if nullif(l->>'sku', '') is not null then select * into s from skus where id = (l->>'sku')::uuid; end if;
      v_cle := coalesce((l->>'cle')::boolean, false);
      v_c := case when v_cle then 1 else coalesce(nullif(l->>'cartons', '')::int, 0) end; v_upc := nullif(l->>'units_per_carton', '')::int;
      v_name := coalesce(s.name, left(trim(l->>'name'), 300)); v_fba := coalesce((l->>'fba')::boolean, false);
      for g in 1..v_c loop
        v_seq := v_seq + 1;
        insert into wms_cartons (pallet_id, org_id, seq, code, sku_id, item_no, item_name, units_per_carton, fba, cle, scanned_at, scanned_by_name)
        values (v_id, p_org, v_seq, 'C' || v_num || lpad(v_seq::text, v_w, '0'), s.id, s.sku, v_name, v_upc, v_fba, v_cle, case when v_cle then now() end, case when v_cle then 'NCC' end);
      end loop;
    end loop;
    if v_log = 0 then perform _wms_pick_location(v_id); end if;
  end loop;
  return query select * from wms_pallets where batch_key = v_key order by batch_pos;
end $$;
revoke all on function wms_receive(uuid, jsonb, int, text, text) from public, anon;
grant execute on function wms_receive(uuid, jsonb, int, text, text) to authenticated;
