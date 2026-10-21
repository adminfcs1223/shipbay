-- Quotes tab + a finalized, versioned STANDARD rate card.
--  * rate_cards gains scope ('standard' | 'org'), status ('draft' | 'current' | 'retired'), tiered pick & pack and the
--    "every line item" extras (container unload, B2B, FBA prep, kitting). org_id becomes nullable for the standard card.
--  * quotes: one row per prospect quote — inputs (volume, units/order, storage footprint…), the price lines offered,
--    ShipBay's internal cost model (labor minutes, burdened rate, packaging, space) and scenario volumes. All math runs
--    in the portal (portal/src/quote.js) so a quote can be tuned live; the row is the saved state.

alter table rate_cards alter column org_id drop not null;
alter table rate_cards
  add column if not exists scope text not null default 'org' check (scope in ('standard','org')),
  add column if not exists status text not null default 'current' check (status in ('draft','current','retired')),
  add column if not exists tiers jsonb not null default '[]'::jsonb,      -- [{max_orders, pick_first, pick_addl, label}]
  add column if not exists extras jsonb not null default '{}'::jsonb,     -- container_20, container_40, floor_loaded, b2b_order, b2b_unit, pallet_build, fba_prep, kitting_hr, returns_addl, mailer_included
  add column if not exists storage_waived_months int not null default 0,
  add column if not exists minimum_waived_months int not null default 2,
  add column if not exists updated_at timestamptz not null default now();
create unique index if not exists rate_cards_one_current_standard on rate_cards (scope) where scope = 'standard' and status = 'current';

