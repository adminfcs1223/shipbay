-- 2026-11-14 (Derek): carton labels can be printed before Receive is pressed.
-- A carton's barcode holds its pallet number, so printing first means taking the PSKU# first: wms_hold_pskus hands the
-- numbers out against the receiving form's key, and wms_receive uses the held numbers for that key. A held number that
-- is never received is simply skipped.
-- Connector-safe form: additive, create-or-replace.

create table if not exists wms_psku_holds (
  batch_key text not null,
  pos int not null,
  num text not null,
  held_by uuid,
  held_at timestamptz not null default now(),
  primary key (batch_key, pos)
);
alter table wms_psku_holds enable row level security;   -- no policies: only the functions below touch it

create or replace function wms_hold_pskus(p_key text, p_pallets int default 1)
returns setof text
language plpgsql security definer set search_path = public as $$
declare v_n int := coalesce(p_pallets, 1); v_key text := nullif(trim(p_key), ''); i int;
begin
  if not is_wms_staff() then raise exception 'This login cannot receive pallets.'; end if;
  if v_key is null then raise exception 'No form key.'; end if;
  if v_n < 1 or v_n > 60 then raise exception 'Receive between 1 and 60 pallets at a time.'; end if;
  if exists (select 1 from wms_pallets where batch_key = v_key) then
    return query select psku from wms_pallets where batch_key = v_key order by batch_pos; return;
  end if;
  for i in 1..v_n loop
    if not exists (select 1 from wms_psku_holds where batch_key = v_key and pos = i) then   -- printing again keeps the same numbers
      insert into wms_psku_holds (batch_key, pos, num, held_by) values (v_key, i, lpad(nextval('wms_psku_seq')::text, 6, '0'), auth.uid());
    end if;
  end loop;
  return query select 'PSKU-' || h.num from wms_psku_holds h where h.batch_key = v_key and h.pos <= v_n order by h.pos;
end $$;
revoke all on function wms_hold_pskus(text, int) from public, anon;
grant execute on function wms_hold_pskus(text, int) to authenticated;

-- wms_receive as of 20261114090000, with one change: a pallet takes the number held for its key and place, if there is one
create or replace function wms_receive(p_org uuid, p_lines jsonb, p_pallets int default 1, p_notes text default null, p_key text default null)
returns setof wms_pallets
language plpgsql security definer set search_path = public as $$
declare
  v_n int := coalesce(p_pallets, 1);
  v_key text := coalesce(nullif(trim(p_key), ''), gen_random_uuid()::text);
  v_who text; v_lines int; v_total int := 0; v_mixed boolean; v_allfba boolean := true;
  l jsonb; s skus; i int; g int; v_id uuid; v_num text; v_w int; v_seq int; v_c int; v_upc int; v_name text; v_fba boolean;
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
    v_c := coalesce(nullif(l->>'cartons', '')::int, 0);
    if v_c < 0 or v_c > 500 then raise exception 'A line holds between 0 and 500 cartons.'; end if;
    if v_mixed and v_c < 1 then raise exception 'On a mixed pallet every product needs its carton count.'; end if;
    if nullif(l->>'units_per_carton', '') is not null and (l->>'units_per_carton')::int < 1 then raise exception 'Units per carton starts at 1.'; end if;
    if nullif(l->>'sku', '') is not null then
      if not exists (select 1 from skus where id = (l->>'sku')::uuid and org_id = p_org) then raise exception 'One of those products is not on this brand''s list.'; end if;
    elsif coalesce(trim(l->>'name'), '') = '' then raise exception 'Pick the product, or say what it is.';
    end if;
    v_total := v_total + v_c;
    v_allfba := v_allfba and coalesce((l->>'fba')::boolean, false);
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
    insert into wms_pallets (psku, org_id, status, mixed, fba, sku_id, item_no, item_name, cartons, units_per_carton, notes, batch_key, batch_pos, batch_size, client_key,
                             received_by, received_by_name, counted_at, counted_by_name)
    values ('PSKU-' || v_num, p_org, case when v_total > 0 then 'open' else 'counted' end, v_mixed, v_allfba,
            case when v_mixed then null else s.id end, case when v_mixed then null else s.sku end,
            case when v_mixed then 'Mixed pallet · ' || v_lines || ' products' else coalesce(s.name, left(trim(l->>'name'), 300)) end,
            nullif(v_total, 0), case when v_mixed then null else nullif(l->>'units_per_carton', '')::int end, nullif(trim(p_notes), ''),
            v_key, i, v_n, v_key || ':' || i, auth.uid(), v_who,
            case when v_total > 0 then null else now() end, case when v_total > 0 then null else v_who end)
    returning id into v_id;
    v_seq := 0;
    for l in select * from jsonb_array_elements(p_lines) loop
      s := null;
      if nullif(l->>'sku', '') is not null then select * into s from skus where id = (l->>'sku')::uuid; end if;
      v_c := coalesce(nullif(l->>'cartons', '')::int, 0); v_upc := nullif(l->>'units_per_carton', '')::int;
      v_name := coalesce(s.name, left(trim(l->>'name'), 300)); v_fba := coalesce((l->>'fba')::boolean, false);
      for g in 1..v_c loop
        v_seq := v_seq + 1;
        insert into wms_cartons (pallet_id, org_id, seq, code, sku_id, item_no, item_name, units_per_carton, fba)
        values (v_id, p_org, v_seq, 'C' || v_num || lpad(v_seq::text, v_w, '0'), s.id, s.sku, v_name, v_upc, v_fba);
      end loop;
    end loop;
    if v_total = 0 then perform _wms_pick_location(v_id); end if;
  end loop;
  return query select * from wms_pallets where batch_key = v_key order by batch_pos;
end $$;
revoke all on function wms_receive(uuid, jsonb, int, text, text) from public, anon;
grant execute on function wms_receive(uuid, jsonb, int, text, text) to authenticated;
