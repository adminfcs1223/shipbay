-- HubSpot sync: a real push queue + no self-re-queue after a sync write
-- 1) updated_at only moves on a human/portal change; a sync write (one that sets hs_synced_at) keeps it
create or replace function sales_leads_touch_fn() returns trigger language plpgsql as $$
begin
  if new.hs_synced_at is distinct from old.hs_synced_at then new.updated_at = old.updated_at;
  else new.updated_at = now(); end if;
  return new;
end $$;
create or replace trigger sales_leads_touch before update on sales_leads for each row execute function sales_leads_touch_fn();

-- 2) what still has to go to HubSpot (pushable accounts whose portal change is newer than the last sync)
create or replace function hs_push_queue(p_limit int default 400) returns setof sales_leads
language sql security definer set search_path = public stable as $$
  select * from sales_leads
  where (stage <> 'new' or source not in ('cold_email','cold_call'))
    and (hs_synced_at is null or updated_at > hs_synced_at)
  order by updated_at asc limit p_limit
$$;
create or replace function hs_push_pending() returns int language sql security definer set search_path = public stable as $$
  select count(*)::int from sales_leads
  where (stage <> 'new' or source not in ('cold_email','cold_call'))
    and (hs_synced_at is null or updated_at > hs_synced_at)
$$;
create index if not exists sales_leads_hs_queue on sales_leads (updated_at) where hs_synced_at is null;
alter table sales_leads add column if not exists hs_error text; -- last push error, cleared on success
-- 3) a pull (HubSpot → portal) is marked with hs_pulled_at, never hs_synced_at, so it can't hide a portal change that still has to go out
alter table sales_leads add column if not exists hs_pulled_at timestamptz;
create or replace function sales_leads_touch_fn() returns trigger language plpgsql as $$
begin
  if new.hs_synced_at is distinct from old.hs_synced_at or new.hs_pulled_at is distinct from old.hs_pulled_at then new.updated_at = old.updated_at;
  else new.updated_at = now(); end if;
  return new;
end $$;
