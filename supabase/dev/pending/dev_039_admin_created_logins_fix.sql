-- dev_039 (shipbay-nexus-dev ONLY; NOT APPLIED; for Derek's approval). Replaces dev_038, which is applied and refuses every login.
--
-- Root cause of "Database error trying to create account" (auth logs 2026-11-24 16:29:43-16:30:26Z, POST /admin/users, 500):
-- dev_038 required email_confirmed_at to be set ON THE INSERT. Supabase Auth's admin create inserts the user first and confirms it
-- with a second write in the same transaction (internal/api/admin.go: tx.Create(user), then user.Confirm(tx)), so at the insert the
-- field is always empty and the trigger raised "Sign-up is closed..." (Postgres log: user supabase_auth_admin, dev_no_signup line 5).
--
-- The fix keeps sign-up closed and checks at the END of the transaction instead:
--   1. dev_no_signup (before insert, unchanged trigger): the seed (postgres) and Supabase Auth itself (supabase_auth_admin) may
--      insert; any other role is refused, as before.
--   2. dev_admin_created_only (new, after insert, deferred to commit): a login added by Supabase Auth must be CONFIRMED (admin
--      "Create new user" with Auto Confirm) or INVITED by the time its transaction commits; otherwise the whole transaction is
--      undone. A public sign-up arrives unconfirmed (mailer_autoconfirm is off) and is refused here even if sign-up were turned on;
--      Auth refuses it first anyway (disable_signup = true).
-- Nothing else changes: existing logins, profiles, handle_new_user, profiles_guard and row security are untouched. A new login
-- gets the default profile (client_user, no brand: it sees nothing) until its role is set.
create or replace function public.dev_no_signup()
 returns trigger language plpgsql set search_path to 'public'
as $function$
begin
  if current_user in ('postgres', 'supabase_auth_admin') then return new; end if;
  raise exception 'Sign-up is closed on the development database. Logins are created by an administrator only.' using errcode = '42501';
end $function$;

create or replace function public.dev_admin_created_only()
 returns trigger language plpgsql set search_path to 'public'
as $function$
declare v_confirmed timestamptz; v_invited timestamptz;
begin
  if current_user = 'postgres' then return null; end if;
  select email_confirmed_at, invited_at into v_confirmed, v_invited from auth.users where id = new.id;
  if not found then return null; end if;   -- removed again in the same transaction
  if v_confirmed is null and v_invited is null then
    raise exception 'Sign-up is closed on the development database. Create the login under Authentication -> Users with Auto Confirm on.' using errcode = '42501';
  end if;
  return null;
end $function$;
revoke all on function public.dev_admin_created_only() from public, anon, authenticated;
grant execute on function public.dev_admin_created_only() to supabase_auth_admin;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'dev_admin_created_only') then
    create constraint trigger dev_admin_created_only after insert on auth.users
      deferrable initially deferred for each row execute function public.dev_admin_created_only();
  end if;
end $$;
select tgname, tgenabled, tgdeferrable, tginitdeferred from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal order by tgname;
