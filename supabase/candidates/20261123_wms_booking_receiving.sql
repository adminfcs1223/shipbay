-- CANDIDATE for the deployed WMS (dc024b2), receiving only. Not applied anywhere but the dedicated local test database.
-- Grafted from the reviewed booking candidate (revision 2) and the review fixes, minus everything outside receiving:
--   * booked receiving beside the unchanged legacy route: wms_bookings (approved, open, same brand) + wms_receive_booking
--     (partial / HOLD / last-of-booking; actual cartons and pallets, never the booking's planned counts)
--   * damaged HOLD: a held pallet can be counted but never stored or posted to stock (table gate) until an active ShipBay
--     admin records a release (then normal put-away) or a void (never stock)
--   * stock posts only at put-away (wms_putaway -> stored -> _wms_post_stock), never at receipt
--   * the booking row (status, received_at, planned counts) is never changed, so the legacy invoice cannot bill this route
--   * "Did it go through?": wms_receipt_lookup bound to brand + booking + request key + content (version 1)
--   * active, authorized roles only: wms staff (is_wms_staff, active profile) for receiving/lookup; active admin for HOLD
--   * raw receipt links: no API access at all
-- NOT included (unchanged in production): legacy wms_receive, booking_progress / portal views, client booking guard,
-- any billing, shipping, order, flag or integration object.
begin;
alter table public.wms_pallets add column if not exists inbound_id uuid references public.inbound_shipments(id);
alter table public.wms_pallets add column if not exists held boolean not null default false;
alter table public.wms_pallets add column if not exists hold_reason text;
alter table public.wms_pallets add column if not exists hold_disposition text check (hold_disposition in ('released', 'voided'));
alter table public.wms_pallets add column if not exists hold_disposed_at timestamptz;
alter table public.wms_pallets add column if not exists hold_disposed_by uuid;
alter table public.wms_pallets add column if not exists hold_disposition_ref text;
create index if not exists wms_pallets_inbound_id_idx on public.wms_pallets (inbound_id) where inbound_id is not null;

-- Quarantine at the table: no path (put-away, assignment, a direct write, a future function) can store a held pallet.
create or replace function public._wms_hold_gate() returns trigger language plpgsql set search_path to 'public' as $$
begin
  if new.held and new.status = 'stored' and (tg_op = 'INSERT' or old.status is distinct from 'stored') then
    raise exception '% is on HOLD (%): it cannot be put away until a ShipBay admin releases it.', new.psku, coalesce(new.hold_reason, 'no reason given');
  end if;
  if tg_op = 'UPDATE' and old.held and not new.held and new.hold_disposition is distinct from 'released' then
    raise exception 'A HOLD is lifted only by a recorded release.';
  end if;
  return new;
end $$;
drop trigger if exists wms_pallets_hold_gate on public.wms_pallets;
create trigger wms_pallets_hold_gate before insert or update on public.wms_pallets for each row execute function public._wms_hold_gate();

create table if not exists public.wms_receipt_links (
  id uuid primary key default gen_random_uuid(),
  inbound_id uuid not null references public.inbound_shipments(id),
  org_id uuid not null references public.orgs(id),
  batch_key text not null unique,
  request_sig text not null, request_sig_version smallint not null default 1 check (request_sig_version = 1),
  mode text not null check (mode in ('partial', 'hold', 'final')),
  pallets int not null check (pallets > 0),
  cartons int not null check (cartons >= 0),
  hold_reason text,
  diff_pallets int, diff_cartons int,              -- final only; null when the booking gave no expected count
  received_by uuid, received_by_name text,
  created_at timestamptz not null default now(),
  check (mode <> 'hold' or coalesce(trim(hold_reason), '') <> '')
);
create index if not exists wms_receipt_links_inbound_idx on public.wms_receipt_links (inbound_id, created_at);
create unique index if not exists wms_receipt_links_one_final on public.wms_receipt_links (inbound_id) where mode = 'final';
alter table public.wms_receipt_links enable row level security;
revoke all on public.wms_receipt_links from public, anon, authenticated, service_role;   -- no API access; owner-run functions only

-- Internal: the one computation of receiving progress. Not granted to API roles; read through the functions below.
create or replace view public.v_inbound_receiving as
select i.id, i.org_id, i.reference, i.status, i.approved_at, i.expected_at,
  i.pallets as expected_pallets, i.cartons as expected_cartons,
  coalesce(a.pallets, 0) as received_pallets, coalesce(a.cartons, 0) as received_cartons, coalesce(a.receipts, 0) as receipts,
  coalesce(h.held, 0) as held_pallets, coalesce(h.released, 0) as released_pallets, coalesce(h.voided, 0) as voided_pallets,
  coalesce(h.stored, 0) as stored_pallets,
  a.last_hold_reason, a.final_diff_pallets as short_pallets, a.final_diff_cartons as short_cartons, a.last_received_at,
  (a.finals > 0) as receiving_closed,
  case
    when coalesce(a.receipts, 0) = 0 then 'not_received'
    when a.finals > 0 and (coalesce(a.final_diff_pallets, 0) <> 0 or coalesce(a.final_diff_cartons, 0) <> 0 or a.holds > 0) then 'closed_with_discrepancy'
    when a.finals > 0 then 'complete'
    when coalesce(h.held, 0) > 0 then 'partial_on_hold'
    else 'partial'
  end as receiving_state
from public.inbound_shipments i
left join lateral (
  select sum(l.pallets)::int pallets, sum(l.cartons)::int cartons, count(*)::int receipts,
    count(*) filter (where l.mode = 'hold')::int holds, count(*) filter (where l.mode = 'final')::int finals,
    (array_agg(l.hold_reason order by l.created_at desc) filter (where l.mode = 'hold'))[1] last_hold_reason,
    (array_agg(l.diff_pallets order by l.created_at desc) filter (where l.mode = 'final'))[1] final_diff_pallets,
    (array_agg(l.diff_cartons order by l.created_at desc) filter (where l.mode = 'final'))[1] final_diff_cartons,
    max(l.created_at) last_received_at
  from public.wms_receipt_links l where l.inbound_id = i.id
) a on true
left join lateral (
  select count(*) filter (where p.held and p.hold_disposition is null)::int held,
         count(*) filter (where p.hold_disposition = 'released')::int released,
         count(*) filter (where p.status = 'void')::int voided,
         count(*) filter (where p.status = 'stored')::int stored
  from public.wms_pallets p where p.inbound_id = i.id
) h on true;
revoke all on public.v_inbound_receiving from public, anon, authenticated;

-- An active login's role and brand, or nothing (inactive or missing profile).
create or replace function public._active_caller(out uid uuid, out role text, out org_id uuid, out staff boolean)
language sql stable security definer set search_path to 'public' as $$
  select p.id, p.role, p.org_id, p.role in ('shipbay_admin', 'shipbay_staff', 'shipbay_sales', 'wms_employee') from profiles p where p.id = auth.uid() and p.active;
$$;
revoke all on function public._active_caller() from public, anon, authenticated;

-- Floor list: approved, open, not yet closed by a final receipt. WMS staff with an active login only.
drop function if exists public.wms_bookings(uuid);
create or replace function public.wms_bookings(p_org uuid)
returns setof public.v_inbound_receiving language sql stable security definer set search_path to 'public' as $$
  select v.* from v_inbound_receiving v, _active_caller() c
  where c.uid is not null and is_wms_staff() and v.org_id = p_org and v.approved_at is not null
    and v.status in ('expected', 'in_transit') and not v.receiving_closed
  order by v.expected_at nulls last, v.reference;
$$;
revoke all on function public.wms_bookings(uuid) from public, anon;
grant execute on function public.wms_bookings(uuid) to authenticated;

create or replace function public.wms_receive_booking(
  p_inbound uuid, p_org uuid, p_lines jsonb, p_pallets integer, p_notes text, p_key text, p_mode text, p_hold_reason text)
returns setof public.wms_pallets language plpgsql security definer set search_path to 'public' as $$
declare
  b inbound_shipments; v_key text := nullif(trim(p_key), ''); v_mode text := coalesce(p_mode, 'partial'); v_sig text;
  lk wms_receipt_links; v_n int := coalesce(p_pallets, 1); v_log int := 0; l jsonb; v_c int; v_cle boolean;
  v_rp int; v_rc int; v_dp int; v_dc int; v_who text;
begin
  if not is_wms_staff() or (select uid from _active_caller()) is null then raise exception 'This login cannot receive pallets.'; end if;
  if v_key is null then raise exception 'A booked receipt needs its request key.'; end if;
  if v_mode not in ('partial', 'hold', 'final') then raise exception 'Say whether more is coming, it is on HOLD, or this is the last of the booking.'; end if;
  if v_mode = 'hold' and coalesce(trim(p_hold_reason), '') = '' then raise exception 'Say why it is on HOLD.'; end if;
  v_sig := md5(jsonb_build_object('inbound', p_inbound, 'org', p_org, 'lines', p_lines, 'pallets', v_n, 'notes', nullif(trim(p_notes), ''),
                                  'mode', v_mode, 'hold', nullif(trim(p_hold_reason), ''))::text);
  select * into b from inbound_shipments where id = p_inbound for update;
  if not found then raise exception 'That booking is not on file.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('wms_receive:' || v_key, 0));   -- same lock as legacy: no cross-route race on a key

  select * into lk from wms_receipt_links where batch_key = v_key;
  if found then
    if lk.inbound_id <> p_inbound or lk.request_sig <> v_sig then raise exception 'This request key was already used for a different receipt. Nothing was received.'; end if;
    return query select * from wms_pallets where batch_key = v_key order by batch_pos; return;
  end if;
  if exists (select 1 from wms_pallets where batch_key = v_key) then raise exception 'This request key was already used for an unbooked receipt. Nothing was received.'; end if;

  if b.org_id <> p_org then raise exception 'That booking belongs to another brand. Nothing was received.'; end if;
  if b.approved_at is null then raise exception 'That booking has not been approved yet.'; end if;
  if b.status not in ('expected', 'in_transit') then raise exception 'That booking is %: it cannot take more pallets.', b.status; end if;
  if exists (select 1 from wms_receipt_links where inbound_id = b.id and mode = 'final') then raise exception 'That booking was closed by its last receipt: it cannot take more pallets.'; end if;

  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_cle := coalesce((l->>'cle')::boolean, false);
    v_c := case when v_cle then 1 else coalesce(nullif(l->>'cartons', '')::int, 0) end;
    if not v_cle then v_log := v_log + v_c; end if;
  end loop;

  perform 1 from wms_receive(b.org_id, p_lines, v_n, p_notes, v_key);   -- unchanged receive: validation, pallets, cartons; never stock
  update wms_pallets set inbound_id = b.id,
    held = (v_mode = 'hold'), hold_reason = case when v_mode = 'hold' then trim(p_hold_reason) end
  where batch_key = v_key and org_id = b.org_id;

  if v_mode = 'final' then
    select coalesce(sum(pallets), 0) + v_n, coalesce(sum(cartons), 0) + v_log * v_n into v_rp, v_rc from wms_receipt_links where inbound_id = b.id;
    -- a booking with no stated count (0) has no shortfall to compute
    v_dp := case when b.pallets > 0 then b.pallets - v_rp end; v_dc := case when b.cartons > 0 then b.cartons - v_rc end;
  end if;
  -- inbound_shipments.status and received_at are deliberately left alone (legacy invoice reads them; see header)
  select coalesce(full_name, email) into v_who from profiles where id = auth.uid();
  insert into wms_receipt_links (inbound_id, org_id, batch_key, request_sig, mode, pallets, cartons, hold_reason, diff_pallets, diff_cartons, received_by, received_by_name)
  values (b.id, b.org_id, v_key, v_sig, v_mode, v_n, v_log * v_n, nullif(trim(p_hold_reason), ''), v_dp, v_dc, auth.uid(), v_who);
  return query select * from wms_pallets where batch_key = v_key order by batch_pos;
end $$;
revoke all on function public.wms_receive_booking(uuid, uuid, jsonb, integer, text, text, text, text) from public, anon;
grant execute on function public.wms_receive_booking(uuid, uuid, jsonb, integer, text, text, text, text) to authenticated;

-- The only way off HOLD: an active ShipBay admin records a release (then normal put-away) or a void (never stock).
create or replace function public.wms_hold_disposition(p_pallet uuid, p_action text, p_ref text)
returns public.wms_pallets language plpgsql security definer set search_path to 'public' as $$
declare p wms_pallets; c record;
begin
  select * into c from _active_caller();
  if c.uid is null or c.role <> 'shipbay_admin' then raise exception 'Only a ShipBay admin can release or void a pallet on HOLD.'; end if;
  if p_action not in ('release', 'void') then raise exception 'Release or void.'; end if;
  if coalesce(trim(p_ref), '') = '' then raise exception 'Record what the release or void is based on.'; end if;
  select * into p from wms_pallets where id = p_pallet for update;
  if not found or not p.held or p.hold_disposition is not null then raise exception 'That pallet is not on HOLD.'; end if;
  update wms_pallets set held = (p_action = 'void'), hold_disposition = case when p_action = 'release' then 'released' else 'voided' end,
    hold_disposed_at = now(), hold_disposed_by = c.uid, hold_disposition_ref = trim(p_ref),
    status = case when p_action = 'void' then 'void' else status end,
    voided_at = case when p_action = 'void' then now() else voided_at end, voided_by = case when p_action = 'void' then c.uid else voided_by end,
    void_reason = case when p_action = 'void' then 'HOLD voided: ' || trim(p_ref) else void_reason end
  where id = p_pallet returning * into p;
  return p;
end $$;
revoke all on function public.wms_hold_disposition(uuid, text, text) from public, anon;
grant execute on function public.wms_hold_disposition(uuid, text, text) to authenticated;

create function public._wms_receipt_sig_v1(p_inbound uuid, p_org uuid, p_lines jsonb, p_pallets integer, p_notes text, p_mode text, p_hold_reason text)
returns text language sql immutable set search_path to 'public' as $$
  select md5(jsonb_build_object('inbound', p_inbound, 'org', p_org, 'lines', p_lines, 'pallets', coalesce(p_pallets, 1), 'notes', nullif(trim(p_notes), ''),
                                'mode', coalesce(p_mode, 'partial'), 'hold', nullif(trim(p_hold_reason), ''))::text);
$$;
revoke all on function public._wms_receipt_sig_v1(uuid, uuid, jsonb, integer, text, text, text) from public, anon, authenticated, service_role;

-- "Did it go through?" for a booked receipt. Read-only. Answers one of:
--   received            this exact request (brand, booking, key, content) is on file; its pallets are returned
--   not_found           nothing under this key yet (may still be finishing; settles nothing)
--   different_request   this key is on file for this booking with different content
--   key_used_elsewhere  this key belongs to another booking/brand, or to an unbooked receipt (never treated as this one)
-- An error (not authorized, unsupported version, booking not this brand's) is an error, never "not found".
create function public.wms_receipt_lookup(p_org uuid, p_inbound uuid, p_key text, p_version integer,
  p_lines jsonb, p_pallets integer, p_notes text, p_mode text, p_hold_reason text)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare c record; b inbound_shipments; l wms_receipt_links; v_key text := nullif(trim(p_key), '');
begin
  select * into c from _active_caller();
  if c.uid is null or c.role not in ('shipbay_admin', 'shipbay_staff', 'wms_employee') or not is_wms_staff() then raise exception 'This login cannot look up receipts.'; end if;
  if p_version is distinct from 1 then raise exception 'Unsupported receipt request version %.', p_version; end if;
  if v_key is null then raise exception 'A request key is required.'; end if;
  select * into b from inbound_shipments where id = p_inbound;
  if b.id is null or b.org_id is distinct from p_org then raise exception 'That booking is not on file for this brand.'; end if;
  select * into l from wms_receipt_links where batch_key = v_key;
  if l.id is null then
    if exists (select 1 from wms_pallets where batch_key = v_key) then return jsonb_build_object('state', 'key_used_elsewhere'); end if;
    return jsonb_build_object('state', 'not_found');
  end if;
  if l.org_id <> p_org or l.inbound_id <> p_inbound then return jsonb_build_object('state', 'key_used_elsewhere'); end if;
  if l.request_sig_version <> 1 or l.request_sig <> _wms_receipt_sig_v1(p_inbound, p_org, p_lines, p_pallets, p_notes, p_mode, p_hold_reason) then
    return jsonb_build_object('state', 'different_request');
  end if;
  return jsonb_build_object('state', 'received', 'mode', l.mode, 'pallets',
    coalesce((select jsonb_agg(to_jsonb(p) order by p.batch_pos) from wms_pallets p where p.batch_key = v_key and p.org_id = p_org and p.inbound_id = p_inbound), '[]'));
end $$;
revoke all on function public.wms_receipt_lookup(uuid, uuid, text, integer, jsonb, integer, text, text, text) from public, anon, service_role;
grant execute on function public.wms_receipt_lookup(uuid, uuid, text, integer, jsonb, integer, text, text, text) to authenticated;


commit;
