-- Helpers for the hosted movement rehearsal. DEVELOPMENT DATABASE ONLY. Never part of supabase/candidates.
-- NOT APPLIED to shipbay-nexus-dev yet: applying it is a change to that database and needs Derek's go.
-- Both functions can be run only by the bridge's own service login (the temporary test runner), never by a signed-in
-- user or the public key, and both refuse on a database that holds any brand other than the two synthetic ones.
--
--   dev_movement_snapshot()        read-only. Pallets, the stock ledger, the Nexus journal and one open order, as one JSON
--                                  document, so the runner and the local test read exactly the same thing.
--   dev_runner_runs + dev_runner_begin(stage) / dev_runner_finish(run, ok, result) / dev_runner_read(stage)
--                                  the runner's own record. A stage that writes can be started ONCE: a second start
--                                  (a browser reload, a retry) is refused before anything is sent. Results are kept here
--                                  so they can be read afterwards whatever happened to the browser that started the stage.
--   dev_fault_hold(psku, reason)   the one injected fault ShipBay has no floor function for: a pallet is put on HOLD
--                                  ("damage found") while its put-away is waiting for Nexus's answer. It refuses unless the
--                                  pallet is open, not yet stored, and has exactly one request waiting.
begin;
create or replace function public._dev_synthetic_only() returns void language plpgsql stable security definer set search_path to 'public' as $$
begin
  if exists (select 1 from orgs where id not in ('5a000000-0000-4000-8000-0000000000a1', '5a000000-0000-4000-8000-0000000000a2')) then
    raise exception 'This is not the synthetic development database. Nothing was read or changed.';
  end if;
end $$;

create or replace function public.dev_movement_snapshot() returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare j jsonb;
begin
  perform _dev_synthetic_only();
  select jsonb_build_object(
    'pallets', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'psku', p.psku, 'status', p.status, 'held', p.held, 'location', l.code, 'batch', p.batch_key, 'pos', p.batch_pos,
        'org', p.org_id, 'carton', (select min(c.code) from wms_cartons c where c.pallet_id = p.id),
        'receipts', (select count(*) from inventory_moves m where m.ref_id = p.id and m.reason = 'receive'),
        'received_units', (select coalesce(sum(m.qty), 0) from inventory_moves m where m.ref_id = p.id and m.reason = 'receive'),
        'adjustments', (select count(*) from inventory_moves m where m.ref_id = p.id and m.reason = 'adjust'),
        'transfers', (select count(*) from inventory_moves m where m.ref_id = p.id and m.reason = 'transfer'),
        'transfer_net', (select coalesce(sum(m.qty), 0) from inventory_moves m where m.ref_id = p.id and m.reason = 'transfer'),
        'ledger_rows', (select count(*) from inventory_moves m where m.ref_id = p.id or m.pallet_id = p.id),
        'on_books', (select coalesce(sum(m.qty), 0) from inventory_moves m where m.ref_id = p.id or m.pallet_id = p.id)) order by p.psku), '[]')
      from wms_pallets p left join locations l on l.id = p.location_id),
    'stock', (select coalesce(jsonb_agg(jsonb_build_object('sku', x.sku, 'location', x.code, 'qty', x.qty) order by x.sku, x.code), '[]')
      from (select s.sku, l.code, sum(m.qty)::int qty from inventory_moves m join skus s on s.id = m.sku_id left join locations l on l.id = m.location_id group by 1, 2 having sum(m.qty) <> 0) x),
    'by_sku', (select coalesce(jsonb_object_agg(x.sku, x.qty), '{}') from (select s.sku, sum(m.qty)::int qty from inventory_moves m join skus s on s.id = m.sku_id group by 1) x),
    'by_reason', (select coalesce(jsonb_object_agg(x.reason, jsonb_build_object('rows', x.n, 'units', x.qty)), '{}') from (select reason, count(*) n, sum(qty)::int qty from inventory_moves group by 1) x),
    'ledger_rows', (select count(*) from inventory_moves),
    'ledger_units', (select coalesce(sum(qty), 0) from inventory_moves),
    'ops', (select coalesce(jsonb_agg(jsonb_build_object('op', o.id, 'psku', o.psku, 'kind', o.kind, 'state', o.state, 'from', o.from_code, 'to', o.to_code, 'key', o.idem_key, 'attempts', o.attempts,
        'http', o.nexus_http, 'error', o.nexus_error, 'problem', o.problem, 'reason', o.reason, 'confirmed', o.confirmed_at_position, 'fixes', o.fixes, 'by', o.by_name,
        'resolution', o.resolution, 'resolved_by', o.resolved_by_name) order by o.created_at, o.id), '[]') from wms_nexus_ops o),
    'left_floor_log', (select coalesce(jsonb_agg(jsonb_build_object('psku', a.ref, 'from', a.detail ->> 'from', 'reason', a.detail ->> 'reason', 'units_on_books', a.detail -> 'units_on_books') order by a.id), '[]')
      from wms_activity a where a.kind = 'pallet_left_floor'),
    'off_floor', (select jsonb_build_object('exists', true, 'pickable', l.pickable, 'shared', coalesce(l.shared, false)) from locations l where l.code = 'OFF-FLOOR'),
    'orders', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'number', o.order_number, 'status', o.status, 'org', o.org_id) order by o.order_number), '[]') from orders o),
    -- which safety rules this database has (read from the function text; the suite's preflight refuses to start without them)
    'rules', jsonb_build_object(
      'void_safety', exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'wms_void_pallet' and prosrc like '%cannot be voided yet%'),
      'unit_safety', exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'wms_set_units' and prosrc like '%cannot be changed yet%')
        and exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'wms_correct_units'))
  ) into j;
  return j;
