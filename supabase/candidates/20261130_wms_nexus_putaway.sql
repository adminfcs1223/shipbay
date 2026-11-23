-- Put-away, moves and releases through Nexus (the neutral contract). CANDIDATE: not applied anywhere.
-- Additive only: one new table and its functions. It does not change wms_pallets, locations, stock or any existing function;
-- nexus_putaway (the legacy Nexus screen's direct path) is left exactly as it is until cut-over.
--
-- Nexus is the authority for who stands in a shared position. ShipBay keeps a journal (wms_nexus_ops) of every request it
-- made, and that journal, not any older pallet row, is ShipBay's side of a reconciliation.
--
-- A request runs in three steps, driven by the bridge (supabase/functions/nexus-bridge):
--   1. begin    signed-in staff. ShipBay's own rules, then one journal row carrying the Idempotency-Key. Changes no pallet.
--   2. Nexus    POST /v1/pallets/assign | move | release with that key. Nexus decides.
--   3. commit   only after Nexus said yes.
--        assign   the pallet is stored at the position; stock posts through the existing pallet trigger, as today.
--        move     the pallet's position changes. Its stock follows as a 'transfer' pair that nets to zero; nothing is received again.
--        release  the journal records it. The pallet row and its stock are NOT touched: what a departed pallet's stock
--                 becomes is an inventory decision, not a consequence of freeing a floor position.
-- No answer from Nexus: the row stays 'pending'; sending again uses the SAME key.
-- Nexus said yes and ShipBay could not record it: the row becomes 'out_of_sync'. The position STAYS RESERVED in Nexus.
--   Nothing releases it automatically. An admin, standing at the position, either records it (the pallet is there) or
--   starts a verified corrective request (the pallet is not there), which is itself a journal row with its own key.
-- A position is never released because a pallet was voided, its quantity reached zero, or a shipment changed status.
begin;
create table if not exists public.wms_nexus_ops (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('assign', 'move', 'release')),
  idem_key text not null unique,
  pallet_id uuid not null references public.wms_pallets(id),
  psku text not null,
  from_code text,
  to_code text,
  state text not null default 'pending' check (state in ('pending', 'done', 'refused', 'out_of_sync', 'undone')),
  reason text,                                  -- release: why the pallet left
  confirmed_at_position boolean not null default false,   -- release / correction: the person stated they were at the position and saw it
  fixes uuid references public.wms_nexus_ops(id),          -- a corrective request names the out-of-sync request it corrects
  nexus_http integer, nexus_error text, problem text,
  attempts integer not null default 0,
  by_uid uuid, by_name text, created_at timestamptz not null default now(), finished_at timestamptz,
  resolved_by_name text, resolved_at timestamptz, resolution text,
  check (kind = 'release' or to_code is not null), check (kind = 'assign' or from_code is not null)
);
-- one unfinished request per pallet, and one unfinished correction per out-of-sync request
create unique index if not exists wms_nexus_ops_one_open on public.wms_nexus_ops (pallet_id) where state in ('pending', 'out_of_sync') and fixes is null;
create unique index if not exists wms_nexus_ops_one_fix on public.wms_nexus_ops (fixes) where state = 'pending';
create index if not exists wms_nexus_ops_pallet on public.wms_nexus_ops (pallet_id, created_at);
alter table public.wms_nexus_ops enable row level security;   -- no policies: reached only through the functions below

create or replace function public.wms_nexus_admin() returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from profiles where id = auth.uid() and active is not false and role in ('shipbay_admin', 'shipbay_staff'));
$$;
create or replace function public._wms_nexus_desc(o public.wms_nexus_ops, p_resumed boolean) returns jsonb language sql immutable as $$
  select jsonb_build_object('op', o.id, 'key', o.idem_key, 'kind', o.kind, 'pallet', o.psku, 'to', o.to_code, 'from', o.from_code, 'fixes', o.fixes, 'resumed', p_resumed);
$$;

create or replace function public._wms_nexus_begin(p_kind text, p_psku text, p_location text, p_reason text default null, p_confirmed boolean default false) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p wms_pallets; l locations; o wms_nexus_ops; v_here text; v_name text;
  v_loc text := upper(regexp_replace(btrim(coalesce(p_location, '')), '^LOC-', '', 'i')); v_psku text := upper(btrim(coalesce(p_psku, '')));
