-- Rollback of dev_039 / dev_038 on shipbay-nexus-dev: back to the original seed-only rule (security-dev.sql part 2).
-- Step 1 alone restores the original strictness (every insert not made by the seed is refused before it happens).
create or replace function public.dev_no_signup()
 returns trigger language plpgsql set search_path to 'public'
as $function$
begin
  if current_user <> 'postgres' then raise exception 'Sign-up is closed on the development database. Logins are created by the seed only.' using errcode = '42501'; end if;
  return new;
end $function$;
-- Step 2 (SQL editor): remove the added commit-time check.
drop trigger if exists dev_admin_created_only on auth.users;
drop function if exists public.dev_admin_created_only();
