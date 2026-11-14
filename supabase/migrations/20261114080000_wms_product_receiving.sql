-- 2026-11-14 (Derek): receiving is by PRODUCT, not by delivery. Pick the brand, find the product on its inventory list,
-- say how many pallets and how many cartons per pallet. Each pallet gets its 4x6 PSKU label and each carton its own
-- 3x1 label. A pallet is then worked in three steps:
--   open    → carton labels are on; every carton has to be scanned in
--   counted → all cartons scanned ("complete, but not fully"): the pallet is given a position and shown on the map
--   stored  → the PSKU label was scanned at that position = received
-- 'received' stays as the status of the first pallets, made before products and cartons existed. 'void' as before.
-- Connector-safe form: additive, create-or-replace, guarded policies.

alter table wms_pallets add column if not exists sku_id uuid references skus(id);
alter table wms_pallets add column if not exists item_no text;            -- copied at receiving so a reprint years later reads the same
alter table wms_pallets add column if not exists item_name text;
alter table wms_pallets add column if not exists units_per_carton int;
alter table wms_pallets add column if not exists location_id uuid references locations(id);
alter table wms_pallets add column if not exists counted_at timestamptz;
alter table wms_pallets add column if not exists counted_by_name text;
alter table wms_pallets add column if not exists stored_at timestamptz;
alter table wms_pallets add column if not exists stored_by_name text;
create index if not exists wms_pallets_location_idx on wms_pallets (location_id) where location_id is not null;

create table if not exists wms_cartons (
  id uuid primary key default gen_random_uuid(),
  pallet_id uuid not null references wms_pallets(id) on delete cascade,
  org_id uuid not null references orgs(id),
  seq int not null,
  code text not null unique,                      -- C + the pallet's six digits + the carton number: C00000305 = PSKU-000003, carton 5
  scanned_at timestamptz,
  scanned_by_name text,
  unique (pallet_id, seq)
);
alter table wms_cartons enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'wms_cartons' and policyname = 'wms_cartons_read') then
    create policy wms_cartons_read on wms_cartons for select to authenticated using (is_wms_staff() or org_id = current_org_id());
  end if;
end $$;
revoke all on wms_cartons from anon;
grant select on wms_cartons to authenticated;

-- a brand's products for the receiving search (a floor employee cannot read the products table itself)
create or replace function wms_products(p_org uuid)
returns table (id uuid, sku text, name text, asins text[], supplier text, barcode text, expected_qty int, expected_fba int, expected_fbm int)
language sql stable security definer set search_path = public as $$
  select s.id, s.sku, s.name, s.asins, s.supplier, s.barcode, s.expected_qty, s.expected_fba, s.expected_fbm
  from skus s where is_wms_staff() and s.org_id = p_org and s.active order by s.name;
$$;

-- Receive p_pallets pallets of one product, p_cartons cartons on each. p_sku null = a product that is not on the list
-- (p_notes says what it is). No cartons = nothing to scan in, the pallet goes straight to put-away.
create or replace function wms_receive_product(
  p_org uuid, p_sku uuid default null, p_pallets int default 1, p_cartons int default null,
  p_units_per_carton int default null, p_notes text default null, p_key text default null
) returns setof wms_pallets
language plpgsql security definer set search_path = public as $$
declare
  v_n int := coalesce(p_pallets, 1); v_c int := coalesce(p_cartons, 0);
  v_key text := coalesce(nullif(trim(p_key), ''), gen_random_uuid()::text);
  v_name text; s skus; i int; v_id uuid; v_num text; v_w int;