begin
  if not is_wms_staff() then raise exception 'This login cannot place or release pallets.'; end if;
  select * into p from wms_pallets where upper(psku) = v_psku for update;
  if p.id is null then raise exception 'Pallet % is not on file.', coalesce(nullif(v_psku, ''), '(blank)'); end if;
  select * into l from locations where upper(code) = v_loc and active;
  if l.id is null or l.kind not in ('pallet', 'floor') then raise exception 'Position % is not a pallet position.', coalesce(nullif(v_loc, ''), '(blank)'); end if;
  select code into v_here from locations where id = p.location_id;
  select * into o from wms_nexus_ops where pallet_id = p.id and state in ('pending', 'out_of_sync') and fixes is null;
  if o.id is not null then
    if o.state = 'out_of_sync' then raise exception '% needs an admin: Nexus accepted % but ShipBay did not record it. Leave the pallet where it is.', p.psku, coalesce(o.to_code, o.from_code); end if;
    if o.kind = p_kind and coalesce(o.to_code, o.from_code) = l.code then return _wms_nexus_desc(o, true); end if;
    raise exception '% already has a request for % that Nexus has not answered. Finish that one first.', p.psku, coalesce(o.to_code, o.from_code);
  end if;
  if p_kind = 'release' then
    -- leaving the floor: allowed for any pallet, voided and held ones included, because the pallet is physically gone either way
    if p_confirmed is not true then raise exception 'Confirm at the position that % is no longer standing in %.', p.psku, l.code; end if;
    if coalesce(p_reason, '') not in ('shipped_out', 'emptied_and_removed', 'moved_off_shared_floor', 'correction') then raise exception 'Say why the pallet left.'; end if;
    if v_here is not null and v_here <> l.code then raise exception 'ShipBay has % at %, not %. Reconcile before releasing.', p.psku, v_here, l.code; end if;
  else
    if p.status = 'void' then raise exception '% was voided.', p.psku; end if;
    if p.held then raise exception '% is on HOLD (%): an admin must release it first.', p.psku, coalesce(p.hold_reason, 'no reason given'); end if;
    if p_kind = 'assign' then
      if p.status = 'stored' then raise exception '% is already put away.', p.psku; end if;
    else
      if p.status <> 'stored' or v_here is null then raise exception '% is not put away yet.', p.psku; end if;
      if v_here = l.code then raise exception '% is already at %.', p.psku, l.code; end if;
    end if;
  end if;
  -- no local "is the position free" check: that is Nexus's answer, for both companies
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  insert into wms_nexus_ops (kind, idem_key, pallet_id, psku, from_code, to_code, reason, confirmed_at_position, by_uid, by_name)
  values (p_kind, 'SB-' || upper(p_kind) || '-' || gen_random_uuid()::text, p.id, p.psku, case p_kind when 'move' then v_here when 'release' then l.code end,
    case when p_kind <> 'release' then l.code end, case when p_kind = 'release' then p_reason end, p_kind = 'release', auth.uid(), v_name) returning * into o;
  return _wms_nexus_desc(o, false);
end $$;
create or replace function public.wms_putaway_begin(p_psku text, p_location text) returns jsonb language sql security definer set search_path to 'public' as $$ select _wms_nexus_begin('assign', p_psku, p_location) $$;
create or replace function public.wms_move_begin(p_psku text, p_location text) returns jsonb language sql security definer set search_path to 'public' as $$ select _wms_nexus_begin('move', p_psku, p_location) $$;
create or replace function public.wms_release_begin(p_psku text, p_location text, p_reason text, p_confirmed boolean) returns jsonb language sql security definer set search_path to 'public' as $$ select _wms_nexus_begin('release', p_psku, p_location, p_reason, p_confirmed) $$;

