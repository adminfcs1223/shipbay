-- Quotes: a model (what kind of business), the value-added services switched on, and the proposal document fields.
alter table public.quotes
  add column if not exists model text not null default 'dtc',
  add column if not exists services jsonb not null default '{}'::jsonb,
  add column if not exists proposal jsonb not null default '{}'::jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_model_check') then
    alter table public.quotes add constraint quotes_model_check check (model in ('dtc','subscription','hybrid','b2b','fba','launch','storage','project'));
  end if;
end $$;
update public.quotes set model = 'subscription', inputs = inputs || jsonb_build_object('drops_per_month', 1) where company ilike 'vinyl moon%';
