-- Put-away and pallet moves through Nexus (the neutral contract). CANDIDATE: not applied anywhere.
-- Additive only: one new table and its functions. It does not change wms_pallets, locations, stock or any existing function;
-- nexus_putaway (the legacy Nexus screen's direct path) is left exactly as it is until cut-over.
--
-- How a put-away runs (the bridge, supabase/functions/nexus-bridge, drives it):
--   1. wms_putaway_begin   signed-in floor staff. Checks ShipBay's own rules (label on file, not void, not held, not already put
--                          away, a real pallet position) and writes one journal row carrying the Idempotency-Key. Changes no pallet.
--   2. the bridge asks Nexus: POST /v1/pallets/assign {pallet: PSKU, to: position} with that key. Nexus decides whether the
--      position is free for this company. ShipBay cannot see or overrule the other company's pallets.
--   3. wms_nexus_op_commit only after Nexus said yes: the pallet is stored at the position and stock posts through the
--                          existing pallet trigger, exactly as today.
--      wms_nexus_op_refuse when Nexus said no: nothing changes on the pallet.
--   A timeout leaves the row 'pending'. Scanning again re-sends the SAME key, so Nexus either replays its first answer or
--   performs it once. A pallet has at most one unfinished request.
begin;
create table if not exists public.wms_nexus_ops (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('assign', 'move')),
  idem_key text not null unique,
  pallet_id uuid not null references public.wms_pallets(id),
  psku text not null,
  from_code text,
  to_code text not null,
  state text not null default 'pending' check (state in ('pending', 'done', 'refused', 'reverted', 'stuck')),
  nexus_http integer, nexus_error text, note text,
  attempts integer not null default 0,
  by_uid uuid, by_name text,
  created_at timestamptz not null default now(), finished_at timestamptz
);
-- one unfinished request per pallet ('stuck' = Nexus holds the position, ShipBay does not, and the undo failed: an admin must look)
create unique index if not exists wms_nexus_ops_one_open on public.wms_nexus_ops (pallet_id) where state in ('pending', 'stuck');
alter table public.wms_nexus_ops enable row level security;   -- no policies: reached only through the functions below

create or replace function public._wms_nexus_begin(p_kind text, p_psku text, p_location text) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare p wms_pallets; l locations; o wms_nexus_ops; v_from text; v_name text;
  v_loc text := upper(regexp_replace(btrim(coalesce(p_location, '')), '^LOC-', '', 'i')); v_psku text := upper(btrim(coalesce(p_psku, '')));
begin
  if not is_wms_staff() then raise exception 'This login cannot put a pallet away.'; end if;
  select * into p from wms_pallets where upper(psku) = v_psku for update;
  if p.id is null then raise exception 'Pallet % is not on file.', coalesce(nullif(v_psku, ''), '(blank)'); end if;
  if p.status = 'void' then raise exception '% was voided.', p.psku; end if;
  if p.held then raise exception '% is on HOLD (%): an admin must release it first.', p.psku, coalesce(p.hold_reason, 'no reason given'); end if;
  select * into l from locations where upper(code) = v_loc and active;
  if l.id is null or l.kind not in ('pallet', 'floor') then raise exception 'Position % is not a pallet position.', coalesce(nullif(v_loc, ''), '(blank)'); end if;
  select * into o from wms_nexus_ops where pallet_id = p.id and state in ('pending', 'stuck');
  if o.id is not null then
    if o.state = 'stuck' then raise exception '% has a request that needs an admin (Nexus and ShipBay disagree about %).', p.psku, o.to_code; end if;
    if o.kind = p_kind and o.to_code = l.code then return jsonb_build_object('op', o.id, 'key', o.idem_key, 'kind', o.kind, 'pallet', o.psku, 'to', o.to_code, 'from', o.from_code, 'resumed', true); end if;
    raise exception '% already has a request to % that Nexus has not answered. Scan % again to finish it.', p.psku, o.to_code, o.to_code;
  end if;
  if p_kind = 'assign' then
    if p.status = 'stored' then raise exception '% is already put away.', p.psku; end if;
  else
    if p.status <> 'stored' or p.location_id is null then raise exception '% is not put away yet.', p.psku; end if;
    select code into v_from from locations where id = p.location_id;
    if v_from = l.code then raise exception '% is already at %.', p.psku, l.code; end if;
  end if;
  -- ShipBay's own records only: another ShipBay-run pallet already stored there. Whether the other company stands there is Nexus's answer, not ours.
  if l.kind = 'pallet' and exists (select 1 from wms_pallets x join orgs g on g.id = x.org_id where x.location_id = l.id and x.status = 'stored' and x.id <> p.id and not coalesce(g.external_wms, false))
    then raise exception 'Position % already holds a ShipBay pallet.', l.code; end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  insert into wms_nexus_ops (kind, idem_key, pallet_id, psku, from_code, to_code, by_uid, by_name)
  values (p_kind, 'SB-' || upper(p_kind) || '-' || gen_random_uuid()::text, p.id, p.psku, v_from, l.code, auth.uid(), v_name) returning * into o;
  return jsonb_build_object('op', o.id, 'key', o.idem_key, 'kind', o.kind, 'pallet', o.psku, 'to', o.to_code, 'from', o.from_code, 'resumed', false);
