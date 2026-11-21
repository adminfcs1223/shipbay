-- CANDIDATE (local test database only). Nexus v1: the warehouse-floor system for locations, pallets, FIFO and cycle counts.
-- Lives in the ShipBay database and reads the SAME locations and pallets the ShipBay WMS writes, so there is one pallet count.
-- Nothing existing is changed: no table altered, no existing function replaced.
--   * Nexus screens: active ShipBay WMS staff (admin, staff, wms_employee).
--   * Other WMSes (ShipBay's own, Souled Sneakers' own): a connection key scoped to named brands; read-only API functions.
--   * Cycle counts record what was found (found / misplaced / missing / unexpected). They never move stock or pallets.
begin;

create table public.nexus_clients (            -- a WMS allowed to ask Nexus about its brands
  id uuid primary key default gen_random_uuid(), name text not null check (btrim(name) <> ''),
  org_ids uuid[] not null check (cardinality(org_ids) > 0), key_hash text not null unique,
  active boolean not null default true, created_by uuid, created_at timestamptz not null default now(), last_used_at timestamptz);
create table public.nexus_counts (
  id uuid primary key default gen_random_uuid(), zone text, org_id uuid references public.orgs(id),
  status text not null default 'open' check (status in ('open', 'closed')),
  started_by uuid, started_by_name text, started_at timestamptz not null default now(), closed_by_name text, closed_at timestamptz);
create table public.nexus_count_lines (
  id bigserial primary key, count_id uuid not null references public.nexus_counts(id), pallet_id uuid not null references public.wms_pallets(id),
  psku text not null, org_id uuid not null, expected_location uuid references public.locations(id),
  result text not null default 'pending' check (result in ('pending', 'found', 'misplaced', 'missing', 'unexpected')),
  seen_location uuid references public.locations(id), counted_by_name text, counted_at timestamptz, unique (count_id, pallet_id));
alter table public.nexus_clients enable row level security; alter table public.nexus_counts enable row level security; alter table public.nexus_count_lines enable row level security;
revoke all on public.nexus_clients, public.nexus_counts, public.nexus_count_lines from public, anon, authenticated, service_role;
revoke all on sequence public.nexus_count_lines_id_seq from public, anon, authenticated, service_role;

-- active floor login or an error
create function public._nexus_staff(out uid uuid, out who text, out role text) language plpgsql stable security definer set search_path to 'public' as $$
begin
  select p.id, coalesce(p.full_name, p.email), p.role into uid, who, role from profiles p
  where p.id = auth.uid() and p.active and p.role in ('shipbay_admin', 'shipbay_staff', 'wms_employee');
  if uid is null then raise exception 'This login cannot use Nexus.'; end if;
end $$;
revoke all on function public._nexus_staff() from public, anon, authenticated, service_role;

-- one definition of the pallet counts, used by the screens and the API. "held" exists only once the receiving update is applied.
create view public.v_nexus_pallets as
select p.id, p.psku, p.org_id, g.name as org_name, p.status, p.location_id, l.code as location_code, l.zone, p.sku_id, p.item_no, p.item_name, p.mixed,
  p.cartons, p.units_total, p.received_at, p.stored_at, coalesce((to_jsonb(p) ->> 'held')::boolean, false) as held,
  greatest(0, floor(extract(epoch from (now() - p.received_at)) / 86400))::int as age_days
from public.wms_pallets p join public.orgs g on g.id = p.org_id left join public.locations l on l.id = p.location_id
where p.status <> 'void';
revoke all on public.v_nexus_pallets from public, anon, authenticated, service_role;

create function public._nexus_brand_counts(p_orgs uuid[]) returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('org_id', g.id, 'brand', g.name,
    'pallets_stored', (select count(*) from v_nexus_pallets v where v.org_id = g.id and v.status = 'stored'),
    'pallets_waiting', (select count(*) from v_nexus_pallets v where v.org_id = g.id and v.status <> 'stored' and not v.held),
    'pallets_on_hold', (select count(*) from v_nexus_pallets v where v.org_id = g.id and v.held and v.status <> 'stored'),
    'units_on_hand', (select coalesce(sum(m.qty), 0) from inventory_moves m where m.org_id = g.id),
    'last_change', (select max(greatest(v.received_at, coalesce(v.stored_at, v.received_at))) from v_nexus_pallets v where v.org_id = g.id)) order by g.name), '[]')
  from orgs g where (p_orgs is null and exists (select 1 from wms_pallets p where p.org_id = g.id and p.status <> 'void')) or g.id = any(p_orgs);