-- The finalized standard card (2026-10-21). Pick & pack below the industry median ($2.00 first / $0.40 addl, fulfill.com 2026
-- survey), storage at the top of the regional range ($18–25 typical) but under the majors ($35–45), receiving $20/pallet
-- (partner's rule), returns $3 (avg $4.06), minimum $250 (avg $517), postage at cost. Standard poly mailer included.
insert into rate_cards (org_id, scope, status, label, effective_from, pick_pack_first, pick_pack_addl, storage_pallet, storage_shelf, storage_bin,
  receiving_pallet, receiving_carton, returns_fee, packaging_mailer, packaging_box_single, packaging_box_double, intl_surcharge, monthly_minimum,
  postage_markup_pct, storage_waived_months, minimum_waived_months, tiers, extras, notes)
select null, 'standard', 'current', 'ShipBay standard rate card', '2026-10-21', 1.95, 0.40, 25, 10, 2.50,
  20, 3, 3, 0, 0.85, 1.20, 2.50, 250,
  0, 0, 2,
  '[{"label":"Launch","max_orders":1000,"pick_first":1.95,"pick_addl":0.40},{"label":"Growth","max_orders":5000,"pick_first":1.80,"pick_addl":0.40},{"label":"Scale","max_orders":null,"pick_first":1.65,"pick_addl":0.40}]'::jsonb,
  '{"mailer_included":true,"container_20":350,"container_40":500,"floor_loaded":150,"b2b_order":5.50,"b2b_unit":0.40,"pallet_build":18,"fba_prep":0.60,"kitting_hr":40,"returns_addl":0.50,"setup":0}'::jsonb,
  'Finalized 2026-10-21. Pallet storage lowered $30 → $25 to sit inside the regional range; everything else as published on shipbay3pl.com/pricing and the emailed rate card.'
where not exists (select 1 from rate_cards where scope = 'standard' and status = 'current');

-- Quotes
create table if not exists quotes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references orgs(id) on delete set null,          -- set once the prospect becomes a client
  company text not null,
  contact_name text,
  contact_email text,
  contact_phone text,
  label text not null default 'Quote',                          -- "Quote A", "Floor (internal)", …
  status text not null default 'draft' check (status in ('draft','sent','accepted','declined','superseded')),
  internal_only boolean not null default false,                 -- never shown to the client (floor / what-if)
  inputs jsonb not null default '{}'::jsonb,                    -- orders, units_per_order, pallets, shelves, bins, inbound_pallets, inbound_cartons, returns, intl_share, packaging, avg_postage, current_cost
  rates jsonb not null default '{}'::jsonb,                     -- offered price lines (+ intro period overrides)
  costs jsonb not null default '{}'::jsonb,                     -- ShipBay cost model
  scenarios jsonb not null default '[]'::jsonb,                 -- [orders, orders, orders]
  notes text,
  sent_at timestamptz,
  decided_at timestamptz,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists quotes_company_idx on quotes (lower(company));
alter table quotes enable row level security;
do $$ begin if not exists (select 1 from pg_policies where tablename='quotes' and policyname='shipbay_all_quotes') then
  create policy shipbay_all_quotes on quotes for all using (is_shipbay()) with check (is_shipbay()); end if; end $$;

create or replace function touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
create or replace trigger quotes_touch before update on quotes for each row execute function touch_updated_at();
create or replace trigger rate_cards_touch before update on rate_cards for each row execute function touch_updated_at();

-- Seed: Steel Horse Leather (Quote A — the offered founding terms; Quote B — internal floor) and Vinyl Moon (standard Growth tier, assumptions pending Derek's call notes).
insert into quotes (org_id, company, contact_name, contact_email, contact_phone, label, status, internal_only, inputs, rates, costs, scenarios, notes, sent_at)
select 'a1b2c3d4-0000-4000-8000-000000000001', 'Steel Horse Leather', 'Dave', 'dave@steelhorseleather.com', '(718) 218-3161', 'Quote A — Founding Account', 'sent', false,
  '{"orders":400,"units_per_order":1.11,"pallets":6,"shelves":8,"bins":20,"inbound_pallets":2,"inbound_cartons":10,"returns":20,"intl_share":0.01,"packaging":"client","box_share":0.05,"avg_postage":7.38,"current_cost":4847,"current_cost_cash":3972,"b2b_orders":4}'::jsonb,
  '{"pick_first":1.95,"pick_addl":0.40,"mailer":0.20,"box_single":0.85,"box_double":1.20,"storage_pallet":30,"storage_shelf":10,"storage_bin":2.50,"storage_waived_months":3,"receiving_pallet":10,"receiving_carton":3,"receiving_waived_months":3,"returns":3,"returns_addl":0.50,"intl":2.50,"minimum":250,"minimum_waived_months":3,"postage_markup_pct":0,"postage_guarantee_avg":7.38,"b2b_order":5.50,"b2b_unit":0.40,"intro":{"months":12,"pick_first":1.75,"pick_addl":0.35}}'::jsonb,
  '{"labor_rate":22.40,"min_per_order":3.5,"min_per_addl_unit":0.5,"min_per_pallet_in":30,"min_per_carton_in":3,"min_per_return":6,"min_per_b2b_order":12,"pack_cost_mailer":0.12,"pack_cost_box_single":0.62,"pack_cost_box_double":0.90,"dunnage_per_order":0.06,"space_cost_pallet":26,"space_cost_shelf":5,"space_cost_bin":1.25,"overhead_per_month":60,"postage_cost_avg":7.38}'::jsonb,
  '[400,650,1000]'::jsonb,
  'Sent 2026-09-29 (client doc). Terms: $1.75 + $0.35 for 12 months then $1.95/$0.40 · packaging at cost, $0 client-supplied · storage waived 90 days then $30/$10/$2.50 · Brooklyn transfer received free, then $10/pallet + $3/carton · returns $3 · postage "your rates or ours" per label, 12-month guarantee avg ≤ $7.38 · minimum waived 90 days · 2pm ET Mon–Sat · intl +$2.50. Dave in-house: $4,847 all-in / $3,972 cash. Pending partner sign-off.', '2026-09-29'
where not exists (select 1 from quotes where company = 'Steel Horse Leather');

insert into quotes (org_id, company, contact_name, contact_email, label, status, internal_only, inputs, rates, costs, scenarios, notes)
select 'a1b2c3d4-0000-4000-8000-000000000001', 'Steel Horse Leather', 'Dave', 'dave@steelhorseleather.com', 'Quote B — floor (internal only)', 'draft', true,
  '{"orders":400,"units_per_order":1.11,"pallets":6,"shelves":8,"bins":20,"inbound_pallets":2,"inbound_cartons":10,"returns":20,"intl_share":0.01,"packaging":"shipbay","box_share":0.05,"avg_postage":7.38,"current_cost":4847,"current_cost_cash":3972,"b2b_orders":4}'::jsonb,
  '{"pick_first":1.50,"pick_addl":0.25,"mailer":0,"box_single":0,"box_double":0,"storage_pallet":30,"storage_shelf":10,"storage_bin":2.50,"storage_waived_months":6,"receiving_pallet":0,"receiving_carton":0,"receiving_waived_months":6,"returns":0,"returns_addl":0,"intl":2.50,"minimum":250,"minimum_waived_months":6,"postage_markup_pct":0,"postage_guarantee_avg":7.38,"b2b_order":5.50,"b2b_unit":0.40,"intro":{"months":0}}'::jsonb,
  '{"labor_rate":22.40,"min_per_order":3.5,"min_per_addl_unit":0.5,"min_per_pallet_in":30,"min_per_carton_in":3,"min_per_return":6,"min_per_b2b_order":12,"pack_cost_mailer":0.12,"pack_cost_box_single":0.62,"pack_cost_box_double":0.90,"dunnage_per_order":0.06,"space_cost_pallet":26,"space_cost_shelf":5,"space_cost_bin":1.25,"overhead_per_month":60,"postage_cost_avg":7.38}'::jsonb,
  '[400,650,1000]'::jsonb,
  'Walk-away floor, never sent. Negative contribution at every volume — only defensible with a 12-month term and a real UPS contract.'
where not exists (select 1 from quotes where company = 'Steel Horse Leather' and internal_only);

insert into quotes (company, contact_name, contact_email, contact_phone, label, status, internal_only, inputs, rates, costs, scenarios, notes)
select 'Vinyl Moon', 'Brandon Bogajewicz', 'hello@vinylmoon.co', '+1 310-883-5632', 'Growth tier — standard rate card', 'draft', false,
  '{"orders":4000,"units_per_order":1.4,"pallets":16,"shelves":40,"bins":0,"inbound_pallets":20,"inbound_cartons":30,"returns":40,"intl_share":0.03,"packaging":"client","box_share":1,"avg_postage":4.95,"current_cost":null,"b2b_orders":0,"batch_share":0.85,"batch_days":4}'::jsonb,
  '{"pick_first":1.80,"pick_addl":0.40,"mailer":0,"box_single":0.85,"box_double":1.20,"storage_pallet":25,"storage_shelf":10,"storage_bin":2.50,"storage_waived_months":0,"receiving_pallet":20,"receiving_carton":3,"receiving_waived_months":0,"returns":3,"returns_addl":0.50,"intl":2.50,"minimum":250,"minimum_waived_months":2,"postage_markup_pct":0,"postage_guarantee_avg":null,"b2b_order":5.50,"b2b_unit":0.40,"intro":{"months":0}}'::jsonb,
  '{"labor_rate":22.40,"min_per_order":3.0,"min_per_addl_unit":0.4,"min_per_pallet_in":30,"min_per_carton_in":3,"min_per_return":6,"min_per_b2b_order":12,"pack_cost_mailer":0.12,"pack_cost_box_single":0.62,"pack_cost_box_double":0.90,"dunnage_per_order":0.08,"space_cost_pallet":26,"space_cost_shelf":5,"space_cost_bin":1.25,"overhead_per_month":60,"postage_cost_avg":4.95}'::jsonb,
  '[3000,4000,5000]'::jsonb,
  'Call 2026-10-21: 4,000 orders/mo; Derek committed that we can do the monthly batch drop. Vendor lead data: 150–500 SKUs, no hazmat. Vinyl record club (LA). ASSUMED until confirmed: 1.4 units/order, client-supplied 12" LP mailers, ~1 lb → USPS Media Mail (sound recordings qualify) ≈ $4.95 avg, 16 pallets + 40 shelves, 20 inbound pallets/mo, 85% of the month ships in a 4-day drop window (see batch planning in the quote). Growth tier $1.80 / $0.40.'
where not exists (select 1 from quotes where company = 'Vinyl Moon');