end $$;
create or replace function public.wms_putaway_begin(p_psku text, p_location text) returns jsonb language sql security definer set search_path to 'public' as $$ select _wms_nexus_begin('assign', p_psku, p_location) $$;
create or replace function public.wms_move_begin(p_psku text, p_location text) returns jsonb language sql security definer set search_path to 'public' as $$ select _wms_nexus_begin('move', p_psku, p_location) $$;

-- Nexus accepted: record it in ShipBay. Bridge only. Safe to call twice.
create or replace function public.wms_nexus_op_commit(p_op uuid) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare o wms_nexus_ops; p wms_pallets; l locations;
begin
  select * into o from wms_nexus_ops where id = p_op for update;
  if o.id is null then raise exception 'Request not found.'; end if;
  select * into p from wms_pallets where id = o.pallet_id for update;
  select * into l from locations where upper(code) = upper(o.to_code) and active;
  if o.state <> 'done' then
    if o.state <> 'pending' then raise exception 'This request is closed (%).', o.state; end if;
    if l.id is null then raise exception 'Position % is no longer active.', o.to_code; end if;
    if p.status = 'void' then raise exception '% was voided.', p.psku; end if;
    if o.kind = 'assign' then
      if p.status = 'stored' then raise exception '% is already put away.', p.psku; end if;
      update wms_pallets set location_id = l.id, status = 'stored', stored_at = now(), stored_by_name = o.by_name,
        counted_at = coalesce(counted_at, now()), counted_by_name = coalesce(counted_by_name, o.by_name) where id = p.id;
    else
      if p.status <> 'stored' then raise exception '% is not put away.', p.psku; end if;
      update wms_pallets set location_id = l.id where id = p.id;
    end if;
    update wms_nexus_ops set state = 'done', nexus_http = 200, nexus_error = null, attempts = attempts + 1, finished_at = now() where id = o.id;
  end if;
  return jsonb_build_object('op', o.id, 'kind', o.kind, 'psku', o.psku, 'location', l.code, 'from', o.from_code,
    'units_posted', (select coalesce(sum(qty), 0) from inventory_moves where ref_type = 'wms_pallet' and ref_id = o.pallet_id));
end $$;

-- Nexus did not accept, or could not be reached. Bridge only. p_state: 'pending' (try again with the same key), 'refused', 'reverted', 'stuck'.
create or replace function public.wms_nexus_op_note(p_op uuid, p_state text, p_http integer, p_error text, p_note text default null) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if p_state not in ('pending', 'refused', 'reverted', 'stuck') then raise exception 'Unknown state.'; end if;
  update wms_nexus_ops set state = p_state, nexus_http = p_http, nexus_error = left(p_error, 80), note = left(p_note, 300), attempts = attempts + 1,
    finished_at = case when p_state in ('refused', 'reverted') then now() end where id = p_op and state in ('pending', 'stuck');
end $$;

-- Requests Nexus has not answered, or that need an admin. The station shows them; the bridge re-sends them.
create or replace function public.wms_nexus_ops_open() returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('op', o.id, 'key', o.idem_key, 'kind', o.kind, 'pallet', o.psku, 'to', o.to_code, 'from', o.from_code, 'state', o.state,
    'attempts', o.attempts, 'by', o.by_name, 'at', o.created_at, 'error', o.nexus_error) order by o.created_at), '[]')
  from wms_nexus_ops o where o.state in ('pending', 'stuck') and is_wms_staff();
$$;
-- the same list for the bridge's own retry run (no signed-in user); granted to the bridge only
create or replace function public.wms_nexus_ops_pending() returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('op', o.id, 'key', o.idem_key, 'kind', o.kind, 'pallet', o.psku, 'to', o.to_code, 'from', o.from_code, 'state', o.state) order by o.created_at), '[]')
  from wms_nexus_ops o where o.state = 'pending';
$$;

revoke all on function public._wms_nexus_begin(text, text, text), public.wms_putaway_begin(text, text), public.wms_move_begin(text, text), public.wms_nexus_op_commit(uuid),
  public.wms_nexus_op_note(uuid, text, integer, text, text), public.wms_nexus_ops_open(), public.wms_nexus_ops_pending() from public, anon, authenticated, service_role;
grant execute on function public.wms_putaway_begin(text, text), public.wms_move_begin(text, text), public.wms_nexus_ops_open() to authenticated;
grant execute on function public.wms_nexus_op_commit(uuid), public.wms_nexus_op_note(uuid, text, integer, text, text), public.wms_nexus_ops_pending() to service_role;
commit;
