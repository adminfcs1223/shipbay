-- 2026-11-14 (Derek, 05:43): "CLE means no carton count", then 05:44: "change it to NCC". Corrects 20261114103000, which kept the count.
-- The floor name is NCC (no carton count); the columns and the line key keep the name cle.
-- A CLE product has no carton count, no carton labels and no carton scan. So that a mixed pallet still knows the product
-- is on it, a CLE line writes ONE marker row in wms_cartons (cle = true, already counted); it is not a carton and is
-- never labelled. wms_pallets.cartons counts real cartons only (null when there are none); wms_pallets.cle = every
-- product on the pallet is CLE. Connector-safe form: create-or-replace.

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
