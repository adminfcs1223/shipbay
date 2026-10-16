-- Full MigrateHL intake payload rides along with each lead
alter table public.leads add column if not exists intake jsonb;
