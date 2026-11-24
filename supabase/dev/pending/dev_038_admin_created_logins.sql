-- dev_038 (shipbay-nexus-dev ONLY): logins may be created by an administrator through Supabase Auth, never by sign-up.
-- Before: only the seed (postgres) could add a login, so the owner could not be given one through Auth.
-- After: the seed, or Supabase Auth's own admin path (dashboard "Add user" / admin API) for a login created ALREADY CONFIRMED.
-- A public sign-up arrives unconfirmed (mailer_autoconfirm is off) and is refused here even if sign-up were ever turned back on;
-- Auth itself also refuses it (disable_signup = true, read 2026-11-24 16:07Z).
-- Applied 2026-11-24 under Derek's limited authorization (item 1: invitation-only / restricted development authentication).
create or replace function public.dev_no_signup()
 returns trigger language plpgsql set search_path to 'public'
as $function$
begin
  if current_user = 'postgres' then return new; end if;
  if current_user = 'supabase_auth_admin' and new.email_confirmed_at is not null then return new; end if;
  raise exception 'Sign-up is closed on the development database. Logins are created by an administrator only.' using errcode = '42501';
end $function$;