$$;
revoke all on function public._nexus_brand_counts(uuid[]) from public, anon, authenticated, service_role;

-- ───────── screens (active floor staff) ─────────
create function public.nexus_overview() returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform 1 from _nexus_staff();
  return jsonb_build_object('brands', _nexus_brand_counts(null),
    'locations', (select jsonb_build_object('total', count(*), 'used', count(*) filter (where exists (select 1 from v_nexus_pallets v where v.location_id = l.id and v.status = 'stored')))
                  from locations l where l.active and l.kind = 'pallet'),
    'zones', (select coalesce(jsonb_agg(z order by z ->> 'zone'), '[]') from (select jsonb_build_object('zone', coalesce(l.zone, '—'), 'positions', count(*),
                'used', count(*) filter (where exists (select 1 from v_nexus_pallets v where v.location_id = l.id and v.status = 'stored'))) z
              from locations l where l.active and l.kind = 'pallet' group by l.zone) s),
    'open_counts', (select count(*) from nexus_counts where status = 'open'));
end $$;
create function public.nexus_pallets(p_org uuid default null, p_q text default null) returns setof public.v_nexus_pallets
language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform 1 from _nexus_staff();
  return query select * from v_nexus_pallets v where (p_org is null or v.org_id = p_org)
    and (coalesce(btrim(p_q), '') = '' or v.psku ilike '%' || btrim(p_q) || '%' or v.location_code ilike '%' || btrim(p_q) || '%' or v.item_name ilike '%' || btrim(p_q) || '%' or v.item_no ilike '%' || btrim(p_q) || '%')
    order by v.received_at limit 1000;
end $$;

-- FIFO: the stored pallets holding a product, first received first, with what is on hand at each position right now
create function public._nexus_fifo(p_org uuid, p_sku uuid) returns table (pick_order int, psku text, location_code text, zone text, received_at timestamptz, age_days int, on_hand_here int)
language sql stable security definer set search_path to 'public' as $$
  select row_number() over (order by v.received_at, v.psku)::int, v.psku, v.location_code, v.zone, v.received_at, v.age_days,
    (select coalesce(sum(m.qty), 0)::int from inventory_moves m where m.sku_id = p_sku and m.location_id = v.location_id)
  from v_nexus_pallets v
  where v.org_id = p_org and v.status = 'stored' and not v.held
    and (v.sku_id = p_sku or exists (select 1 from wms_cartons c where c.pallet_id = v.id and c.sku_id = p_sku))
  order by v.received_at, v.psku;
$$;
revoke all on function public._nexus_fifo(uuid, uuid) from public, anon, authenticated, service_role;
create function public.nexus_fifo(p_org uuid, p_sku uuid) returns table (pick_order int, psku text, location_code text, zone text, received_at timestamptz, age_days int, on_hand_here int)
language plpgsql stable security definer set search_path to 'public' as $$
begin perform 1 from _nexus_staff(); return query select * from _nexus_fifo(p_org, p_sku); end $$;
create function public.nexus_products(p_org uuid) returns table (sku_id uuid, sku text, name text, pallets int)
language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform 1 from _nexus_staff();
  return query select s.id, s.sku, s.name, count(distinct v.id)::int from skus s join v_nexus_pallets v on v.org_id = s.org_id and v.status = 'stored'
    and (v.sku_id = s.id or exists (select 1 from wms_cartons c where c.pallet_id = v.id and c.sku_id = s.id))
  where s.org_id = p_org group by s.id, s.sku, s.name order by s.sku;
end $$;

