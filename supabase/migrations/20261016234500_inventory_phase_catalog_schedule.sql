-- Inventory phase: SKU catalog CSV import, document uploads (pdf/doc/image), inbound date, Packing methods & SOPs
alter table onboarding_tasks drop constraint if exists onboarding_tasks_kind_check;
alter table onboarding_tasks add constraint onboarding_tasks_kind_check check (kind in ('manual','document','billing','portal','integration','catalog','schedule'));
alter table onboarding_tasks add column if not exists scheduled_for date;
alter table onboarding_tasks add column if not exists accept text; -- file types for document tasks (null = PDF only)

alter table documents drop constraint if exists documents_kind_check;
alter table documents add constraint documents_kind_check check (kind in ('w9','agreement','sla','rate_card','intake_form','packaging_spec','routing_guide','resale_cert','formation_cert','insurance','returns_rules','packing_sops','sku_catalog','other'));

update onboarding_tasks set label = 'SKU Catalog',                      kind = 'catalog',  sort = 210 where key = 'sku_catalog';
update onboarding_tasks set label = 'Packaging spec',                   kind = 'document', sort = 220, accept = 'pdf,doc,image' where key = 'packaging_spec';
update onboarding_tasks set label = 'Returns / exchange rules',         kind = 'document', sort = 230, accept = 'pdf,doc,image' where key = 'returns_rules';
update onboarding_tasks set label = 'Initial inbound transfer',         kind = 'schedule', sort = 250 where key = 'inbound_scheduled';
update onboarding_tasks set label = 'Initial inventory received & counted', sort = 260 where key = 'inbound_received';
insert into onboarding_tasks (org_id, key, label, phase, sort, kind, accept)
select id, 'packing_sops', 'Packing methods & general SOPs', 'inventory', 240, 'document', 'pdf,doc,image' from orgs
on conflict (org_id, key) do nothing;
update onboarding_tasks set done = false, done_at = null, done_by = null where key in ('sku_catalog','packaging_spec','returns_rules','inbound_scheduled') and kind <> 'manual';

create or replace function ensure_onboarding(p_org_id uuid) returns void
language sql security definer set search_path = public as $$
  insert into onboarding_tasks (org_id, key, label, phase, sort, kind, optional, accept) values
    (p_org_id, 'intake_form',      'Intake form',                            'paperwork', 10, 'document', false, null),
    (p_org_id, 'w9',               'W-9',                                    'paperwork', 20, 'document', false, null),
    (p_org_id, 'formation_cert',   'Formation Certificate',                  'paperwork', 30, 'document', false, null),
    (p_org_id, 'rate_card',        'Rate Card Signed',                       'paperwork', 40, 'document', false, null),
    (p_org_id, 'agreement',        'Account Agreement',                      'paperwork', 50, 'document', false, null),
    (p_org_id, 'sla',              'SLA',                                    'paperwork', 60, 'document', false, null),
    (p_org_id, 'billing_method',   'Billing method',                         'paperwork', 70, 'billing',  false, null),
    (p_org_id, 'additional_docs',  'Additional documents',                   'paperwork', 80, 'document', true,  null),
    (p_org_id, 'portal_login',     'Client Portal',                          'systems',   100, 'portal',      false, null),
    (p_org_id, 'label_access',     'Shipping Label Access',                  'systems',   110, 'integration', false, null),
    (p_org_id, 'shopify_connected','Commerce Channel Access',                'systems',   120, 'integration', false, null),
    (p_org_id, 'sku_catalog',      'SKU Catalog',                            'inventory', 210, 'catalog',  false, null),
    (p_org_id, 'packaging_spec',   'Packaging spec',                         'inventory', 220, 'document', false, 'pdf,doc,image'),
    (p_org_id, 'returns_rules',    'Returns / exchange rules',               'inventory', 230, 'document', false, 'pdf,doc,image'),
    (p_org_id, 'packing_sops',     'Packing methods & general SOPs',         'inventory', 240, 'document', false, 'pdf,doc,image'),
    (p_org_id, 'inbound_scheduled','Initial inbound transfer',               'inventory', 250, 'schedule', false, null),
    (p_org_id, 'inbound_received', 'Initial inventory received & counted',   'inventory', 260, 'manual',   false, null),
    (p_org_id, 'test_orders',      'Test orders shipped end to end',         'go_live',   310, 'manual', false, null),
    (p_org_id, 'go_live_date',     'Go-live date set',                       'go_live',   320, 'manual', false, null),
    (p_org_id, 'go_live',          'Live — first real orders shipped',       'go_live',   330, 'manual', false, null)
  on conflict (org_id, key) do nothing;
