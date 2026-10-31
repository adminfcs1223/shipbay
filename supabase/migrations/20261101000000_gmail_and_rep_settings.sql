-- per-salesperson settings: the reply template used by "Reply in Gmail" / "Compose email"
create table if not exists sales_rep_settings (
  user_id uuid primary key references profiles(id) on delete cascade,
  reply_subject text,
  reply_body text,
  signature text,
  updated_at timestamptz not null default now()
);
alter table sales_rep_settings enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'sales_rep_settings' and policyname = 'sales_rep_settings_own') then
    create policy sales_rep_settings_own on sales_rep_settings for all using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'sales_rep_settings' and policyname = 'sales_rep_settings_owner') then
    create policy sales_rep_settings_owner on sales_rep_settings for select using (is_owner());
  end if;
end $$;
-- Gmail connections, one per staff user; tokens are service-role only (no policies)
create table if not exists gmail_accounts (
  user_id uuid primary key references profiles(id) on delete cascade,
  email text,
  access_token text not null,
  refresh_token text,
  expires_at timestamptz not null,
  history_id text,
  last_sync_at timestamptz,
  last_error text,
  connected_at timestamptz not null default now()
);
alter table gmail_accounts enable row level security;
create or replace view v_gmail_accounts with (security_invoker = false) as
  select user_id, email, connected_at, last_sync_at, last_error from gmail_accounts;
grant select on v_gmail_accounts to authenticated;
alter table sales_email_sends add column if not exists mailbox text;
-- GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET live in platform_secrets (set out of band)
update fin_settings set value = jsonb_set(value, '{bonus,hit_message}', '"SO STRONG"'::jsonb) where key = 'sales_goals' and not ((value->'bonus') ? 'hit_message');
