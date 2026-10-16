-- ===== Receiving waiver (founding-terms free transfer) =====
alter table inbound_shipments add column if not exists receiving_waived boolean not null default false;
create or replace function guard_receiving_waived() returns trigger language plpgsql as $$
begin
  if new.receiving_waived and not is_shipbay() then new.receiving_waived := false; end if;
  return new;
end $$;
create or replace trigger inbound_guard_waiver before insert or update on inbound_shipments for each row execute function guard_receiving_waived();
update inbound_shipments set receiving_waived = true where id = 'b1b2c3d4-0000-4000-8000-000000000001';

-- ===== Audit trail =====
create table if not exists events (
  id bigint generated always as identity primary key,
  org_id uuid references orgs(id) on delete cascade,
  entity text not null,
  entity_id uuid not null,
  action text not null,
  from_value text,
  to_value text,
  meta jsonb,
  actor_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists events_entity_idx on events(entity, entity_id, created_at desc);
create index if not exists events_org_idx on events(org_id, created_at desc);
alter table events enable row level security;
create policy shipbay_all_events on events for all using (is_shipbay()) with check (is_shipbay());
create policy client_read_events on events for select using (org_id = current_org_id());

create or replace function log_status_event() returns trigger language plpgsql security definer set search_path = public as $$
declare ent text := tg_argv[0];
begin
  if tg_op = 'INSERT' then
    insert into events (org_id, entity, entity_id, action, to_value, actor_id) values (new.org_id, ent, new.id, 'created', new.status, auth.uid());
  elsif new.status is distinct from old.status then
    insert into events (org_id, entity, entity_id, action, from_value, to_value, actor_id) values (new.org_id, ent, new.id, 'status_change', old.status, new.status, auth.uid());
  end if;
  return new;
end $$;
create or replace trigger orders_events after insert or update on orders for each row execute function log_status_event('order');
create or replace trigger inbound_events after insert or update on inbound_shipments for each row execute function log_status_event('inbound');
create or replace trigger returns_events after insert or update on returns for each row execute function log_status_event('return');
create or replace trigger tickets_events after insert or update on tickets for each row execute function log_status_event('ticket');
create or replace trigger invoices_events after insert or update on invoices for each row execute function log_status_event('invoice');

-- ===== Shopify webhook log =====
create table if not exists webhook_log (
  id bigint generated always as identity primary key,
  org_id uuid references orgs(id) on delete set null,
  source text not null default 'shopify',
  topic text,
  shop_domain text,
  external_id text,
  status text not null check (status in ('ok','rejected','error')),
  error text,
  payload jsonb,
  received_at timestamptz not null default now()
);
create index if not exists webhook_log_recent_idx on webhook_log(received_at desc);
alter table webhook_log enable row level security;
create policy shipbay_read_webhook_log on webhook_log for select using (is_shipbay());

-- ===== Documents =====
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  kind text not null check (kind in ('w9','agreement','sla','rate_card','intake_form','packaging_spec','routing_guide','resale_cert','formation_cert','insurance','other')),
  title text not null,
  storage_path text not null,
  mime text, size_bytes bigint,
  signed_at date, expires_at date,
  visible_to_client boolean not null default true,
  uploaded_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
alter table documents enable row level security;
create policy shipbay_all_documents on documents for all using (is_shipbay()) with check (is_shipbay());
create policy client_read_documents on documents for select using (org_id = current_org_id() and visible_to_client);
create policy client_upload_documents on documents for insert with check (org_id = current_org_id() and uploaded_by = auth.uid());

insert into storage.buckets (id, name, public, file_size_limit)
values ('client-docs', 'client-docs', false, 26214400) on conflict (id) do nothing;
create policy "client-docs staff all" on storage.objects for all
  using (bucket_id = 'client-docs' and is_shipbay()) with check (bucket_id = 'client-docs' and is_shipbay());
create policy "client-docs own org read" on storage.objects for select
  using (bucket_id = 'client-docs' and (storage.foldername(name))[1] = current_org_id()::text);
create policy "client-docs own org upload" on storage.objects for insert
  with check (bucket_id = 'client-docs' and (storage.foldername(name))[1] = current_org_id()::text);

-- ===== Locations =====
create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  zone text,
  kind text not null default 'shelf' check (kind in ('shelf','bin','pallet','floor','dock')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table locations enable row level security;
create policy shipbay_all_locations on locations for all using (is_shipbay()) with check (is_shipbay());
create policy anyone_read_locations on locations for select using (true);
alter table skus add column if not exists location_id uuid references locations(id) on delete set null;
alter table skus add column if not exists dims_in text;
alter table skus add column if not exists declared_value numeric(10,2);
alter table skus add column if not exists image_url text;
alter table inventory_moves add column if not exists location_id uuid references locations(id) on delete set null;

-- ===== Org settings =====
alter table orgs add column if not exists billing_email text;
alter table orgs add column if not exists ops_email text;
alter table orgs add column if not exists notify_low_stock boolean not null default true;
alter table orgs add column if not exists notify_daily_summary boolean not null default true;
alter table orgs add column if not exists ship_from_address jsonb;
alter table orgs add column if not exists return_address jsonb;
alter table orgs add column if not exists packaging_rules text;
alter table orgs add column if not exists go_live_date date;
alter table orgs add column if not exists founding_account boolean not null default false;
alter table orgs add column if not exists lead_id uuid;
update orgs set founding_account = true, billing_email = 'dave@steelhorseleather.com', ops_email = 'dave@steelhorseleather.com',
  return_address = '{"name":"Steel Horse Leather c/o ShipBay","address1":"115 Stryker Ln","city":"Hillsborough","province":"NJ","zip":"08844","country":"US"}'
  where slug = 'steel-horse';

-- ===== Website intake → client =====
alter table leads add column if not exists org_id uuid references orgs(id) on delete set null;
alter table leads add column if not exists converted_at timestamptz;
update leads set org_id = 'a1b2c3d4-0000-4000-8000-000000000001', stage = 'won', converted_at = now()
  where id = '3ba8f732-be62-48ff-8598-b2bfdf6153ca' and org_id is null;
update orgs set lead_id = '3ba8f732-be62-48ff-8598-b2bfdf6153ca' where slug = 'steel-horse';

create or replace function convert_lead(p_lead_id uuid, p_slug text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare l leads%rowtype; v_org uuid; v_slug text;
begin
  if not is_shipbay() then raise exception 'not authorized'; end if;
  select * into l from leads where id = p_lead_id;
  if l.id is null then raise exception 'lead not found'; end if;
  if l.org_id is not null then return l.org_id; end if;
  v_slug := coalesce(p_slug, regexp_replace(lower(coalesce(l.brand, l.name)), '[^a-z0-9]+', '-', 'g'));
  insert into orgs (name, slug, contact_name, contact_email, contact_phone, lead_id, notes)
  values (coalesce(l.brand, l.name), v_slug, l.name, l.email, l.phone, l.id, 'Converted from website lead (' || coalesce(l.source,'website') || '). Volume: ' || coalesce(l.volume,'?'))
  returning id into v_org;
  insert into rate_cards (org_id, label) values (v_org, 'Standard (<1,000 orders/mo)');
  update leads set org_id = v_org, stage = 'won', converted_at = now() where id = l.id;
  return v_org;
end $$;

-- ===== Staff =====
alter table profiles add column if not exists phone text;
alter table profiles add column if not exists active boolean not null default true;
alter table profiles add column if not exists last_seen_at timestamptz;

-- ===== Dashboard metrics =====
create or replace view v_daily_ops with (security_invoker = true) as
select o.org_id, (o.shipped_at at time zone 'America/New_York')::date as day,
  count(*) as shipped,
  sum(case when o.cutoff_at is null or o.shipped_at <= o.cutoff_at then 1 else 0 end) as on_time,
  sum(o.total_units) as units,
  sum(case when o.is_international then 1 else 0 end) as intl
from orders o where o.status = 'shipped' and o.shipped_at is not null
group by 1, 2;

create or replace view v_org_month with (security_invoker = true) as
with o as (
  select org_id, date_trunc('month', shipped_at at time zone 'America/New_York')::date as month,
    count(*) as orders, sum(total_units) as units,
    round(100.0 * sum(case when cutoff_at is null or shipped_at <= cutoff_at then 1 else 0 end) / count(*), 1) as on_time_pct
  from orders where status = 'shipped' and shipped_at is not null group by 1, 2
), s as (
  select org_id, date_trunc('month', shipped_at at time zone 'America/New_York')::date as month,
    sum(coalesce(postage_billed, label_cost, 0)) as postage,
    sum(case when label_source = 'shipbay_platform' then coalesce(postage_billed, label_cost, 0) else 0 end) as postage_billable
  from shipments group by 1, 2
)
select o.*, coalesce(s.postage, 0) as postage, coalesce(s.postage_billable, 0) as postage_billable
from o left join s on s.org_id = o.org_id and s.month = o.month;

create or replace view v_open_queue with (security_invoker = true) as
select o.*, g.name as org_name,
  case when o.cutoff_at < now() then 'late' when o.cutoff_at < now() + interval '2 hours' then 'due_soon' else 'ok' end as urgency,
  (select count(*) from order_lines ol left join skus s on s.id = ol.sku_id where ol.order_id = o.id and ol.is_physical and (s.id is null or not s.active)) as unmapped_lines
from orders o join orgs g on g.id = o.org_id
where o.status in ('new','on_hold','backordered','picked','packed');

grant select on v_daily_ops, v_org_month, v_open_queue to authenticated;

create or replace function snapshot_storage(p_org_id uuid, p_pallets int, p_shelves int, p_bins int, p_note text default null)
returns void language sql security definer set search_path = public as $$
  insert into storage_snapshots (org_id, period, pallets, shelves, bins, note)
  values (p_org_id, date_trunc('month', current_date)::date, p_pallets, p_shelves, p_bins, p_note)
  on conflict (org_id, period) do update set pallets = excluded.pallets, shelves = excluded.shelves, bins = excluded.bins, note = excluded.note;
$$;

insert into locations (code, zone, kind) values
('RCV-DOCK','receiving','dock'),('RET-01','returns','shelf'),('STG-01','staging','floor'),
('A-01','pick','shelf'),('A-02','pick','shelf'),('A-03','pick','shelf'),('A-04','pick','shelf'),
('B-01','pick','shelf'),('B-02','pick','shelf'),('B-03','pick','shelf'),('B-04','pick','shelf'),
('P-01','bulk','pallet'),('P-02','bulk','pallet'),('P-03','bulk','pallet'),('P-04','bulk','pallet')
on conflict (code) do nothing;
