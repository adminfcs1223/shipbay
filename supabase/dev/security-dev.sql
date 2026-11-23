-- Authentication and permission fixes applied to the DEVELOPMENT database on 2026-11-22 (migrations dev_021, dev_022, dev_023).
-- Production has the same three weaknesses and has NOT been changed. See SECURITY-FINDINGS.md.
-- The check that proves them, dev_security_check(), lives in the development database (migration dev_022); run: select public.dev_security_check();

-- 1. A new login's role and brand never come from what the registrant typed (raw_user_meta_data). They come only from
--    raw_app_meta_data, which a user cannot write, and only if the role is a known one. Anything else is a client_user with no brand.
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_role text := new.raw_app_meta_data ->> 'role'; v_org uuid;
begin
  if v_role is null or v_role not in ('client_user', 'client_admin', 'wms_employee', 'shipbay_staff', 'shipbay_admin', 'shipbay_sales', 'shipbay_setter') then v_role := 'client_user'; end if;
  begin v_org := nullif(new.raw_app_meta_data ->> 'org_id', '')::uuid; exception when others then v_org := null; end;
  insert into profiles (id, email, full_name, org_id, role)
  values (new.id, new.email, coalesce(left(new.raw_user_meta_data ->> 'full_name', 120), split_part(new.email, '@', 1)), v_org, v_role)
  on conflict (id) do nothing;
  return new;
end $$;

-- 2. Development only: no login can be created except by the database owner (the seed), whatever the project's sign-up setting says.
create or replace function public.dev_no_signup() returns trigger language plpgsql set search_path to 'public' as $$
begin
  if current_user <> 'postgres' then raise exception 'Sign-up is closed on the development database. Logins are created by the seed only.' using errcode = '42501'; end if;
  return new;
end $$;
drop trigger if exists dev_no_signup on auth.users;
create trigger dev_no_signup before insert on auth.users for each row execute function public.dev_no_signup();
revoke all on function public.dev_no_signup() from anon, authenticated;

-- 3. set_order_cutoff: when the caller cannot see the brand on the order, every value was null and the weekday loop never ended;
--    the insert spun until the statement timeout (3 seconds with the public key alone, 8 with a login). Two added lines.
create or replace function public.set_order_cutoff() returns trigger language plpgsql as $function$
declare
  o orgs%rowtype;
  local_placed timestamp;
  ship_day date;
  dow int;
begin
  select * into o from orgs where id = new.org_id;
  if o.id is null then return new; end if;
  local_placed := (new.received_at at time zone o.timezone);
  ship_day := local_placed::date;
  if ship_day is null then return new; end if;
  if local_placed::time > o.cutoff_time then ship_day := ship_day + 1; end if;
  loop
    dow := extract(isodow from ship_day);
    exit when dow <= 5 or (dow = 6 and o.ships_saturday);
    ship_day := ship_day + 1;
  end loop;
  new.cutoff_at := (ship_day + o.cutoff_time) at time zone o.timezone;
  return new;
end $function$;

-- 4. Brand key functions: a login with no brand has current_org_id() = null, "p_org = null" is neither true nor false, and
--    "if not (p_org = current_org_id() or admin)" did not raise. Such a login could create a connector key for any brand whose id
--    it knew, or read that brand's key list. The comparison is now null-safe. Nothing else changed.
create or replace function public.wms_org_create_key(p_org uuid, p_label text default null::text) returns text language plpgsql security definer set search_path to 'public' as $function$
declare v_key text := 'sbk_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not (coalesce(p_org = current_org_id(), false) or coalesce(_is_shipbay_admin(), false)) then raise exception 'Not your account.'; end if;
  if not exists (select 1 from orgs where id = p_org and client_code is not null) then raise exception 'Your account has no client code yet. Ask ShipBay to set it.'; end if;
  if (select count(*) from wms_api_keys where org_id = p_org and revoked_at is null) >= 5 then raise exception 'There are already 5 active keys. Revoke one first.'; end if;
  insert into wms_api_keys (org_id, label, key_hash, hint, created_by)
  values (p_org, nullif(trim(p_label), ''), encode(extensions.digest(v_key, 'sha256'), 'hex'), right(v_key, 4), auth.uid());
  return v_key;
end $function$;
create or replace function public.wms_org_connector(p_org uuid) returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
begin
  if not (coalesce(p_org = current_org_id(), false) or coalesce(_is_shipbay_staff(), false)) then raise exception 'Not your account.'; end if;
  return jsonb_build_object(
    'client_code', (select client_code from orgs where id = p_org),
    'keys', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'label', k.label, 'hint', k.hint, 'created_at', k.created_at, 'last_used_at', k.last_used_at, 'revoked_at', k.revoked_at) order by k.created_at desc)
                      from wms_api_keys k where k.org_id = p_org and (k.label is distinct from 'Demo reset' or k.revoked_at is null)), '[]'::jsonb));
end $function$;