begin
  if not is_wms_staff() then raise exception 'This login cannot receive pallets.'; end if;
  if v_n < 1 or v_n > 60 then raise exception 'Receive between 1 and 60 pallets at a time.'; end if;
  if v_c < 0 or v_c > 500 then raise exception 'A pallet holds between 0 and 500 cartons here.'; end if;
  if p_units_per_carton is not null and p_units_per_carton < 1 then raise exception 'Units per carton starts at 1.'; end if;
  if not exists (select 1 from orgs where id = p_org) then raise exception 'Pick a brand first.'; end if;
  if p_sku is not null then
    select * into s from skus where id = p_sku and org_id = p_org;
    if s.id is null then raise exception 'That product is not on this brand''s list.'; end if;
  elsif coalesce(trim(p_notes), '') = '' then
    raise exception 'Pick the product, or say what it is.';
  end if;

  if exists (select 1 from wms_pallets where batch_key = v_key) then
    return query select * from wms_pallets where batch_key = v_key order by batch_pos; return;
  end if;

  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  v_w := greatest(2, length(v_c::text));
  for i in 1..v_n loop
    v_num := lpad(nextval('wms_psku_seq')::text, 6, '0');
    insert into wms_pallets (psku, org_id, status, sku_id, item_no, item_name, cartons, units_per_carton, notes, batch_key, batch_pos, batch_size, client_key, received_by, received_by_name,
                             counted_at, counted_by_name)
    values ('PSKU-' || v_num, p_org, case when v_c > 0 then 'open' else 'counted' end, s.id, s.sku, s.name, nullif(v_c, 0), p_units_per_carton, nullif(trim(p_notes), ''),
            v_key, i, v_n, v_key || ':' || i, auth.uid(), v_name,
            case when v_c > 0 then null else now() end, case when v_c > 0 then null else v_name end)
    returning id into v_id;
    insert into wms_cartons (pallet_id, org_id, seq, code)
    select v_id, p_org, g, 'C' || v_num || lpad(g::text, v_w, '0') from generate_series(1, v_c) g;
    if v_c = 0 then perform _wms_pick_location(v_id); end if;
  end loop;
  return query select * from wms_pallets where batch_key = v_key order by batch_pos;
end $$;

