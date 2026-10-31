-- Every message in a connected Gmail inbox (inbound + sent), so the Email section shows the whole mailbox and the
-- rep decides which threads are leads. lead_id is set automatically when the other party's address is a known lead.
create table if not exists gmail_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  gmail_id text not null,
  thread_id text,
  message_id_hdr text,
  from_email text,
  from_name text,
  to_email text,
  subject text,
  snippet text,
  body text,
  at timestamptz not null,
  is_sent boolean not null default false,
  lead_id uuid references sales_leads(id) on delete set null,
  read_at timestamptz,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, gmail_id)
);
create index if not exists gmail_messages_user_at on gmail_messages (user_id, at desc);
create index if not exists gmail_messages_lead on gmail_messages (lead_id);
alter table gmail_messages enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'gmail_messages' and policyname = 'gmail_messages_own') then
    create policy gmail_messages_own on gmail_messages for all using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'gmail_messages' and policyname = 'gmail_messages_owner') then
    create policy gmail_messages_owner on gmail_messages for select using (is_owner());
  end if;
end $$;
alter table gmail_accounts add column if not exists scopes text;
create or replace view v_gmail_accounts with (security_invoker = false) as
  select user_id, email, connected_at, last_sync_at, last_error, scopes from gmail_accounts;
grant select on v_gmail_accounts to authenticated;
