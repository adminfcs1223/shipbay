-- 2026-11-14 (Derek): open boxes. When a carton is found open, its units get their own labels and go to the open-box
-- shelf; later, when pick and pack runs in the WMS, those units are the first to go (then first in, first out).
-- Connector-safe form: additive, create-or-replace, guarded policy.

create sequence if not exists wms_unit_seq start 1;

alter table wms_cartons add column if not exists open_box_at timestamptz;
alter table wms_cartons add column if not exists open_units int;
alter table wms_cartons add column if not exists open_by_name text;

create table if not exists wms_units (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                      -- U0000001: printed on the unit's label
  org_id uuid not null references orgs(id),
  carton_id uuid references wms_cartons(id) on delete set null,
  pallet_id uuid references wms_pallets(id) on delete set null,
  sku_id uuid references skus(id),
  item_no text,
  item_name text,
  fba boolean not null default false,
  location_id uuid references locations(id),
  status text not null default 'shelved',         -- shelved | picked (pick and pack comes later)
  created_at timestamptz not null default now(),
  created_by_name text
);
create index if not exists wms_units_pallet_idx on wms_units (pallet_id);
create index if not exists wms_units_sku_idx on wms_units (sku_id, status, created_at);
alter table wms_units enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'wms_units' and policyname = 'wms_units_read') then
    create policy wms_units_read on wms_units for select to authenticated using (is_wms_staff() or org_id = current_org_id());
  end if;
end $$;
revoke all on wms_units from anon;
grant select on wms_units to authenticated;

-- the open-box shelf
insert into locations (code, zone, kind, active) values ('OB-01', 'open box', 'shelf', true) on conflict (code) do nothing;

-- A carton was found open: p_units loose units come out of it, each gets a unit number and the open-box shelf.
-- The carton counts as scanned in (someone had it in their hands). One carton is opened once.
create or replace function wms_open_box(p_carton_code text, p_units int, p_location uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c wms_cartons; p wms_pallets; l locations; v_who text; i int;
begin
  if not is_wms_staff() then raise exception 'This login cannot open a box.'; end if;
  if p_units is null or p_units < 1 or p_units > 500 then raise exception 'Say how many units are in the box (1 to 500).'; end if;
  select * into c from wms_cartons where code = upper(trim(p_carton_code)) for update;
  if c.id is null then raise exception '% is not a carton label on file.', upper(trim(p_carton_code)); end if;
  select * into p from wms_pallets where id = c.pallet_id;
  if p.status = 'void' then raise exception '% was voided.', p.psku; end if;
  if c.open_box_at is not null then raise exception 'Carton % of % is already an open box with % units.', c.seq, p.psku, c.open_units; end if;
  if p_location is not null then select * into l from locations where id = p_location and active;
  else select * into l from locations where active and lower(zone) = 'open box' order by code limit 1; end if;
  if l.id is null then raise exception 'There is no open-box shelf set up.'; end if;

  select coalesce(full_name, email) into v_who from profiles where id = auth.uid();
  update wms_cartons set open_box_at = now(), open_units = p_units, open_by_name = v_who,
         scanned_at = coalesce(scanned_at, now()), scanned_by_name = coalesce(scanned_by_name, v_who) where id = c.id;
  for i in 1..p_units loop
    insert into wms_units (code, org_id, carton_id, pallet_id, sku_id, item_no, item_name, fba, location_id, created_by_name)
    values ('U' || lpad(nextval('wms_unit_seq')::text, 7, '0'), c.org_id, c.id, p.id, coalesce(c.sku_id, p.sku_id), coalesce(c.item_no, p.item_no),
            coalesce(c.item_name, case when p.mixed then null else p.item_name end, p.notes), coalesce(c.fba, p.fba, false), l.id, v_who);
  end loop;
  return jsonb_build_object('pallet_id', p.id, 'psku', p.psku, 'seq', c.seq, 'units', p_units, 'location', l.code, 'location_id', l.id,
    'scanned', (select count(*) from wms_cartons where pallet_id = p.id and scanned_at is not null), 'total', (select count(*) from wms_cartons where pallet_id = p.id));
end $$;
revoke all on function wms_open_box(text, int, uuid) from public, anon;
grant execute on function wms_open_box(text, int, uuid) to authenticated;
