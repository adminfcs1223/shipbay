-- ROLLBACK of 20261122_production_security_repair.sql. Puts back production's text as it was on 2026-11-22 and the permission.
-- THIS RE-OPENS ALL FOUR WEAKNESSES. Use it only if the repair itself breaks something, and keep public sign-up OFF while it is in place.
begin;
do $chk$
declare r record;
begin
  for r in select * from (values ('handle_new_user', 'ecc05dbe173362d88da1dc7af485e022'), ('wms_org_create_key', 'b20b5f55afe0f3236f49406b78e4b229'), ('wms_org_connector', 'adbc0800a472551bb1a48b621d10f181'), ('set_order_cutoff', '422df3169deba5891817313d22febd11')) v(name, want) loop
    if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = r.name) is distinct from r.want then
      raise exception 'Before rollback: % is not the expected text (found %). Nothing was changed.', r.name, (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = r.name);
    end if;
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
declare r record;
begin
  for r in select * from (values ('handle_new_user', '07b84cd343cefae1c34fe8c683005875'), ('set_order_cutoff', 'fd0767aa9324307b77115d0aa63c2649'), ('wms_org_connector', '968cf1b355af9da6942453769be455db'), ('wms_org_create_key', 'e5f60e74a5fca184f8c1fe32f0ad0d63')) v(name, want) loop
    if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = r.name) is distinct from r.want then
      raise exception 'After rollback: % is not the expected text (found %). Nothing was changed.', r.name, (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = r.name);
    end if;
  end loop;
end $chk$;
commit;
