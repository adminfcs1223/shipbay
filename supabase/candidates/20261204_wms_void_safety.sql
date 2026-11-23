-- Two void safety rules. CANDIDATE: tested on the local synthetic database only, applied nowhere.
-- Needs 20261127_wms_waves (pallet on picks), 20261130_wms_nexus_putaway (the journal) and 20261203_wms_inventory_workflow (_wms_pallet_busy).
-- Derek's request, 2026-11-23 1:14 AM.
--
-- What a void does today: wms_void_pallet only sets the pallet's status. The stock trigger then sees a pallet that is not
-- 'stored' and takes everything the pallet ever posted off the books as one 'adjust'. Picks made from the pallet are separate
-- ledger rows and stay. So:
--   1. 100 received, 30 picked, void: the position is left at minus 30.
--   2. Void while a Nexus request is waiting: on a move the stock is written off at once, Nexus completes the move, and ShipBay
--      then refuses to record it ("was voided"): a void pallet at the old position in ShipBay, the new position held in Nexus.
--
-- The rule: a void is for a pallet entered by mistake. It is refused, with nothing changed, when
--   a. a Nexus request for the pallet is not settled (waiting for an answer, or accepted by Nexus and not recorded by ShipBay);
--   b. the pallet has left the building (its units are settled by the outbound transaction, never by a void);
--   c. a wave still has a pick planned from it;
--   d. units have been picked from it and not put back (the picks are its history; undo them first);
--   e. taking its units off the books would leave any position below zero (older picks that named no pallet).
-- A void that passes posts exactly what it posted before. Nothing else in the function changed: same login check, same reason
-- rule, same row returned, same grants. Reconciliation is untouched: record and undo for an out-of-sync request work as before,
-- and once the request is settled the pallet can be voided if the other rules allow it.
begin;

create or replace function public.wms_void_pallet(p_id uuid, p_reason text) returns public.wms_pallets
language plpgsql security definer set search_path to 'public' as $$
declare r wms_pallets; p wms_pallets; o wms_nexus_ops; v_wave int; v_picked int; x record;
begin
  if not is_wms_staff() then raise exception 'This login cannot void pallets.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Say why this pallet is being voided.'; end if;
  -- the same row lock every Nexus request takes first: a void and a scan for the same pallet cannot pass each other
  select * into p from wms_pallets where id = p_id for update;
  if p.id is null or p.status = 'void' then raise exception 'That pallet is not on file or is already voided.'; end if;

  -- a. not while Nexus has not settled where it stands
  select * into o from wms_nexus_ops where pallet_id = p.id and state in ('pending', 'out_of_sync') order by (state = 'out_of_sync') desc, created_at limit 1;
  if o.id is not null then
    if o.state = 'out_of_sync' then
      raise exception '% cannot be voided yet: Nexus accepted % and ShipBay has not recorded it. An admin settles that under Put away first.', p.psku, coalesce(o.to_code, o.from_code);
    end if;
    raise exception '% cannot be voided yet: it has a request for % that Nexus has not answered. Finish that one first.', p.psku, coalesce(o.to_code, o.from_code);
  end if;

  -- b. a pallet that left the building keeps its record
  if p.status = 'departed' then raise exception '% has left the building and cannot be voided. Its record stays as it is.', p.psku; end if;

  -- c. a pick is planned from it
  select min(w.seq) into v_wave from wms_wave_tasks t join wms_waves w on w.id = t.wave_id where t.pallet_id = p.id and t.confirmed_at is null and w.status = 'picking';
  if v_wave is not null then raise exception 'Wave % still has a pick planned from %. Pick that stop or hand the wave back first.', v_wave, p.psku; end if;

  -- d. units picked from it and not put back
  select -coalesce(sum(m.qty), 0)::int into v_picked from inventory_moves m where m.pallet_id = p.id and m.reason = 'pick';
  if v_picked <> 0 then
    raise exception '% of %''s units have been picked. A pallet that has been picked from cannot be voided: undo those picks first.', v_picked, p.psku;
  end if;

  -- e. nothing may end below zero (picks that named no pallet, made with the older pick list)
  for x in
    select s.sku, coalesce(l.code, 'no position') code, d.qty posted,
      (select coalesce(sum(m.qty), 0)::int from inventory_moves m where m.sku_id = d.sku_id and m.location_id is not distinct from d.location_id) on_books
    from (select m.sku_id, m.location_id, sum(m.qty)::int qty from inventory_moves m where m.ref_type = 'wms_pallet' and m.ref_id = p.id group by 1, 2 having sum(m.qty) > 0) d
    join skus s on s.id = d.sku_id left join locations l on l.id = d.location_id
  loop
    if x.on_books < x.posted then
      raise exception '% cannot be voided: it put % of % at % and only % are on the books there. Units have been picked from that position. Undo those picks first.', p.psku, x.posted, x.sku, x.code, x.on_books;
    end if;
  end loop;

  update wms_pallets set status = 'void', voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason)
   where id = p_id and status <> 'void' returning * into r;
  if r.id is null then raise exception 'That pallet is not on file or is already voided.'; end if;
  return r;
end $$;

commit;
