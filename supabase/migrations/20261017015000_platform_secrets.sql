-- Platform-level credentials (marketplace developer apps, Resend) entered from the staff Marketplaces screen.
-- RLS on with NO policies: only service-role edge functions can read or write. Never selected by the browser.
create table if not exists platform_secrets (
  key text primary key,
  value text not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table platform_secrets enable row level security;
