-- Rate card v2 (2026-10-30 model) becomes the current standard card: only pay for what you use.
update rate_cards set status = 'retired', effective_to = '2026-10-31', notes = concat_ws(E'\n', nullif(notes, ''), 'Retired 2026-10-31 — replaced by rate card v2 (only pay for what you use).') where scope = 'standard' and status = 'current' and label <> 'ShipBay rate card v2';
insert into rate_cards (org_id, scope, status, label, effective_from, pick_pack_first, pick_pack_addl, storage_pallet, storage_shelf, storage_bin,
  receiving_pallet, receiving_carton, returns_fee, packaging_mailer, packaging_box_single, packaging_box_double, intl_surcharge, monthly_minimum,
  postage_markup_pct, storage_waived_months, minimum_waived_months, tiers, extras, notes)
select null, 'standard', 'current', 'ShipBay rate card v2', '2026-10-31', 1.95, 0.45, 18, 4, 1,
  10, 2.50, 3, 0, 2.50, 2.50, 2.50, 0,
  0, 0, 0,
  '[{"label":"Launch","max_orders":1000,"pick_first":1.95,"pick_addl":0.45},{"label":"Growth","max_orders":5000,"pick_first":1.80,"pick_addl":0.45},{"label":"Scale","max_orders":null,"pick_first":1.65,"pick_addl":0.45}]'::jsonb,
  '{"mailer_included":true,"box_packout":2.5,"returns_addl":0.5,"b2b_order":5.5,"b2b_unit":0.4,"pallet_build":18,"fba_prep":0.6,"fba_carton":2.5,"kitting_hr":40,"kit_rate":1.5,"insert":0.1,"gift_wrap":2.5,"fragile":1,"storage_pallet_60":20,"storage_pallet_72":24,"storage_half":12,"storage_min":10,"storage_aged_cuft":0.1,"receiving_addl_sku":5,"receiving_mixed":60,"receiving_carton_min":10,"blind_receipt":15,"sku_label":0.25,"batch_drop":0.95,"batch_drop_small":1.10,"batch_drop_large":0.85,"batch_addl":0.15,"container_20":350,"container_40":500,"floor_loaded":150,"counts_hr":40,"setup":0}'::jsonb,
  'Rate card v2: storage by pallet size on occupancy, no monthly minimum ($10 storage account min), box pack-out $2.50, receiving $10/pallet + $5 per extra SKU, mixed pallet $60, carton $2.50, labeling $0.25, batch drop $0.95 (3,000–4,999) / $1.10 / $0.85. Postage on the client''s own carrier account. Scale tier needs a 12-month term.'
where not exists (select 1 from rate_cards where scope = 'standard' and label = 'ShipBay rate card v2');
