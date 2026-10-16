-- ShipBay Portal: core schema
create extension if not exists pgcrypto;

-- Organizations (clients)
create table if not exists orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  status text not null default 'onboarding' check (status in ('onboarding','active','paused','churned')),
  shopify_domain text unique,            -- e.g. steel-horse-leather.myshopify.com
  cutoff_time time not null default '14:00',
  timezone text not null default 'America/New_York',
  ships_saturday boolean not null default true,
  contact_name text,
  contact_email text,
  contact_phone text,
  notes text,
  created_at timestamptz not null default now()
);

-- Integration secrets: never exposed through the API (RLS with no policies = deny all; edge functions use service role)
create table if not exists org_integrations (
  org_id uuid primary key references orgs(id) on delete cascade,
  shopify_access_token text,
  shopify_webhook_secret text,
  shopify_location_id bigint,
  updated_at timestamptz not null default now()
);
alter table org_integrations enable row level security;

-- Profiles: one per auth user
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid references orgs(id) on delete set null,
  role text not null default 'client_user' check (role in ('shipbay_admin','shipbay_staff','client_admin','client_user')),
  full_name text,
  email text,
  created_at timestamptz not null default now()
);

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name, org_id, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
    nullif(new.raw_user_meta_data->>'org_id','')::uuid,
    coalesce(new.raw_user_meta_data->>'role','client_user')
  )
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- Helper functions for RLS
create or replace function is_shipbay() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role in ('shipbay_admin','shipbay_staff'));
$$;
create or replace function current_org_id() returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from profiles where id = auth.uid();
$$;

-- Rate cards (one active per org; founding terms are a dated row)
create table if not exists rate_cards (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  label text not null default 'Standard',
  effective_from date not null default current_date,
  effective_to date,
  pick_pack_first numeric(8,2) not null default 1.95,
  pick_pack_addl numeric(8,2) not null default 0.40,
  storage_pallet numeric(8,2) not null default 30,
  storage_shelf numeric(8,2) not null default 10,
  storage_bin numeric(8,2) not null default 2.50,
  storage_waived_until date,
  receiving_pallet numeric(8,2) not null default 10,
  receiving_carton numeric(8,2) not null default 3,
  returns_fee numeric(8,2) not null default 3,
  packaging_mailer numeric(8,2) not null default 0.20,
  packaging_box_single numeric(8,2) not null default 0.85,
  packaging_box_double numeric(8,2) not null default 1.20,
  intl_surcharge numeric(8,2) not null default 2.50,
  monthly_minimum numeric(8,2) not null default 250,
  minimum_waived_until date,
  postage_markup_pct numeric(5,2) not null default 0,
  postage_guarantee_avg numeric(8,2),       -- e.g. 7.38 for Steel Horse
  postage_guarantee_until date,
  notes text,
  created_at timestamptz not null default now()
);

-- SKUs
create table if not exists skus (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  sku text not null,
  name text not null,
  variant text,
  barcode text,
  shopify_product_id bigint,
  shopify_variant_id bigint,
  weight_oz numeric(8,2),
  packaging text check (packaging in ('mailer','box_single','box_double','client_supplied')) default 'mailer',
  is_physical boolean not null default true,   -- false for e.g. shipping-protection lines
  low_stock_threshold int not null default 5,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, sku)
);

