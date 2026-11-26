-- Stage 1 corrections after the first live placement test (Derek, 2026-11-25 22:03 ET "CORRECT FAILED STAGE 1 PRODUCTION WORKFLOW").
--   1. A pallet can be created without a shipment: wms_create_pallet. Existing client products only, quantities entered, the
--      pallet id generated, a source and a reason required and kept on the pallet and in the activity log. It goes through
--      ShipBay's own receiving function, so the pallet starts like any received pallet: it holds NO available stock until it is
--      placed through Nexus (stock is posted only when a pallet is stored). A pallet tied to a shipment keeps using the existing
--      booked receiving (wms_receive_booking).
--   2. New pallet ids are SB-PAL-000040 style. Same number sequence as before, so numbers never repeat across the two forms;
--      every existing PSKU-… id, label and carton code stays exactly as it is. Carton codes keep their C + number form.
--   3. The Nexus request description names the employee who asked (the bridge sends it to Nexus as confirmed_by).
-- Additive: two nullable columns, one new function, four id generators re-created with only the prefix text changed.
alter table public.wms_pallets add column if not exists created_source text;
alter table public.wms_pallets add column if not exists created_reason text;

create or replace function public._wms_nexus_desc(o wms_nexus_ops, p_resumed boolean) returns jsonb language sql immutable as $$
  select jsonb_build_object('op', o.id, 'key', o.idem_key, 'kind', o.kind, 'pallet', o.psku, 'to', o.to_code, 'from', o.from_code, 'fixes', o.fixes, 'resumed', p_resumed, 'by', o.by_name);
$$;

-- new pallet ids: only the literal prefix changes in the four functions that make them
do $ids$ declare f oid; v_def text; begin
  for f in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('wms_hold_pskus', 'wms_receive', 'wms_receive_pallets', 'wms_receive_product') loop
    v_def := pg_get_functiondef(f);
    if position($q$'PSKU-' ||$q$ in v_def) = 0 then raise exception 'Pallet id prefix not found in %. Nothing was changed.', f::regprocedure; end if;
    execute replace(v_def, $q$'PSKU-' ||$q$, $q$'SB-PAL-' ||$q$);
  end loop;
end $ids$;

create or replace function public.wms_create_pallet(p_org uuid, p_lines jsonb, p_source text, p_reason text, p_key text default null, p_pallets integer default 1)
returns setof public.wms_pallets language plpgsql security definer set search_path to 'public' as $$
declare l jsonb; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_label text; v_who text; v_key text := coalesce(nullif(btrim(p_key), ''), gen_random_uuid()::text); p wms_pallets;
begin
  if not is_wms_staff() then raise exception 'This login cannot create pallets.'; end if;
  v_label := case p_source when 'found_on_floor' then 'Found on the floor' when 'client_drop_off' then 'Client drop-off' when 'return' then 'Return'
    when 'transfer_in' then 'Transfer in' when 'count_correction' then 'Count correction' when 'other' then 'Other' end;
  if v_label is null then raise exception 'Say where this pallet came from.'; end if;
  if v_reason is null or length(v_reason) < 4 then raise exception 'Say why this pallet is being created without a shipment.'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1 then raise exception 'Pick the product.'; end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    if nullif(l ->> 'sku', '') is null then raise exception 'Pick each product from the brand''s product list.'; end if;
  end loop;
  -- an earlier attempt with the same key already made these pallets: hand them back, log nothing twice
  if exists (select 1 from wms_pallets where batch_key = v_key) then return query select * from wms_pallets where batch_key = v_key order by batch_pos; return; end if;
  select coalesce(full_name, email) into v_who from profiles where id = auth.uid();
  perform 1 from wms_receive(p_org, p_lines, coalesce(p_pallets, 1), left('Created without a shipment · ' || v_label || ': ' || v_reason, 500), v_key);
  update wms_pallets set created_source = p_source, created_reason = v_reason where batch_key = v_key;
  for p in select * from wms_pallets where batch_key = v_key order by batch_pos loop
    insert into wms_activity (org_id, kind, qty, ref, actor, actor_name, detail)
    values (p.org_id, 'pallet_created', 1, p.psku, auth.uid(), v_who, jsonb_build_object('source', p_source, 'reason', v_reason, 'shipment', null, 'cartons', p.cartons, 'request', v_key));
  end loop;
  return query select * from wms_pallets where batch_key = v_key order by batch_pos;
end $$;
revoke all on function public.wms_create_pallet(uuid, jsonb, text, text, text, integer) from public, anon;
grant execute on function public.wms_create_pallet(uuid, jsonb, text, text, text, integer) to authenticated;