-- What Nexus accepted, written into ShipBay. Internal: raises when ShipBay's own rules forbid it (the caller decides what that means).
create or replace function public._wms_nexus_apply(o public.wms_nexus_ops) returns void language plpgsql security definer set search_path to 'public' as $$
declare p wms_pallets; l locations;
begin
  if o.kind = 'release' then return; end if;   -- the journal row is the record; the pallet row and its stock are not touched
  select * into p from wms_pallets where id = o.pallet_id for update;
  select * into l from locations where upper(code) = upper(o.to_code) and active;
  if l.id is null then raise exception 'Position % is no longer active in ShipBay.', o.to_code; end if;
  if p.status = 'void' then raise exception '% was voided.', p.psku; end if;
  if o.kind = 'assign' then
    if p.status = 'stored' then raise exception '% is already put away.', p.psku; end if;
    update wms_pallets set location_id = l.id, status = 'stored', stored_at = now(), stored_by_name = o.by_name,
      counted_at = coalesce(counted_at, now()), counted_by_name = coalesce(counted_by_name, o.by_name) where id = p.id;
  else
    if p.status <> 'stored' then raise exception '% is not put away.', p.psku; end if;
    -- The stock this pallet posted follows it as a transfer pair (minus at the old position, plus at the new), written here first.
    -- Left to the existing pallet trigger alone, the new position would be booked as a fresh 'receive'; with the pair already
    -- in the ledger the trigger finds nothing to post. On-hand quantity is unchanged and nothing is received twice.
    if p.location_id is not null and p.location_id <> l.id then
      insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, created_by, location_id)
      select p.org_id, m.sku_id, v.sign * m.qty, 'transfer', 'wms_pallet', p.id, p.psku || ' moved ' || o.from_code || ' to ' || l.code, o.by_uid, case v.sign when -1 then p.location_id else l.id end
      from (select sku_id, sum(qty)::int as qty from inventory_moves where ref_type = 'wms_pallet' and ref_id = p.id and location_id = p.location_id group by 1 having sum(qty) <> 0) m,
           (values (-1), (1)) v(sign);
    end if;
    update wms_pallets set location_id = l.id where id = p.id;
  end if;
end $$;
create or replace function public._wms_nexus_result(p_op uuid) returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('op', o.id, 'kind', o.kind, 'psku', o.psku, 'location', o.to_code, 'from', o.from_code, 'state', o.state, 'fixes', o.fixes,
    'units_posted', (select coalesce(sum(qty), 0) from inventory_moves where ref_type = 'wms_pallet' and ref_id = o.pallet_id)) from wms_nexus_ops o where o.id = p_op;
$$;

-- Nexus accepted: record it. Bridge only. Safe to call twice. A corrective request also closes the request it corrects.
create or replace function public.wms_nexus_op_commit(p_op uuid) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare o wms_nexus_ops;
begin
  select * into o from wms_nexus_ops where id = p_op for update;
  if o.id is null then raise exception 'Request not found.'; end if;
  if o.state <> 'done' then
    if o.state <> 'pending' then raise exception 'This request is closed (%).', o.state; end if;
    if o.fixes is null then perform _wms_nexus_apply(o); end if;   -- a correction returns Nexus to what ShipBay already holds: nothing to write on the pallet
    update wms_nexus_ops set state = 'done', nexus_http = 200, nexus_error = null, attempts = attempts + 1, finished_at = now() where id = o.id;
    if o.fixes is not null then
      update wms_nexus_ops set state = 'undone', finished_at = now(), resolved_at = now(), resolved_by_name = o.by_name,
        resolution = 'corrected in Nexus by request ' || o.id::text || ' after confirmation at the position' where id = o.fixes and state = 'out_of_sync';
    end if;
  end if;
  return _wms_nexus_result(p_op);
end $$;

-- Nexus did not accept, could not be reached, or accepted something ShipBay then could not record. Bridge only.
create or replace function public.wms_nexus_op_note(p_op uuid, p_state text, p_http integer, p_error text, p_problem text default null) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if p_state not in ('pending', 'refused', 'out_of_sync') then raise exception 'Unknown state.'; end if;
  update wms_nexus_ops set state = p_state, nexus_http = p_http, nexus_error = left(p_error, 80), problem = coalesce(left(p_problem, 300), problem), attempts = attempts + 1,
    finished_at = case when p_state = 'refused' then now() end where id = p_op and state = 'pending';
end $$;

-- Out of sync, the pallet IS at the position: an admin confirms it there and ShipBay records what Nexus already holds.
create or replace function public.wms_nexus_resolve_record(p_op uuid, p_confirmed boolean) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare o wms_nexus_ops; v_name text;
begin
  if not wms_nexus_admin() then raise exception 'Only ShipBay admin or staff can resolve this.'; end if;
  if p_confirmed is not true then raise exception 'Confirm at the position that the pallet is standing there.'; end if;
  select * into o from wms_nexus_ops where id = p_op for update;
  if o.id is null or o.state <> 'out_of_sync' then raise exception 'This request is not waiting for a decision.'; end if;
  if exists (select 1 from wms_nexus_ops where fixes = o.id and state = 'pending') then raise exception 'A correction for this request is already on its way to Nexus.'; end if;
  perform _wms_nexus_apply(o);   -- raises with ShipBay's own reason (still on hold, voided...) and changes nothing
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  update wms_nexus_ops set state = 'done', finished_at = now(), resolved_at = now(), resolved_by_name = v_name, confirmed_at_position = true, resolution = 'recorded after confirmation at the position' where id = o.id;
  return _wms_nexus_result(p_op);
end $$;

