-- Systems phase: Client Portal login, Shipping Label Access, Commerce Channel Access; Paperwork: Additional documents (optional)
alter table onboarding_tasks add column if not exists optional boolean not null default false;
alter table onboarding_tasks drop constraint if exists onboarding_tasks_kind_check;
alter table onboarding_tasks add constraint onboarding_tasks_kind_check check (kind in ('manual','document','billing','portal','integration'));

insert into onboarding_tasks (org_id, key, label, phase, sort, kind, optional)
select id, 'additional_docs', 'Additional documents', 'paperwork', 80, 'document', true from orgs
on conflict (org_id, key) do nothing;

update onboarding_tasks set label = 'Client Portal',          kind = 'portal',      sort = 100 where key = 'portal_login';
update onboarding_tasks set label = 'Shipping Label Access',  kind = 'integration', sort = 110 where key = 'label_access';
update onboarding_tasks set label = 'Commerce Channel Access',kind = 'integration', sort = 120 where key = 'shopify_connected';
update onboarding_tasks set done = false, done_at = null, done_by = null where kind in ('portal','integration');

create or replace view v_onboarding_progress with (security_invoker = true) as
select o.id as org_id, o.name, o.slug, o.status, o.contact_name, o.contact_email, o.go_live_date, o.founding_account, o.created_at,
  count(t.id) filter (where not t.optional) as total, count(t.id) filter (where t.done and not t.optional) as done,
  max(t.done_at) as last_activity,
  o.go_live_status, o.sales_rep
from orgs o left join onboarding_tasks t on t.org_id = o.id
group by o.id;

create or replace function ensure_onboarding(p_org_id uuid) returns void
language sql security definer set search_path = public as $$
  insert into onboarding_tasks (org_id, key, label, phase, sort, kind, optional) values
    (p_org_id, 'intake_form',      'Intake form',                            'paperwork', 10, 'document', false),
    (p_org_id, 'w9',               'W-9',                                    'paperwork', 20, 'document', false),
    (p_org_id, 'formation_cert',   'Formation Certificate',                  'paperwork', 30, 'document', false),
    (p_org_id, 'rate_card',        'Rate Card Signed',                       'paperwork', 40, 'document', false),
    (p_org_id, 'agreement',        'Account Agreement',                      'paperwork', 50, 'document', false),
    (p_org_id, 'sla',              'SLA',                                    'paperwork', 60, 'document', false),
    (p_org_id, 'billing_method',   'Billing method',                         'paperwork', 70, 'billing',  false),
    (p_org_id, 'additional_docs',  'Additional documents',                   'paperwork', 80, 'document', true),
    (p_org_id, 'portal_login',     'Client Portal',                          'systems',   100, 'portal',      false),
    (p_org_id, 'label_access',     'Shipping Label Access',                  'systems',   110, 'integration', false),
    (p_org_id, 'shopify_connected','Commerce Channel Access',                'systems',   120, 'integration', false),
    (p_org_id, 'sku_catalog',      'SKU catalog imported',                   'inventory', 210, 'manual', false),
    (p_org_id, 'packaging_spec',   'Packaging spec & right-size approval',   'inventory', 220, 'manual', false),
    (p_org_id, 'returns_rules',    'Returns / exchange rules confirmed',     'inventory', 230, 'manual', false),
    (p_org_id, 'inbound_scheduled','Initial inbound transfer scheduled',     'inventory', 240, 'manual', false),
    (p_org_id, 'inbound_received', 'Initial inventory received & counted',   'inventory', 250, 'manual', false),
    (p_org_id, 'test_orders',      'Test orders shipped end to end',         'go_live',   310, 'manual', false),
    (p_org_id, 'go_live_date',     'Go-live date set',                       'go_live',   320, 'manual', false),
    (p_org_id, 'go_live',          'Live — first real orders shipped',       'go_live',   330, 'manual', false)
  on conflict (org_id, key) do nothing;
$$;

-- Client portal login (created by the portal-access edge function)
alter table orgs add column if not exists portal_user_id uuid;
alter table orgs add column if not exists portal_created_at timestamptz;
alter table orgs add column if not exists portal_invited_at timestamptz;

-- Connections to shipping-label services and commerce channels
create table if not exists integrations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  category text not null check (category in ('shipping','commerce')),
  provider text not null,
  label text,
  status text not null default 'pending' check (status in ('pending','connected','error','disconnected')),
  auth_type text not null default 'api_key' check (auth_type in ('api_key','oauth','manual')),
  verified boolean not null default false,
  error text,
  meta jsonb not null default '{}',
  connected_at timestamptz,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, category, provider)
);
alter table integrations enable row level security;
create policy shipbay_all_integrations on integrations for all using (is_shipbay()) with check (is_shipbay());
create policy client_read_integrations on integrations for select using (org_id = current_org_id());
create or replace trigger integrations_touch before update on integrations for each row execute function touch_updated_at();

-- Secrets: RLS on, no policies → only service-role edge functions can read/write
create table if not exists integration_secrets (
  integration_id uuid primary key references integrations(id) on delete cascade,
  secrets jsonb not null,
  updated_at timestamptz not null default now()
);
alter table integration_secrets enable row level security;

create table if not exists oauth_states (
  state text primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  provider text not null,
  category text not null,
  meta jsonb not null default '{}',
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table oauth_states enable row level security;

create or replace function integrations_sync_task() returns trigger language plpgsql security definer set search_path = public as $$
declare v_key text; v_any boolean;
begin
  v_key := case new.category when 'shipping' then 'label_access' else 'shopify_connected' end;
  select exists (select 1 from integrations i where i.org_id = new.org_id and i.category = new.category and i.status = 'connected') into v_any;
  update onboarding_tasks set done = v_any, done_at = case when v_any then coalesce(done_at, now()) end
    where org_id = new.org_id and key = v_key;
  return new;
end $$;
create or replace trigger integrations_task_sync after insert or update of status on integrations for each row execute function integrations_sync_task();
revoke execute on function integrations_sync_task() from public, anon, authenticated;
