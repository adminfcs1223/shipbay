-- ROLLBACK of 20261122_production_security_repair.sql. Puts back production's text, properties and permission as they were on 2026-11-22.
-- THIS RE-OPENS ALL FOUR WEAKNESSES. Use it only if the repair itself breaks something, and keep public sign-up OFF while it is in place.
-- Each function is restored from production's own full definition (security mode, search_path setting, signature), and the closing
-- check proves text and properties are back to what they were.
begin;
do $chk$
declare r record; v_body text; v_props text;
begin
  for r in select * from (values ('handle_new_user', 'ecc05dbe173362d88da1dc7af485e022', 'true|search_path=public|v||trigger|postgres|false,false,true'), ('wms_org_create_key', 'b20b5f55afe0f3236f49406b78e4b229', 'true|search_path=public|v|p_org uuid, p_label text DEFAULT NULL::text|text|postgres|false,true,true'), ('wms_org_connector', 'adbc0800a472551bb1a48b621d10f181', 'true|search_path=public|s|p_org uuid|jsonb|postgres|false,true,true'), ('set_order_cutoff', '422df3169deba5891817313d22febd11', 'false|search_path=public|v||trigger|postgres|false,false,true')) v(name, want_body, want_props) loop
    select md5(p.prosrc), p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|' || p.provolatile::text || '|' || pg_get_function_arguments(p.oid) || '|' || pg_get_function_result(p.oid) || '|' || o.rolname::text || '|' ||
           has_function_privilege('anon', p.oid, 'execute')::text || ',' || has_function_privilege('authenticated', p.oid, 'execute')::text || ',' || has_function_privilege('service_role', p.oid, 'execute')::text
      into v_body, v_props from pg_proc p join pg_roles o on o.oid = p.proowner where p.pronamespace = 'public'::regnamespace and p.proname = r.name;
    if v_body is distinct from r.want_body then raise exception 'Before rollback: the text of % is not what was expected (found %). Nothing was changed.', r.name, v_body; end if;
    -- security mode | settings | volatility | arguments | returns | owner | who may run it (not signed in, signed in, service role)
    if v_props is distinct from r.want_props then raise exception 'Before rollback: the properties of % are not what was expected (found %). Nothing was changed.', r.name, v_props; end if;
  end loop;
end $chk$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into profiles (id, email, full_name, org_id, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
    nullif(new.raw_user_meta_data->>'org_id','')::uuid,
    coalesce(new.raw_user_meta_data->>'role','client_user')
  )
  on conflict (id) do nothing;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.wms_org_create_key(p_org uuid, p_label text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_key text := 'sbk_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not (p_org = current_org_id() or _is_shipbay_admin()) then raise exception 'Not your account.'; end if;
  if not exists (select 1 from orgs where id = p_org and client_code is not null) then raise exception 'Your account has no client code yet. Ask ShipBay to set it.'; end if;
  if (select count(*) from wms_api_keys where org_id = p_org and revoked_at is null) >= 5 then raise exception 'There are already 5 active keys. Revoke one first.'; end if;
  insert into wms_api_keys (org_id, label, key_hash, hint, created_by)
  values (p_org, nullif(trim(p_label), ''), encode(extensions.digest(v_key, 'sha256'), 'hex'), right(v_key, 4), auth.uid());
  return v_key;
end $function$;

CREATE OR REPLACE FUNCTION public.wms_org_connector(p_org uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not (p_org = current_org_id() or _is_shipbay_staff()) then raise exception 'Not your account.'; end if;
  return jsonb_build_object(
    'client_code', (select client_code from orgs where id = p_org),
    'keys', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'label', k.label, 'hint', k.hint, 'created_at', k.created_at, 'last_used_at', k.last_used_at, 'revoked_at', k.revoked_at) order by k.created_at desc)
                      from wms_api_keys k where k.org_id = p_org and (k.label is distinct from 'Demo reset' or k.revoked_at is null)), '[]'::jsonb));
end $function$;

CREATE OR REPLACE FUNCTION public.set_order_cutoff()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  o orgs%rowtype;
  local_placed timestamp;
  ship_day date;
  dow int;
begin
  select * into o from orgs where id = new.org_id;
  local_placed := (new.received_at at time zone o.timezone);
  ship_day := local_placed::date;
  if local_placed::time > o.cutoff_time then ship_day := ship_day + 1; end if;
  loop
    dow := extract(isodow from ship_day);
    exit when dow <= 5 or (dow = 6 and o.ships_saturday);
    ship_day := ship_day + 1;
  end loop;
  new.cutoff_at := (ship_day + o.cutoff_time) at time zone o.timezone;
  return new;
end $function$;

grant insert, update, delete, truncate on table public.orders to anon;

do $chk$
declare r record; v_body text; v_props text;
begin
  for r in select * from (values ('handle_new_user', '07b84cd343cefae1c34fe8c683005875', 'true|search_path=public|v||trigger|postgres|false,false,true'), ('wms_org_create_key', 'e5f60e74a5fca184f8c1fe32f0ad0d63', 'true|search_path=public|v|p_org uuid, p_label text DEFAULT NULL::text|text|postgres|false,true,true'), ('wms_org_connector', '968cf1b355af9da6942453769be455db', 'true|search_path=public|s|p_org uuid|jsonb|postgres|false,true,true'), ('set_order_cutoff', 'fd0767aa9324307b77115d0aa63c2649', 'false|search_path=public|v||trigger|postgres|false,false,true')) v(name, want_body, want_props) loop
    select md5(p.prosrc), p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|' || p.provolatile::text || '|' || pg_get_function_arguments(p.oid) || '|' || pg_get_function_result(p.oid) || '|' || o.rolname::text || '|' ||
           has_function_privilege('anon', p.oid, 'execute')::text || ',' || has_function_privilege('authenticated', p.oid, 'execute')::text || ',' || has_function_privilege('service_role', p.oid, 'execute')::text
      into v_body, v_props from pg_proc p join pg_roles o on o.oid = p.proowner where p.pronamespace = 'public'::regnamespace and p.proname = r.name;
    if v_body is distinct from r.want_body then raise exception 'After rollback: the text of % is not what was expected (found %). Nothing was changed.', r.name, v_body; end if;
    -- security mode | settings | volatility | arguments | returns | owner | who may run it (not signed in, signed in, service role)
    if v_props is distinct from r.want_props then raise exception 'After rollback: the properties of % are not what was expected (found %). Nothing was changed.', r.name, v_props; end if;
  end loop;
end $chk$;
commit;