-- Out of sync, the pallet is NOT at the position: an admin confirms that there and a corrective request is opened
-- (a release for a put-away, a move back for a move). The bridge sends it; only Nexus's yes closes the original.
create or replace function public.wms_nexus_fix_begin(p_op uuid, p_confirmed boolean) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare o wms_nexus_ops; f wms_nexus_ops; v_name text;
begin
  if not wms_nexus_admin() then raise exception 'Only ShipBay admin or staff can resolve this.'; end if;
  if p_confirmed is not true then raise exception 'Confirm at the position that the pallet is not standing there.'; end if;
  select * into o from wms_nexus_ops where id = p_op for update;
  if o.id is null or o.state <> 'out_of_sync' or o.kind = 'release' then raise exception 'This request is not waiting for a correction.'; end if;
  select * into f from wms_nexus_ops where fixes = o.id and state = 'pending';
  if f.id is not null then return _wms_nexus_desc(f, true); end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  insert into wms_nexus_ops (kind, idem_key, pallet_id, psku, from_code, to_code, reason, confirmed_at_position, fixes, by_uid, by_name)
  values (case o.kind when 'assign' then 'release' else 'move' end, 'SB-FIX-' || gen_random_uuid()::text, o.pallet_id, o.psku, o.to_code, case when o.kind = 'move' then o.from_code end,
    'correction', true, o.id, auth.uid(), v_name) returning * into f;
  return _wms_nexus_desc(f, false);
end $$;

-- Unfinished requests: for the station (staff) and for the bridge's own retry run.
create or replace function public.wms_nexus_ops_open() returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('op', o.id, 'kind', o.kind, 'pallet', o.psku, 'to', o.to_code, 'from', o.from_code, 'state', o.state, 'fixes', o.fixes,
    'attempts', o.attempts, 'by', o.by_name, 'at', o.created_at, 'problem', o.problem) order by o.created_at), '[]')
  from wms_nexus_ops o where o.state in ('pending', 'out_of_sync') and is_wms_staff();
$$;
create or replace function public.wms_nexus_ops_pending() returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(_wms_nexus_desc(o, true) order by o.created_at), '[]') from wms_nexus_ops o where o.state = 'pending';
$$;

-- ShipBay's side of a reconciliation: where the journal says each pallet stands (its latest request Nexus accepted and
-- ShipBay recorded), next to what the pallet row says. Pallets ShipBay never placed through Nexus are not in it.
create or replace function public.wms_nexus_journal() returns jsonb language sql stable security definer set search_path to 'public' as $$
  with last as (select distinct on (o.pallet_id) o.* from wms_nexus_ops o where o.state = 'done' and o.fixes is null order by o.pallet_id, o.finished_at desc, o.created_at desc)
  select coalesce(jsonb_agg(jsonb_build_object('pallet', l.psku, 'journal', case when l.kind <> 'release' then l.to_code end, 'left_floor', l.kind = 'release',
    'pallet_row', (select c.code from wms_pallets p join locations c on c.id = p.location_id where p.id = l.pallet_id), 'pallet_status', (select p.status from wms_pallets p where p.id = l.pallet_id)) order by l.psku), '[]')
  from last l where is_wms_staff();
$$;

revoke all on function public.wms_nexus_admin(), public._wms_nexus_desc(public.wms_nexus_ops, boolean), public._wms_nexus_begin(text, text, text, text, boolean), public.wms_putaway_begin(text, text),
  public.wms_move_begin(text, text), public.wms_release_begin(text, text, text, boolean), public._wms_nexus_apply(public.wms_nexus_ops), public._wms_nexus_result(uuid), public.wms_nexus_op_commit(uuid),
  public.wms_nexus_op_note(uuid, text, integer, text, text), public.wms_nexus_resolve_record(uuid, boolean), public.wms_nexus_fix_begin(uuid, boolean), public.wms_nexus_ops_open(),
  public.wms_nexus_ops_pending(), public.wms_nexus_journal() from public, anon, authenticated, service_role;
grant execute on function public.wms_nexus_admin(), public.wms_putaway_begin(text, text), public.wms_move_begin(text, text), public.wms_release_begin(text, text, text, boolean),
  public.wms_nexus_resolve_record(uuid, boolean), public.wms_nexus_fix_begin(uuid, boolean), public.wms_nexus_ops_open(), public.wms_nexus_journal() to authenticated;
grant execute on function public.wms_nexus_op_commit(uuid), public.wms_nexus_op_note(uuid, text, integer, text, text), public.wms_nexus_ops_pending() to service_role;
commit;
