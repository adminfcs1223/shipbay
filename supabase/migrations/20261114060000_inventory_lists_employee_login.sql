-- 2026-11-14 (Derek): (1) a brand uploads its inventory list from its onboarding; it reaches the product database after
-- ShipBay reviews it. Every product gets an item number; a product keeps whatever ASINs it has (none, one or several);
-- the list's unit counts are stored as EXPECTED units (split FBA / FBM), not on-hand stock.
-- (2) WMS sign-in by employee number + 6-digit PIN; numbers and PINs are created in Admin settings.
-- Connector-safe form: additive, create-or-replace, guarded policies.

-- ---------- products: what an Amazon-style list carries ----------
alter table skus add column if not exists asins text[] not null default '{}';
alter table skus add column if not exists supplier text;
alter table skus add column if not exists expected_qty int;
alter table skus add column if not exists expected_fba int;
alter table skus add column if not exists expected_fbm int;
alter table skus add column if not exists expected_at timestamptz;
create index if not exists skus_asins_idx on skus using gin (asins);

create sequence if not exists item_no_seq start 1;

-- ---------- inventory lists ----------
create table if not exists inventory_lists (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  status text not null default 'pending',          -- pending | approved | rejected | replaced
  file_name text,
  storage_path text,
  document_id uuid,
  note text,
  products int not null default 0,
  units int not null default 0,
  units_fba int not null default 0,
  units_fbm int not null default 0,
  submitted_by uuid references profiles(id),
  submitted_by_name text,
  submitted_at timestamptz not null default now(),
  reviewed_by uuid references profiles(id),
  reviewed_at timestamptz,
  review_note text,
  result jsonb
);
create index if not exists inventory_lists_org_idx on inventory_lists (org_id, submitted_at desc);

create table if not exists inventory_list_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references inventory_lists(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  pos int not null,
  code text,                                       -- the brand's own SKU / item code, when the list has one
  asins text[] not null default '{}',
  name text not null,
  supplier text,
  qty int not null default 0,
  qty_fba int not null default 0,
  qty_fbm int not null default 0,
  sku_id uuid references skus(id) on delete set null
);
create index if not exists inventory_list_items_list_idx on inventory_list_items (list_id, pos);

alter table inventory_lists enable row level security;
alter table inventory_list_items enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'inventory_lists' and policyname = 'inventory_lists_read') then
    create policy inventory_lists_read on inventory_lists for select to authenticated using (is_shipbay() or org_id = current_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'inventory_list_items' and policyname = 'inventory_list_items_read') then
    create policy inventory_list_items_read on inventory_list_items for select to authenticated using (is_shipbay() or org_id = current_org_id());
  end if;
end $$;
-- No write policies: lists are written by the two functions below.