end $$;

create or replace function public.dev_fault_hold(p_psku text, p_reason text) returns text language plpgsql security definer set search_path to 'public' as $$
declare p wms_pallets;
begin
  perform _dev_synthetic_only();
  select * into p from wms_pallets where psku = upper(trim(p_psku)) for update;
  if p.id is null then raise exception 'Pallet % is not on file.', p_psku; end if;
  if p.status <> 'open' or p.location_id is not null or p.held then raise exception '% is not an open, unplaced pallet. Nothing was changed.', p.psku; end if;
  if (select count(*) from wms_nexus_ops o where o.pallet_id = p.id and o.state = 'pending' and o.kind = 'assign') <> 1 then
    raise exception '% has no put-away waiting for Nexus. Nothing was changed.', p.psku;
  end if;
  update wms_pallets set held = true, hold_reason = left(coalesce(nullif(trim(p_reason), ''), 'Synthetic: damage found'), 120) where id = p.id;
  return p.psku || ' is on HOLD.';
end $$;

create table if not exists public.dev_runner_runs (
  id bigserial primary key, stage text not null, started_at timestamptz not null default clock_timestamp(), finished_at timestamptz, ok boolean, result jsonb);
create unique index if not exists dev_runner_runs_once on public.dev_runner_runs (stage) where stage not in ('preflight', 'final');
alter table public.dev_runner_runs enable row level security;   -- no policies: reached only through the functions below
revoke all on table public.dev_runner_runs from public, anon, authenticated;
revoke all on sequence public.dev_runner_runs_id_seq from public, anon, authenticated;

create or replace function public.dev_runner_begin(p_stage text) returns bigint language plpgsql security definer set search_path to 'public' as $$
declare v bigint;
begin
  perform _dev_synthetic_only();
  if p_stage not in ('preflight', 'move', 'release', 'lost', 'partial', 'undo', 'picks', 'stops', 'final') then raise exception 'Unknown stage.'; end if;
  if exists (select 1 from dev_runner_runs where finished_at is null and started_at > now() - interval '10 minutes') then raise exception 'A stage is still running. Nothing was started.'; end if;
  if p_stage not in ('preflight', 'final') and exists (select 1 from dev_runner_runs where stage = p_stage) then raise exception 'Stage % was already started once. Nothing was started.', p_stage; end if;
  insert into dev_runner_runs (stage) values (p_stage) returning id into v; return v;
end $$;
create or replace function public.dev_runner_finish(p_run bigint, p_ok boolean, p_result jsonb) returns void language sql security definer set search_path to 'public' as $$
  update dev_runner_runs set finished_at = clock_timestamp(), ok = p_ok, result = p_result where id = p_run and finished_at is null;
$$;
create or replace function public.dev_runner_read(p_stage text) returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('run', r.id, 'stage', r.stage, 'started_at', r.started_at, 'finished_at', r.finished_at, 'ok', r.ok, 'result', r.result) order by r.id), '[]')
  from dev_runner_runs r where p_stage is null or r.stage = p_stage;
$$;

revoke all on function public._dev_synthetic_only() from public, anon, authenticated, service_role;
revoke all on function public.dev_runner_begin(text) from public, anon, authenticated;
revoke all on function public.dev_runner_finish(bigint, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.dev_runner_read(text) from public, anon, authenticated;
grant execute on function public.dev_runner_begin(text) to service_role;
grant execute on function public.dev_runner_finish(bigint, boolean, jsonb) to service_role;
grant execute on function public.dev_runner_read(text) to service_role;
revoke all on function public.dev_movement_snapshot() from public, anon, authenticated;
revoke all on function public.dev_fault_hold(text, text) from public, anon, authenticated;
grant execute on function public.dev_movement_snapshot() to service_role;
grant execute on function public.dev_fault_hold(text, text) to service_role;
commit;
