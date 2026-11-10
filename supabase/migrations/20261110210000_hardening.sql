-- Security pass over the CRM and the site's database surface. (2026-11-10)
-- Every item below closed something reachable with a normal login or with the public site key (site/js/config.js).
-- Connector-safe and reversible: guards, revokes, enable-RLS. Nothing is dropped.

-- ============================================================ 1. only the owner changes roles and access
-- Before: "own_profile_update" pinned role and org_id but not is_owner / is_sales, so any login (a client's included)
-- could set is_owner = true on its own row and read finances and the whole CRM. shipbay staff could do it to anyone.
create or replace function public.profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;            -- the backend: service role, SQL, the sign-up trigger
  if public.is_owner() then return new; end if;
  if tg_op = 'INSERT' then
    raise exception 'Logins are created under Admin settings → Users.' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.role is distinct from old.role or new.is_owner is distinct from old.is_owner
     or new.is_sales is distinct from old.is_sales or new.closer_id is distinct from old.closer_id or new.active is distinct from old.active
     or new.org_id is distinct from old.org_id or new.email is distinct from old.email then
    raise exception 'Only the owner can change roles and access.' using errcode = '42501';
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'profiles_guard' and tgrelid = 'public.profiles'::regclass) then
    create trigger profiles_guard before insert or update on public.profiles for each row execute function public.profiles_guard();
  end if;
end $$;

-- ============================================================ 2. tables that had no row-level security
-- Readable and writable by anyone holding the public site key. Only cron jobs, edge functions and SQL use them; none of the apps do.
alter table public.cce_call_plan enable row level security;
alter table public.cce_hs_batches enable row level security;
alter table public.cce_parked_leads enable row level security;
alter table public.hs_sequence_enrollments enable row level security;
alter table public.hs_sequences enable row level security;
alter table public.make_blitz_state enable row level security;
alter table public.sl_campaign_leads_snapshot enable row level security;
alter table public.sl_campaign_stats_snapshot enable row level security;
alter table public.sl_fetch_log enable row level security;
alter table public.sl_lead_removals enable row level security;

-- ============================================================ 3. functions the public site key could call
-- hs_push_queue returned CRM leads to anyone; hs_enroll_due / make_blitz_tick enrolled HubSpot contacts into sequences on request.
revoke execute on function public.hs_push_queue(integer) from public, anon, authenticated;
revoke execute on function public.hs_push_pending() from public, anon, authenticated;
revoke execute on function public.hs_enroll_due() from public, anon, authenticated;
revoke execute on function public.hs_enroll_collect() from public, anon, authenticated;
revoke execute on function public.make_blitz_tick() from public, anon, authenticated;
revoke execute on function public.create_manual_order(uuid, jsonb, jsonb) from public, anon;
revoke execute on function public.scan_receive_sku(uuid, uuid, text, integer) from public, anon;
-- no caller check inside, and no app calls them: a client login could rewrite another brand's storage count (it feeds invoices),
-- read another brand's SKU, or stop a lead's sequence
revoke execute on function public.snapshot_storage(uuid, integer, integer, integer, text) from public, anon, authenticated;
revoke execute on function public.find_sku_by_code(uuid, text) from public, anon, authenticated;
revoke execute on function public.stop_sequence(uuid, text) from public, anon, authenticated;
revoke execute on function public.ensure_onboarding(uuid) from public, anon, authenticated;
alter function public.hs_enroll_due() set search_path = public;
alter function public.hs_enroll_collect() set search_path = public;

-- ============================================================ 4. the site's lead form
-- The forms post to "leads" with the public key, and every row sends email. Clean what the public can set and cap the rate.
create or replace function public.leads_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  if v_role <> 'anon' then return new; end if;
  new.email := lower(btrim(coalesce(new.email, '')));
  if length(new.email) > 254 or new.email !~ '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$' then raise exception 'A valid email is required.' using errcode = '22023'; end if;
  new.name := left(btrim(new.name), 120);
  new.brand := left(btrim(new.brand), 160);
  new.phone := left(btrim(new.phone), 40);
  new.volume := left(new.volume, 120);
  new.current_setup := left(new.current_setup, 200);
  new.notes := left(new.notes, 4000);
  new.slot := left(new.slot, 120);
  new.source := left(coalesce(nullif(btrim(new.source), ''), 'website'), 80);
  new.stage := 'new'; new.rep := null; new.org_id := null; new.converted_at := null; new.sales_lead_id := null;
  if new.activity is not null and pg_column_size(new.activity) > 8000 then new.activity := '[]'::jsonb; end if;
  if new.intake is not null and pg_column_size(new.intake) > 60000 then raise exception 'That is more than the form sends.' using errcode = '22023'; end if;
  if exists (select 1 from leads l where lower(l.email) = new.email and l.source is not distinct from new.source and l.created_at > now() - interval '45 seconds') then
    raise exception 'Already received.' using errcode = '23505';            -- a double click
  end if;
  if (select count(*) from leads l where lower(l.email) = new.email and l.created_at > now() - interval '1 hour') >= 4 then
    raise exception 'Already received. We will be in touch.' using errcode = '23505';
  end if;
  if (select count(*) from leads l where l.created_at > now() - interval '1 hour') >= 40 then
    raise exception 'Too many requests right now.' using errcode = '54000';
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'leads_guard' and tgrelid = 'public.leads'::regclass) then
    create trigger leads_guard before insert on public.leads for each row execute function public.leads_guard();
  end if;
end $$;

-- ============================================================ 5. connected mailboxes are staff-only
-- v_gmail_accounts (address + sync state, never tokens) was readable by the public key and by client logins.
create or replace view public.v_gmail_accounts as
  select user_id, email, connected_at, last_sync_at, last_error, scopes
    from gmail_accounts
   where public.is_sales_team() or public.is_shipbay();
revoke all on public.v_gmail_accounts from anon;