-- A brand (or ShipBay on its behalf) sends a list. It waits for review; a newer list replaces one still waiting.
create or replace function submit_inventory_list(p_org uuid, p_items jsonb, p_file_name text default null, p_storage_path text default null, p_note text default null, p_document uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_n int; v_name text;
begin
  if auth.uid() is null or not (is_shipbay() or current_org_id() = p_org) then raise exception 'This login cannot send a list for that brand.'; end if;
  if not exists (select 1 from orgs where id = p_org) then raise exception 'Brand not found.'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'The list is empty.'; end if;
  v_n := jsonb_array_length(p_items);
  if v_n < 1 then raise exception 'The list is empty.'; end if;
  if v_n > 20000 then raise exception 'That list has % products; send at most 20,000 at a time.', v_n; end if;

  update inventory_lists set status = 'replaced', reviewed_at = now() where org_id = p_org and status = 'pending';
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  insert into inventory_lists (org_id, file_name, storage_path, document_id, note, submitted_by, submitted_by_name)
  values (p_org, nullif(trim(p_file_name), ''), nullif(trim(p_storage_path), ''), p_document, nullif(trim(p_note), ''), auth.uid(), v_name)
  returning id into v_id;

  insert into inventory_list_items (list_id, org_id, pos, code, asins, name, supplier, qty, qty_fba, qty_fbm)
  select v_id, p_org, t.ord::int,
         nullif(left(trim(t.e->>'code'), 80), ''),
         coalesce((select array_agg(distinct upper(a)) from jsonb_array_elements_text(case when jsonb_typeof(t.e->'asins') = 'array' then t.e->'asins' else '[]'::jsonb end) a where upper(a) ~ '^[A-Z0-9]{10}$'), '{}'),
         left(trim(t.e->>'name'), 300),
         nullif(left(trim(t.e->>'supplier'), 120), ''),
         greatest(0, coalesce(nullif(regexp_replace(coalesce(t.e->>'qty', ''), '[^0-9]', '', 'g'), '')::int, 0)),
         greatest(0, coalesce(nullif(regexp_replace(coalesce(t.e->>'qty_fba', ''), '[^0-9]', '', 'g'), '')::int, 0)),
         greatest(0, coalesce(nullif(regexp_replace(coalesce(t.e->>'qty_fbm', ''), '[^0-9]', '', 'g'), '')::int, 0))
  from jsonb_array_elements(p_items) with ordinality as t(e, ord)
  where coalesce(trim(t.e->>'name'), '') <> '';

  update inventory_lists l set products = s.n, units = s.u, units_fba = s.a, units_fbm = s.m
    from (select count(*) n, coalesce(sum(qty), 0) u, coalesce(sum(qty_fba), 0) a, coalesce(sum(qty_fbm), 0) m from inventory_list_items where list_id = v_id) s
   where l.id = v_id;
  if (select products from inventory_lists where id = v_id) = 0 then raise exception 'No row in that list has a product name.'; end if;
  return v_id;
end $$;

-- ShipBay approves or rejects. Approving writes the products: a line matches an existing product by the brand's own
-- code, else by a shared ASIN, else (when neither side has an ASIN) by name; anything else is new and gets the next
-- item number. Expected units on a product are replaced by this list's numbers.
create or replace function review_inventory_list(p_list uuid, p_approve boolean, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l inventory_lists; it inventory_list_items; v_sku uuid; v_new int := 0; v_upd int := 0; v_again boolean;
begin
  if not is_shipbay() then raise exception 'Only ShipBay can review a list.'; end if;
  select * into l from inventory_lists where id = p_list for update;
  if l.id is null then raise exception 'List not found.'; end if;
  if l.status <> 'pending' then raise exception 'That list was already %.', l.status; end if;

  if not coalesce(p_approve, false) then
    if coalesce(trim(p_note), '') = '' then raise exception 'Say what needs fixing so the brand can send a corrected list.'; end if;
    update inventory_lists set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_note = trim(p_note) where id = p_list;
    if l.document_id is not null then update documents set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_note = trim(p_note) where id = l.document_id; end if;
    return jsonb_build_object('status', 'rejected');
  end if;

  for it in select * from inventory_list_items where list_id = p_list order by pos loop
    v_sku := null;
    if it.code is not null then select id into v_sku from skus where org_id = l.org_id and sku = it.code limit 1; end if;
    if v_sku is null and cardinality(it.asins) > 0 then select id into v_sku from skus where org_id = l.org_id and asins && it.asins order by created_at limit 1; end if;
    if v_sku is null and it.code is null and cardinality(it.asins) = 0 then
      select id into v_sku from skus where org_id = l.org_id and cardinality(asins) = 0 and lower(name) = lower(it.name) order by created_at limit 1;
    end if;

    if v_sku is null then
      insert into skus (org_id, sku, name, asins, supplier, expected_qty, expected_fba, expected_fbm, expected_at)
      values (l.org_id, coalesce(it.code, 'ITM-' || lpad(nextval('item_no_seq')::text, 6, '0')), it.name, it.asins, it.supplier, it.qty, it.qty_fba, it.qty_fbm, now())
      returning id into v_sku;
      v_new := v_new + 1;
    else
      -- two lines of the same list landing on one product add up; a line from a new list replaces the old numbers
      select exists (select 1 from inventory_list_items where list_id = p_list and sku_id = v_sku) into v_again;
      update skus set
        name = it.name,
        asins = (select coalesce(array_agg(distinct a order by a), '{}') from unnest(skus.asins || it.asins) a),
        supplier = coalesce(it.supplier, skus.supplier),
        expected_qty = case when v_again then coalesce(expected_qty, 0) else 0 end + it.qty,
        expected_fba = case when v_again then coalesce(expected_fba, 0) else 0 end + it.qty_fba,
        expected_fbm = case when v_again then coalesce(expected_fbm, 0) else 0 end + it.qty_fbm,
        expected_at = now(), active = true
      where id = v_sku;
      if not v_again then v_upd := v_upd + 1; end if;
    end if;
    update inventory_list_items set sku_id = v_sku where id = it.id;
  end loop;

  update inventory_lists set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), review_note = nullif(trim(p_note), ''),
         result = jsonb_build_object('new', v_new, 'updated', v_upd) where id = p_list;
  if l.document_id is not null then update documents set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now() where id = l.document_id; end if;
  update onboarding_tasks set done = true, done_at = coalesce(done_at, now()), done_by = auth.uid() where org_id = l.org_id and key = 'sku_catalog';
  return jsonb_build_object('status', 'approved', 'new', v_new, 'updated', v_upd, 'total', (select count(*) from skus where org_id = l.org_id and active));
end $$;

revoke all on function submit_inventory_list(uuid, jsonb, text, text, text, uuid) from public, anon;
revoke all on function review_inventory_list(uuid, boolean, text) from public, anon;
grant execute on function submit_inventory_list(uuid, jsonb, text, text, text, uuid) to authenticated;
grant execute on function review_inventory_list(uuid, boolean, text) to authenticated;
revoke all on inventory_lists, inventory_list_items from anon;
grant select on inventory_lists, inventory_list_items to authenticated;

-- ---------- WMS employees: number + PIN ----------
-- A floor employee is a login with the role wms_employee: it opens the WMS and nothing else (not the dashboard, not
-- the CRM, not client data beyond brand names). Admins and staff can be given a number + PIN too.
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check check (role in ('shipbay_admin', 'shipbay_staff', 'shipbay_sales', 'shipbay_setter', 'client_admin', 'client_user', 'wms_employee'));
alter table profiles add column if not exists employee_no int;
create unique index if not exists profiles_employee_no_key on profiles (employee_no) where employee_no is not null;

create or replace function is_wms_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active is not false and role in ('shipbay_admin','shipbay_staff','wms_employee'));
$$;

