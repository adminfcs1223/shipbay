#!/bin/bash
# Local reproduction of the dev login failure and test of dev_039. Local cluster only (shipbay-local-staging).
set -u; cd /home/claude/wms-cal
P="/usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -p 54317 -U postgres -d staging -v ON_ERROR_STOP=1 -q -At"
[ "$($P -c "select current_setting('cluster_name')")" = shipbay-local-staging ] || { echo REFUSED; exit 1; }
# as on dev: Supabase Auth's own role, owning auth.users, and the dev trigger as security-dev.sql installs it
$P <<'SQL'
do $$ begin if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin; end if; end $$;
grant usage on schema auth to supabase_auth_admin; alter table auth.users owner to supabase_auth_admin;
-- the local shim has only some of Auth's columns: add the ones Auth writes (local only)
alter table auth.users add column if not exists aud text, add column if not exists role text, add column if not exists encrypted_password text,
  add column if not exists email_confirmed_at timestamptz, add column if not exists invited_at timestamptz, add column if not exists confirmation_sent_at timestamptz,
  add column if not exists last_sign_in_at timestamptz, add column if not exists raw_app_meta_data jsonb, add column if not exists raw_user_meta_data jsonb,
  add column if not exists created_at timestamptz, add column if not exists updated_at timestamptz;
create or replace function public.dev_no_signup() returns trigger language plpgsql set search_path to 'public' as $f$
begin
  if current_user <> 'postgres' then raise exception 'Sign-up is closed on the development database. Logins are created by the seed only.' using errcode = '42501'; end if;
  return new;
end $f$;
drop trigger if exists dev_no_signup on auth.users;
create trigger dev_no_signup before insert on auth.users for each row execute function public.dev_no_signup();
SQL
before=$($P -c "select md5(string_agg(u.id || coalesce(u.email,'') || coalesce(u.encrypted_password,'') || coalesce(p.role,'') || coalesce(p.org_id::text,''), '|' order by u.id)) from auth.users u left join profiles p on p.id = u.id")
# what Supabase Auth does for "Create new user": insert, then (Auto Confirm) a second write, one transaction
admin_create() { $P -c "begin; set local role supabase_auth_admin; insert into auth.users (id, email, aud, role, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values ('$1', '$2', 'authenticated', 'authenticated', 'bcrypt-hash-placeholder', '{\"provider\":\"email\",\"providers\":[\"email\"]}', '{}', now(), now()); $3 commit;" 2>&1 | grep -o "ERROR: .*" | head -1; }
ok() { $P -c "select count(*) from auth.users where id = '$1'"; }
echo "--- dev_038 as applied (reproduction)"; $P -f supabase/dev/pending/dev_038_admin_created_logins.sql
echo "admin create + Auto Confirm: $(admin_create 6c000000-0000-4000-8000-000000000001 owner@example.test "update auth.users set email_confirmed_at = now() where id = '6c000000-0000-4000-8000-000000000001';") rows=$(ok 6c000000-0000-4000-8000-000000000001)"
echo "--- dev_039"; $P -f supabase/dev/pending/dev_039_admin_created_logins_fix.sql
echo "A admin create + Auto Confirm: $(admin_create 6c000000-0000-4000-8000-000000000001 owner@example.test "update auth.users set email_confirmed_at = now() where id = '6c000000-0000-4000-8000-000000000001';") rows=$(ok 6c000000-0000-4000-8000-000000000001) profile=$($P -c "select role || ' org=' || coalesce(org_id::text,'none') from profiles where id = '6c000000-0000-4000-8000-000000000001'")"
echo "B admin create, Auto Confirm OFF: $(admin_create 6c000000-0000-4000-8000-000000000002 b@example.test "") rows=$(ok 6c000000-0000-4000-8000-000000000002) profiles=$($P -c "select count(*) from profiles where id = '6c000000-0000-4000-8000-000000000002'")"
echo "C public sign-up shape (unconfirmed, not invited): $(admin_create 6c000000-0000-4000-8000-000000000003 c@example.test "update auth.users set confirmation_sent_at = now() where id = '6c000000-0000-4000-8000-000000000003';") rows=$(ok 6c000000-0000-4000-8000-000000000003)"
echo "D invite (insert, then invited_at): $(admin_create 6c000000-0000-4000-8000-000000000004 d@example.test "update auth.users set invited_at = now() where id = '6c000000-0000-4000-8000-000000000004';") rows=$(ok 6c000000-0000-4000-8000-000000000004)"
$P -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = 'some_other_role') then create role some_other_role; end if; end \$\$; grant usage on schema auth to some_other_role; grant insert, select on auth.users to some_other_role;"
for r in authenticated anon service_role some_other_role; do echo "E insert as $r: $($P -c "begin; set local role $r; insert into auth.users (id, email) values ('6c000000-0000-4000-8000-00000000000e', 'e@example.test'); commit;" 2>&1 | grep -o "ERROR: .*" | head -1)"; done
echo "F seed (postgres) insert: $($P -c "begin; insert into auth.users (id, email, aud, role, raw_app_meta_data, created_at, updated_at) values ('6c000000-0000-4000-8000-00000000000f', 'f@example.test', 'authenticated', 'authenticated', '{}', now(), now()); commit;" 2>&1 | grep -o "ERROR: .*" | head -1) rows=$(ok 6c000000-0000-4000-8000-00000000000f)"
echo "G a confirmed user is later updated by Auth (sign-in, password change): $($P -c "begin; set local role supabase_auth_admin; update auth.users set last_sign_in_at = now(), encrypted_password = 'x2' where id = '6c000000-0000-4000-8000-000000000001'; commit;" 2>&1 | grep -o "ERROR: .*" | head -1)"
echo "H new login sees nothing until its role is set: $($P -c "begin; set local role authenticated; select set_config('request.jwt.claims', '{\"sub\":\"6c000000-0000-4000-8000-000000000001\",\"role\":\"authenticated\"}', true); select 'orders ' || (select count(*) from orders) || ', skus ' || (select count(*) from skus) || ', pallets ' || (select count(*) from wms_pallets) || ', orgs ' || (select count(*) from orgs); commit;" | tail -1)"
$P -c "delete from auth.users where id::text like '6c000000-%'"
after=$($P -c "select md5(string_agg(u.id || coalesce(u.email,'') || coalesce(u.encrypted_password,'') || coalesce(p.role,'') || coalesce(p.org_id::text,''), '|' order by u.id)) from auth.users u left join profiles p on p.id = u.id")
echo "I existing logins and profiles unchanged: $([ "$before" = "$after" ] && echo yes || echo NO)"
