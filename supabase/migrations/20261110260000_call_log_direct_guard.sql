-- The call log cannot lose a call (Derek, 2026-11-10 19:53 ET: "make sure the build is solid, this cannot happen").
-- Replaces the planned "lock the call log" step (20261110200000 §9b, never applied): a refused insert from a portal tab
-- opened before the 11-10 evening build would have been dropped without a word. Instead a direct insert is always
-- accepted and made safe by the database: logged as the signed-in person, time and length bounded, never pre-voided,
-- and flagged `direct` so the owner can see any call that did not come through log_call.
alter table public.sales_calls add column if not exists direct boolean not null default false;
create or replace function public.sales_calls_direct_guard() returns trigger
language plpgsql set search_path to 'public' as $$
begin
  if current_user = 'authenticated' then       -- log_call runs as the function owner, so this is a write straight from a browser
    new.direct := true;
    if auth.uid() is not null and not public.is_owner() then new.by_user := auth.uid(); end if;
    new.voided_at := null;
    if new.started_at is null or new.started_at > now() + interval '5 minutes' or new.started_at < now() - interval '12 hours' then new.started_at := now(); end if;
    new.seconds := least(14400, greatest(0, coalesce(new.seconds, 0)));
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'sales_calls_direct_guard' and tgrelid = 'public.sales_calls'::regclass) then
    create trigger sales_calls_direct_guard before insert on public.sales_calls for each row execute function public.sales_calls_direct_guard();
  end if;
end $$;