-- brand names for the receiving station (a wms_employee cannot read the orgs table itself)
create or replace function wms_brands() returns table (id uuid, name text, status text)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.status from orgs o where is_wms_staff() and o.status <> 'churned' order by o.name;
$$;
revoke all on function wms_brands() from public, anon;
grant execute on function wms_brands() to authenticated;

-- the PIN: stored hashed, never readable through the API; five wrong tries lock the number for 15 minutes
create table if not exists wms_pins (
  user_id uuid primary key references profiles(id) on delete cascade,
  pin_hash text not null,
  failed int not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table wms_pins enable row level security;
revoke all on wms_pins from anon, authenticated;

create or replace function wms_set_pin(p_user uuid, p_pin text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_pin !~ '^[0-9]{6}$' then raise exception 'The PIN is 6 digits.'; end if;
  insert into wms_pins (user_id, pin_hash) values (p_user, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)))
  on conflict (user_id) do update set pin_hash = excluded.pin_hash, failed = 0, locked_until = null, updated_at = now();
end $$;

-- Called by the wms-login function only. Never says whether the number exists.
create or replace function wms_pin_login(p_no int, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p profiles; w wms_pins;
begin
  select * into p from profiles where employee_no = p_no;
  if p.id is null or p.active is false or p.role not in ('shipbay_admin','shipbay_staff','wms_employee') then
    perform extensions.crypt(coalesce(p_pin, ''), extensions.gen_salt('bf', 10));   -- same work as a real check
    return jsonb_build_object('ok', false);
  end if;
  select * into w from wms_pins where user_id = p.id for update;
  if w.user_id is null then return jsonb_build_object('ok', false); end if;
  if w.locked_until is not null and w.locked_until > now() then
    return jsonb_build_object('ok', false, 'locked', true, 'minutes', ceil(extract(epoch from (w.locked_until - now())) / 60)::int);
  end if;
  if w.pin_hash = extensions.crypt(coalesce(p_pin, ''), w.pin_hash) then
    update wms_pins set failed = 0, locked_until = null, last_login_at = now() where user_id = p.id;
    update profiles set last_seen_at = now() where id = p.id;
    return jsonb_build_object('ok', true, 'user_id', p.id, 'email', p.email);
  end if;
  update wms_pins set failed = case when failed + 1 >= 5 then 0 else failed + 1 end,
                      locked_until = case when failed + 1 >= 5 then now() + interval '15 minutes' else null end
   where user_id = p.id;
  if w.failed + 1 >= 5 then return jsonb_build_object('ok', false, 'locked', true, 'minutes', 15); end if;
  return jsonb_build_object('ok', false);
end $$;

revoke all on function wms_set_pin(uuid, text) from public, anon, authenticated;
revoke all on function wms_pin_login(int, text) from public, anon, authenticated;
grant execute on function wms_set_pin(uuid, text) to service_role;
grant execute on function wms_pin_login(int, text) to service_role;

-- an employee number is access: only the owner (or the admin function) changes it
create or replace function public.profiles_guard() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
begin
  if auth.uid() is null then return new; end if;
  if public.is_owner() then return new; end if;
  if tg_op = 'INSERT' then
    raise exception 'Logins are created under Admin settings → Users.' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.role is distinct from old.role or new.is_owner is distinct from old.is_owner
     or new.is_sales is distinct from old.is_sales or new.closer_id is distinct from old.closer_id or new.active is distinct from old.active
     or new.org_id is distinct from old.org_id or new.email is distinct from old.email or new.employee_no is distinct from old.employee_no then
    raise exception 'Only the owner can change roles and access.' using errcode = '42501';
  end if;
  return new;
end $function$;