-- ───────── cycle counts ─────────
create function public.nexus_count_start(p_zone text default null, p_org uuid default null) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare c record; v_id uuid; v_zone text := nullif(btrim(p_zone), '');
begin
  select * into c from _nexus_staff();
  if exists (select 1 from nexus_counts where status = 'open' and zone is not distinct from v_zone and org_id is not distinct from p_org) then
    raise exception 'A count of that area is already open. Finish it first.'; end if;
  insert into nexus_counts (zone, org_id, started_by, started_by_name) values (v_zone, p_org, c.uid, c.who) returning id into v_id;
  insert into nexus_count_lines (count_id, pallet_id, psku, org_id, expected_location)
  select v_id, v.id, v.psku, v.org_id, v.location_id from v_nexus_pallets v
  where v.status = 'stored' and (v_zone is null or v.zone = v_zone) and (p_org is null or v.org_id = p_org);
  return v_id;
end $$;
create function public.nexus_count_scan(p_count uuid, p_location text, p_psku text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare c record; k nexus_counts; l locations; p wms_pallets; ln nexus_count_lines; v_res text;
  v_loc text := upper(regexp_replace(btrim(coalesce(p_location, '')), '^LOC-', '', 'i')); v_psku text := upper(btrim(coalesce(p_psku, '')));
begin
  select * into c from _nexus_staff();
  select * into k from nexus_counts where id = p_count for update;
  if k.id is null or k.status <> 'open' then raise exception 'That count is not open.'; end if;
  select * into l from locations where upper(code) = v_loc;
  if l.id is null then raise exception 'Position % is not on file.', coalesce(nullif(v_loc, ''), '(blank)'); end if;
  select * into p from wms_pallets where upper(psku) = v_psku and status <> 'void';
  if p.id is null then raise exception 'Pallet % is not on file.', coalesce(nullif(v_psku, ''), '(blank)'); end if;
  select * into ln from nexus_count_lines where count_id = p_count and pallet_id = p.id;
  v_res := case when ln.id is null then 'unexpected' when ln.expected_location = l.id then 'found' when ln.result = 'unexpected' then 'unexpected' else 'misplaced' end;
  insert into nexus_count_lines (count_id, pallet_id, psku, org_id, expected_location, result, seen_location, counted_by_name, counted_at)
  values (p_count, p.id, p.psku, p.org_id, case when p.status = 'stored' then p.location_id end, v_res, l.id, c.who, now())
  on conflict (count_id, pallet_id) do update set result = excluded.result, seen_location = excluded.seen_location, counted_by_name = excluded.counted_by_name, counted_at = excluded.counted_at;
  return jsonb_build_object('psku', p.psku, 'result', v_res, 'seen', l.code, 'expected', (select code from locations where id = coalesce(ln.expected_location, case when p.status = 'stored' then p.location_id end)));
end $$;
create function public.nexus_count_close(p_count uuid) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare c record; k nexus_counts;
begin
  select * into c from _nexus_staff();
  select * into k from nexus_counts where id = p_count for update;
  if k.id is null then raise exception 'Count not found.'; end if;
  if k.status = 'open' then
    update nexus_count_lines set result = 'missing' where count_id = p_count and result = 'pending';
    update nexus_counts set status = 'closed', closed_at = now(), closed_by_name = c.who where id = p_count;
  end if;
  return (select jsonb_object_agg(r, n) from (select result r, count(*) n from nexus_count_lines where count_id = p_count group by result) s);
end $$;
create function public.nexus_counts_list() returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform 1 from _nexus_staff();
  return (select coalesce(jsonb_agg(x order by x ->> 'started_at' desc), '[]') from (
    select jsonb_build_object('id', k.id, 'zone', k.zone, 'brand', (select name from orgs where id = k.org_id), 'status', k.status, 'started_at', k.started_at,
      'started_by', k.started_by_name, 'closed_at', k.closed_at,
      'totals', (select coalesce(jsonb_object_agg(r, n), '{}') from (select result r, count(*) n from nexus_count_lines where count_id = k.id group by result) s)) x
    from nexus_counts k order by k.started_at desc limit 100) q);
end $$;
create function public.nexus_count_lines_list(p_count uuid) returns table (psku text, brand text, result text, expected text, seen text, counted_by text, counted_at timestamptz)
language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform 1 from _nexus_staff();
  return query select n.psku, g.name, n.result, e.code, s.code, n.counted_by_name, n.counted_at
  from nexus_count_lines n join orgs g on g.id = n.org_id left join locations e on e.id = n.expected_location left join locations s on s.id = n.seen_location
  where n.count_id = p_count order by (n.result = 'pending') desc, (n.result = 'found'), e.code nulls last, n.psku;
end $$;

-- ───────── connections (ShipBay admin) ─────────
create function public.nexus_client_create(p_name text, p_org_ids uuid[]) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare c record; v_key text := 'nxs_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''); v_id uuid;
begin
  select * into c from _nexus_staff();
  if c.role <> 'shipbay_admin' then raise exception 'Only a ShipBay admin can connect a WMS.'; end if;
  if (select count(*) from orgs where id = any(p_org_ids)) is distinct from cardinality(p_org_ids) then raise exception 'Pick the brands this WMS may see.'; end if;
  insert into nexus_clients (name, org_ids, key_hash, created_by) values (btrim(p_name), p_org_ids, encode(sha256(convert_to(v_key, 'utf8')), 'hex'), c.uid) returning id into v_id;
  return jsonb_build_object('id', v_id, 'key', v_key);   -- the key is shown once and never stored
end $$;
create function public.nexus_client_set_active(p_id uuid, p_active boolean) returns void language plpgsql security definer set search_path to 'public' as $$
declare c record;
begin
  select * into c from _nexus_staff();
  if c.role <> 'shipbay_admin' then raise exception 'Only a ShipBay admin can change a connection.'; end if;
  update nexus_clients set active = p_active where id = p_id;
end $$;
create function public.nexus_clients_list() returns table (id uuid, name text, brands text[], active boolean, created_at timestamptz, last_used_at timestamptz)
language plpgsql stable security definer set search_path to 'public' as $$
declare c record;
begin
  select * into c from _nexus_staff();
  if c.role <> 'shipbay_admin' then return; end if;
  return query select n.id, n.name, (select array_agg(g.name order by g.name) from orgs g where g.id = any(n.org_ids)), n.active, n.created_at, n.last_used_at from nexus_clients n order by n.created_at;
end $$;

-- ───────── API for a connected WMS (key required; read-only; only that connection's brands) ─────────
create function public._nexus_api_client(p_key text) returns uuid[] language plpgsql security definer set search_path to 'public' as $$
declare n nexus_clients;
begin
  select * into n from nexus_clients where key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'utf8')), 'hex');
  if n.id is null or not n.active then raise exception 'Unknown or inactive Nexus key.'; end if;
  update nexus_clients set last_used_at = now() where id = n.id;
  return n.org_ids;
