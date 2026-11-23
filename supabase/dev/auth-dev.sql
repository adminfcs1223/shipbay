-- Sign-in for the four synthetic logins. DEVELOPMENT DATABASE ONLY. Never part of supabase/candidates.
-- 1. Gives each synthetic login the email identity row Supabase Auth expects.
-- 2. Adds dev_set_test_password(), which only the database owner can run (the Supabase SQL editor), only for
--    addresses ending in @example.test, and only while the database holds nothing but the synthetic brands.
-- Setting a password (Derek, in the dev project's SQL editor; never in chat, never a password used anywhere else):
--     select public.dev_set_test_password('test-floor@example.test', '<a throwaway password, 12+ characters>');
-- The statement text can appear in the project's query log, which is why it must be a throwaway.
insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id, u.id::text, 'email', jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false), null, now(), now()
from auth.users u where u.email like '%@example.test' and not exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email');

create or replace function public.dev_set_test_password(p_email text, p_password text) returns text language plpgsql security definer set search_path to 'public' as $$
begin
  if exists (select 1 from orgs where id not in ('5a000000-0000-4000-8000-0000000000a1', '5a000000-0000-4000-8000-0000000000a2')) then raise exception 'This is not the synthetic development database. Nothing was changed.'; end if;
  if p_email is null or lower(p_email) not like 'test-%@example.test' then raise exception 'Only the synthetic test logins can be set here.'; end if;
  if length(coalesce(p_password, '')) < 12 then raise exception 'Use at least 12 characters.'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 10)), updated_at = now() where lower(email) = lower(p_email);
  if not found then raise exception 'No such test login.'; end if;
  return 'Password set for ' || lower(p_email) || '.';
end $$;
revoke all on function public.dev_set_test_password(text, text) from public, anon, authenticated, service_role;