$$;

-- SKU catalog import: upsert rows for an org, return counts. Staff only.
create or replace function import_sku_catalog(p_org_id uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ins int := 0; v_upd int := 0; r jsonb; v_exists boolean;
begin
  if not is_shipbay() then raise exception 'not authorized'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    continue when coalesce(trim(r->>'sku'),'') = '';
    select exists (select 1 from skus where org_id = p_org_id and sku = trim(r->>'sku')) into v_exists;
    insert into skus (org_id, sku, name, variant, barcode, weight_oz, dims_in, declared_value, packaging, low_stock_threshold)
    values (p_org_id, trim(r->>'sku'), coalesce(nullif(trim(r->>'name'),''), trim(r->>'sku')), nullif(trim(r->>'variant'),''), nullif(trim(r->>'barcode'),''),
            nullif(regexp_replace(coalesce(r->>'weight_oz',''), '[^0-9.]', '', 'g'),'')::numeric,
            nullif(trim(r->>'dims_in'),''),
            nullif(regexp_replace(coalesce(r->>'declared_value',''), '[^0-9.]', '', 'g'),'')::numeric,
            case when r->>'packaging' in ('mailer','box_single','box_double','client_supplied') then r->>'packaging' else null end,
            nullif(regexp_replace(coalesce(r->>'low_stock_threshold',''), '[^0-9]', '', 'g'),'')::int)
    on conflict (org_id, sku) do update set
      name = excluded.name, variant = coalesce(excluded.variant, skus.variant), barcode = coalesce(excluded.barcode, skus.barcode),
      weight_oz = coalesce(excluded.weight_oz, skus.weight_oz), dims_in = coalesce(excluded.dims_in, skus.dims_in),
      declared_value = coalesce(excluded.declared_value, skus.declared_value), packaging = coalesce(excluded.packaging, skus.packaging),
      low_stock_threshold = coalesce(excluded.low_stock_threshold, skus.low_stock_threshold), active = true;
    if v_exists then v_upd := v_upd + 1; else v_ins := v_ins + 1; end if;
  end loop;
  if v_ins + v_upd > 0 then
    update onboarding_tasks set done = true, done_at = coalesce(done_at, now()), done_by = auth.uid() where org_id = p_org_id and key = 'sku_catalog';
  end if;
  return jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'total', (select count(*) from skus where org_id = p_org_id and active));
end $$;
revoke execute on function import_sku_catalog(uuid, jsonb) from public, anon;
grant execute on function import_sku_catalog(uuid, jsonb) to authenticated;

-- Scheduling the first inbound completes the step; clearing the date reopens it
create or replace function tasks_schedule_sync() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'schedule' and new.scheduled_for is distinct from old.scheduled_for then
    new.done := new.scheduled_for is not null;
    new.done_at := case when new.done then coalesce(new.done_at, now()) end;
    new.done_by := case when new.done then coalesce(new.done_by, auth.uid()) end;
  end if;
  return new;
end $$;
create or replace trigger tasks_schedule_sync before update of scheduled_for on onboarding_tasks for each row execute function tasks_schedule_sync();
revoke execute on function tasks_schedule_sync() from public, anon, authenticated;