-- Where a counted pallet should go: a free pallet position, in a section that already holds this brand when there is
-- one, otherwise the first free position by code. A position is taken by a pallet that is counted or stored there.
create or replace function _wms_pick_location(p_pallet uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_loc uuid;
begin
  select org_id into v_org from wms_pallets where id = p_pallet;
  select l.id into v_loc
  from locations l
  where l.active and l.kind = 'pallet'
    and not exists (select 1 from wms_pallets p where p.location_id = l.id and p.status in ('counted', 'stored'))
  order by (exists (select 1 from wms_pallets p join locations l2 on l2.id = p.location_id where p.org_id = v_org and p.status in ('counted', 'stored') and l2.zone is not distinct from l.zone)) desc, l.code
  limit 1;
  update wms_pallets set location_id = v_loc where id = p_pallet;
  return v_loc;
end $$;
revoke all on function _wms_pick_location(uuid) from public, anon, authenticated;

-- One scan = one carton. Scanning a carton twice is reported, never counted twice.
create or replace function wms_scan_carton(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c wms_cartons; p wms_pallets; v_name text; v_again boolean := false;
begin
  if not is_wms_staff() then raise exception 'This login cannot scan cartons.'; end if;
  select * into c from wms_cartons where code = upper(trim(p_code)) for update;
  if c.id is null then raise exception '% is not a carton label on file.', upper(trim(p_code)); end if;
  select * into p from wms_pallets where id = c.pallet_id;
  if p.status = 'void' then raise exception '% was voided.', p.psku; end if;
  if c.scanned_at is not null then v_again := true;
  else
    select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
    update wms_cartons set scanned_at = now(), scanned_by_name = v_name where id = c.id;
  end if;
  return jsonb_build_object('pallet_id', p.id, 'psku', p.psku, 'seq', c.seq, 'already', v_again,
    'scanned', (select count(*) from wms_cartons where pallet_id = p.id and scanned_at is not null), 'total', (select count(*) from wms_cartons where pallet_id = p.id));
end $$;

-- All cartons in → the pallet is counted and gets its position.
create or replace function wms_complete_count(p_pallet uuid) returns wms_pallets
language plpgsql security definer set search_path = public as $$
declare p wms_pallets; v_left int; v_name text;
begin
  if not is_wms_staff() then raise exception 'This login cannot complete a pallet.'; end if;
  select * into p from wms_pallets where id = p_pallet for update;
  if p.id is null then raise exception 'Pallet not found.'; end if;
  if p.status <> 'open' then raise exception '% is not waiting on cartons.', p.psku; end if;
  select count(*) into v_left from wms_cartons where pallet_id = p_pallet and scanned_at is null;
  if v_left > 0 then raise exception '% carton% still to scan on %.', v_left, case when v_left = 1 then '' else 's' end, p.psku; end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  update wms_pallets set status = 'counted', counted_at = now(), counted_by_name = v_name where id = p_pallet;
  perform _wms_pick_location(p_pallet);
  select * into p from wms_pallets where id = p_pallet;
  return p;
end $$;

-- Send a counted pallet to a different free position (or a floor area, which holds any number of pallets).
create or replace function wms_assign_location(p_pallet uuid, p_location uuid) returns wms_pallets
language plpgsql security definer set search_path = public as $$
declare p wms_pallets; l locations;
begin
  if not is_wms_staff() then raise exception 'This login cannot move a pallet.'; end if;
  select * into p from wms_pallets where id = p_pallet for update;
  if p.id is null or p.status <> 'counted' then raise exception 'Only a pallet waiting for put-away can be given a position.'; end if;
  select * into l from locations where id = p_location and active;
  if l.id is null or l.kind not in ('pallet', 'floor') then raise exception 'That is not a pallet position.'; end if;
  if l.kind = 'pallet' and exists (select 1 from wms_pallets x where x.location_id = l.id and x.status in ('counted', 'stored') and x.id <> p_pallet) then
    raise exception '% already has a pallet.', l.code;
  end if;
  update wms_pallets set location_id = l.id where id = p_pallet returning * into p;
  return p;
end $$;

-- The pallet is received when its PSKU label is scanned at the position it was given: both scans arrive here.
create or replace function wms_putaway(p_pallet uuid, p_psku text, p_location_code text) returns wms_pallets
language plpgsql security definer set search_path = public as $$
declare p wms_pallets; l locations; v_code text := upper(regexp_replace(trim(coalesce(p_location_code, '')), '^LOC-', '', 'i')); v_name text;
begin
  if not is_wms_staff() then raise exception 'This login cannot put a pallet away.'; end if;
  select * into p from wms_pallets where id = p_pallet for update;
  if p.id is null then raise exception 'Pallet not found.'; end if;
  if p.status <> 'counted' then raise exception '% is not waiting for put-away.', p.psku; end if;
  if upper(trim(coalesce(p_psku, ''))) <> p.psku then raise exception 'That is not the label of %.', p.psku; end if;
  if p.location_id is null then raise exception '% has no position yet. Pick one on the map.', p.psku; end if;
  select * into l from locations where id = p.location_id;
  if upper(l.code) <> v_code then raise exception '% goes to %, not %.', p.psku, l.code, coalesce(nullif(v_code, ''), 'there'); end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  update wms_pallets set status = 'stored', stored_at = now(), stored_by_name = v_name where id = p_pallet returning * into p;
  return p;
end $$;

revoke all on function wms_products(uuid) from public, anon;
revoke all on function wms_receive_product(uuid, uuid, int, int, int, text, text) from public, anon;
revoke all on function wms_scan_carton(text) from public, anon;
revoke all on function wms_complete_count(uuid) from public, anon;
revoke all on function wms_assign_location(uuid, uuid) from public, anon;
revoke all on function wms_putaway(uuid, text, text) from public, anon;
grant execute on function wms_products(uuid) to authenticated;
grant execute on function wms_receive_product(uuid, uuid, int, int, int, text, text) to authenticated;
grant execute on function wms_scan_carton(text) to authenticated;
grant execute on function wms_complete_count(uuid) to authenticated;
grant execute on function wms_assign_location(uuid, uuid) to authenticated;
grant execute on function wms_putaway(uuid, text, text) to authenticated;
