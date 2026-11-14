-- 2026-11-14 (Derek): live camera feeds in the admin portal. No cameras are installed yet, so this is the list the
-- admin page reads: a name and the https page that plays the feed (the relay's player page), shown as a tile.
-- Admins only. Connector-safe form: additive, guarded policy.
create table if not exists cameras (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  embed_url text not null check (embed_url ~* '^https://'),
  sort int not null default 0,
  active boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
alter table cameras enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'cameras' and policyname = 'admin_all_cameras') then
    create policy admin_all_cameras on cameras for all
      using (exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'shipbay_admin' and p.active is not false))
      with check (exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'shipbay_admin' and p.active is not false));
  end if;
end $$;
