-- ShipBay WMS, step 1: pallets. A pallet is received at the receiving station for one brand, gets a PSKU# (one per
-- pallet, never reused) and a 4x6 label carrying the brand name, the PSKU# and its barcode.
-- What is on the pallet (products, units) comes in a later step; this table tracks the pallet itself.
-- Connector-safe form: additive, create-or-replace, guarded policies.

create sequence if not exists wms_psku_seq start 1;

create table if not exists wms_pallets (
  id uuid primary key default gen_random_uuid(),
  psku text not null unique,                       -- PSKU-000001: printed on the label and encoded in the barcode
  org_id uuid not null references orgs(id),        -- the brand
  status text not null default 'received',         -- received | void (more states arrive with put-away and breakdown)
  reference text,                                  -- PO / BOL / what the brand calls the shipment
  carrier text,
  cartons int,
  notes text,
  batch_key text,                                  -- pallets entered together (same truck) share this
  batch_pos int not null default 1,                -- 2 of 5
  batch_size int not null default 1,
  client_key text unique,                          -- idempotency: a retry or a double click never makes a second pallet
  received_at timestamptz not null default now(),
  received_by uuid references profiles(id),
  received_by_name text,
  label_prints int not null default 0,
  last_printed_at timestamptz,
  voided_at timestamptz,
  voided_by uuid references profiles(id),
  void_reason text,
  created_at timestamptz not null default now()
);
create index if not exists wms_pallets_org_idx on wms_pallets (org_id, received_at desc);
create index if not exists wms_pallets_received_idx on wms_pallets (received_at desc);

-- Floor staff only (not sales, not setters, not clients).
create or replace function is_wms_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role in ('shipbay_admin','shipbay_staff'));
$$;

alter table wms_pallets enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'wms_pallets' and policyname = 'wms_pallets_read') then
    -- staff read every pallet; a brand's own logins read their brand's pallets (this is what the client portal shows)
    create policy wms_pallets_read on wms_pallets for select to authenticated
      using (is_wms_staff() or org_id = current_org_id());
  end if;
end $$;
-- No insert / update / delete policies: every write goes through the functions below.

-- Receive p_count pallets for one brand. Returns the new rows in label order.
create or replace function wms_receive_pallets(
  p_org uuid, p_count int default 1, p_reference text default null, p_carrier text default null,
  p_cartons int default null, p_notes text default null, p_key text default null
) returns setof wms_pallets
language plpgsql security definer set search_path = public as $$
declare
  v_n int := coalesce(p_count, 1);
  v_key text := coalesce(nullif(trim(p_key), ''), gen_random_uuid()::text);
  v_name text; i int;
begin
  if not is_wms_staff() then raise exception 'This login cannot receive pallets.'; end if;
  if v_n < 1 or v_n > 60 then raise exception 'Receive between 1 and 60 pallets at a time.'; end if;
  if not exists (select 1 from orgs where id = p_org) then raise exception 'Pick a brand first.'; end if;
  if p_cartons is not null and p_cartons < 0 then raise exception 'Cartons cannot be negative.'; end if;

  -- a retry of the same request returns what the first one made
  if exists (select 1 from wms_pallets where batch_key = v_key) then
    return query select * from wms_pallets where batch_key = v_key order by batch_pos;
    return;
  end if;

  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  for i in 1..v_n loop
    insert into wms_pallets (psku, org_id, reference, carrier, cartons, notes, batch_key, batch_pos, batch_size, client_key, received_by, received_by_name)
    values ('PSKU-' || lpad(nextval('wms_psku_seq')::text, 6, '0'), p_org,
            nullif(trim(p_reference), ''), nullif(trim(p_carrier), ''), p_cartons, nullif(trim(p_notes), ''),
            v_key, i, v_n, v_key || ':' || i, auth.uid(), v_name);
  end loop;
  return query select * from wms_pallets where batch_key = v_key order by batch_pos;
end $$;

-- Count a label print (first print and every reprint).
create or replace function wms_mark_printed(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  if not is_wms_staff() then raise exception 'This login cannot print pallet labels.'; end if;
  update wms_pallets set label_prints = label_prints + 1, last_printed_at = now() where id = any(p_ids);
  get diagnostics v = row_count;
  return v;
end $$;

-- A pallet entered by mistake is voided, never deleted: the PSKU# stays on record and is not reused.
create or replace function wms_void_pallet(p_id uuid, p_reason text) returns wms_pallets
language plpgsql security definer set search_path = public as $$
declare r wms_pallets;
begin
  if not is_wms_staff() then raise exception 'This login cannot void pallets.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Say why this pallet is being voided.'; end if;
  update wms_pallets set status = 'void', voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason)
   where id = p_id and status <> 'void' returning * into r;
  if r.id is null then raise exception 'That pallet is not on file or is already voided.'; end if;
  return r;
end $$;

revoke all on function wms_receive_pallets(uuid, int, text, text, int, text, text) from public, anon;
revoke all on function wms_mark_printed(uuid[]) from public, anon;
revoke all on function wms_void_pallet(uuid, text) from public, anon;
grant execute on function wms_receive_pallets(uuid, int, text, text, int, text, text) to authenticated;
grant execute on function wms_mark_printed(uuid[]) to authenticated;
grant execute on function wms_void_pallet(uuid, text) to authenticated;
revoke all on wms_pallets from anon;
grant select on wms_pallets to authenticated;