-- Inventory ledger (every change is a move)
create table if not exists inventory_moves (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  sku_id uuid not null references skus(id) on delete cascade,
  qty int not null,
  reason text not null check (reason in ('receive','pick','adjust','return_restock','cycle_count','transfer','damage')),
  ref_type text,
  ref_id uuid,
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists inventory_moves_sku_idx on inventory_moves(sku_id);

-- Inbound shipments (ASNs)
create table if not exists inbound_shipments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  reference text not null,
  status text not null default 'expected' check (status in ('expected','in_transit','received','discrepancy','cancelled')),
  carrier text,
  tracking text,
  origin text,
  expected_at date,
  received_at timestamptz,
  pallets int not null default 0,
  cartons int not null default 0,
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create table if not exists inbound_lines (
  id uuid primary key default gen_random_uuid(),
  inbound_id uuid not null references inbound_shipments(id) on delete cascade,
  sku_id uuid not null references skus(id),
  qty_expected int not null default 0,
  qty_received int
);

-- Orders
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  shopify_order_id bigint,
  order_number text not null,
  channel text not null default 'shopify',
  status text not null default 'new' check (status in ('new','on_hold','backordered','picked','packed','shipped','cancelled')),
  customer_name text,
  customer_email text,
  ship_to jsonb,
  shipping_method text,
  is_international boolean not null default false,
  placed_at timestamptz not null default now(),
  received_at timestamptz not null default now(),   -- when it hit the portal
  cutoff_at timestamptz,                             -- same-day cutoff deadline for this order
  shipped_at timestamptz,
  total_units int not null default 0,
  tags text[] not null default '{}',
  notes text,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, shopify_order_id)
);
create index if not exists orders_org_status_idx on orders(org_id, status);
create index if not exists orders_placed_idx on orders(placed_at desc);

create table if not exists order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  sku_id uuid references skus(id),
  sku text,
  name text not null,
  qty int not null default 1,
  shopify_line_id bigint,
  is_physical boolean not null default true
);

-- Shipments (labels)
create table if not exists shipments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  carrier text,
  service text,
  tracking text,
  label_source text not null default 'client_shopify' check (label_source in ('client_shopify','shipbay_platform','other')),
  label_cost numeric(8,2),
  postage_billed numeric(8,2),
  packaging text check (packaging in ('mailer','box_single','box_double','client_supplied')),
  weight_oz numeric(8,2),
  shipped_at timestamptz not null default now(),
  delivered_at timestamptz,
  shopify_fulfillment_id bigint,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists shipments_order_idx on shipments(order_id);

-- Returns
create table if not exists returns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  order_id uuid references orders(id) on delete set null,
  rma text not null,
  status text not null default 'requested' check (status in ('requested','in_transit','received','inspected','restocked','disposed','closed')),
  reason text,
  disposition text,
  items jsonb not null default '[]',
  received_at timestamptz,
  fee numeric(8,2),
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

-- Support
create table if not exists tickets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  subject text not null,
  status text not null default 'open' check (status in ('open','pending','closed')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  order_id uuid references orders(id) on delete set null,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  author_id uuid references profiles(id),
  body text not null,
  internal boolean not null default false,   -- ShipBay-only note
  created_at timestamptz not null default now()
);

-- Storage snapshots (ops records monthly footprint)
create table if not exists storage_snapshots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  period date not null,              -- first of month
  pallets int not null default 0,
  shelves int not null default 0,
  bins int not null default 0,
  note text,
  created_at timestamptz not null default now(),
  unique (org_id, period)
);

-- Invoices
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  invoice_number text not null unique,
  period_start date not null,
  period_end date not null,
  status text not null default 'draft' check (status in ('draft','sent','paid','void')),
  subtotal numeric(10,2) not null default 0,
  total numeric(10,2) not null default 0,
  issued_at timestamptz,
  due_at date,
  paid_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);
create table if not exists invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  category text not null check (category in ('pick_pack','additional_units','packaging','postage','storage','receiving','returns','international','minimum','adjustment')),
  description text not null,
  qty numeric(10,2) not null default 1,
  unit_price numeric(10,4) not null default 0,
  amount numeric(10,2) not null default 0,
  sort int not null default 0
);

-- updated_at helper
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists orders_touch on orders;
create trigger orders_touch before update on orders for each row execute function touch_updated_at();
drop trigger if exists tickets_touch on tickets;
create trigger tickets_touch before update on tickets for each row execute function touch_updated_at();
