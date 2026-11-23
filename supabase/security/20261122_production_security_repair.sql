-- PRODUCTION SECURITY REPAIR. Prepared 2026-11-22. NOT APPLIED. Needs Derek's approval before it runs on poxlczzkpztmoiixyrth.
-- Four functions and one permission. No table is altered, no row is read or written, no login is changed.
--   1. handle_new_user      a new login's role and brand never come from what the registrant typed. Without a role set by the
--                           service role in app data, a new login is a client_user with no brand: it can see and do nothing.
--                           Admin -> Users, WMS employees and client portal access all write the profile themselves, with the
--                           service role, straight after creating the login, so they keep working unchanged.
--   2. wms_org_create_key   a login with no brand could create a connector key for any brand. Null-safe comparison.
--   3. wms_org_connector    the same flaw, for reading a brand's key list.
--   4. set_order_cutoff     an order naming a brand the caller cannot see looped until the statement timeout. Two guard lines.
--   5. orders               the public (not signed in) role loses insert, update, delete and truncate. No policy ever let it
--                           write a row, so nothing that works today stops working.
-- It first checks that the four functions are exactly the text this repair was written against, and stops if not.
-- It runs in one transaction: either all of it applies or none of it.
begin;
do $chk$
declare r record;
begin
  for r in select * from (values ('handle_new_user', '07b84cd343cefae1c34fe8c683005875'), ('set_order_cutoff', 'fd0767aa9324307b77115d0aa63c2649'), ('wms_org_connector', '968cf1b355af9da6942453769be455db'), ('wms_org_create_key', 'e5f60e74a5fca184f8c1fe32f0ad0d63')) v(name, want) loop
    if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = r.name) is distinct from r.want then
      raise exception 'Before: % is not the expected text (found %). Nothing was changed.', r.name, (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = r.name);
    end if;
  end loop;
end $chk$;

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

revoke insert, update, delete, truncate on table public.orders from anon;

do $chk$
declare r record;
begin
  for r in select * from (values ('handle_new_user', 'ecc05dbe173362d88da1dc7af485e022'), ('wms_org_create_key', 'b20b5f55afe0f3236f49406b78e4b229'), ('wms_org_connector', 'adbc0800a472551bb1a48b621d10f181'), ('set_order_cutoff', '422df3169deba5891817313d22febd11')) v(name, want) loop
    if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = r.name) is distinct from r.want then
      raise exception 'After: % is not the expected text (found %). Nothing was changed.', r.name, (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = r.name);
    end if;
  end loop;
end $chk$;
commit;