end $$;
revoke all on function public._nexus_api_client(text) from public, anon, authenticated, service_role;
create function public.nexus_api_counts(p_key text) returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin return jsonb_build_object('as_of', now(), 'brands', _nexus_brand_counts(_nexus_api_client(p_key))); end $$;
create function public.nexus_api_pallets(p_key text) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare o uuid[] := _nexus_api_client(p_key);
begin
  return jsonb_build_object('as_of', now(), 'pallets', (select coalesce(jsonb_agg(jsonb_build_object('pallet', v.psku, 'brand', v.org_name, 'status', v.status, 'on_hold', v.held,
    'location', v.location_code, 'item', v.item_name, 'item_no', v.item_no, 'cartons', v.cartons, 'units', v.units_total, 'received_at', v.received_at, 'stored_at', v.stored_at, 'age_days', v.age_days) order by v.received_at), '[]')
    from v_nexus_pallets v where v.org_id = any(o)));
end $$;
create function public.nexus_api_fifo(p_key text, p_sku text) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare o uuid[] := _nexus_api_client(p_key); s skus;
begin
  select * into s from skus where org_id = any(o) and upper(sku) = upper(btrim(coalesce(p_sku, ''))) limit 1;
  if s.id is null then raise exception 'Product % is not on file for this connection.', p_sku; end if;
  return jsonb_build_object('as_of', now(), 'sku', s.sku, 'pick_first', (select coalesce(jsonb_agg(to_jsonb(f) order by f.pick_order), '[]') from _nexus_fifo(s.org_id, s.id) f));
end $$;

do $$ declare f text; begin
  for f in select p.oid::regprocedure::text from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'nexus\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
    if f like 'nexus_api_%' then execute format('grant execute on function %s to anon, authenticated', f);
    else execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;
commit;
