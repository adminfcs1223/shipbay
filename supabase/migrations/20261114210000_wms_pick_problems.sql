-- 2026-11-14 (Derek, 15:46): a picker can report a problem on a line (not at the location, short, something else), and
-- "just because there is no assigned location does not mean the item doesn't need to be picked": a line with no
-- location, or with less on file than ordered, is picked like any other. wms_pick takes what the system has on file
-- and records the rest on the line (order_lines.pick_short) instead of refusing.
-- Applied live with execute_sql on 11-14. NOT IN THIS FILE YET: the function bodies changed with it (wms_report_problem,
-- wms_resolve_problem, wms_pick, wms_unpick, wms_picklist). They exist only in the database; copy them here from
-- pg_get_functiondef before rebuilding a database from these files.
alter table order_lines add column if not exists pick_short int;   -- units picked that the system had no stock for

create table if not exists wms_pick_problems (
  id uuid primary key default gen_random_uuid(),
  line_id uuid not null references order_lines(id),
  order_id uuid not null, org_id uuid not null, sku_id uuid,
  kind text not null check (kind in ('missing', 'short', 'other')),
  found int check (found is null or found >= 0),
  note text,
  location_code text,
  reported_by uuid, reported_by_name text, reported_at timestamptz not null default now(),
  resolved_at timestamptz, resolved_by_name text, resolved_how text
);
create index if not exists wms_pick_problems_open on wms_pick_problems (line_id) where resolved_at is null;
alter table wms_pick_problems enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'wms_pick_problems' and policyname = 'wms_staff_read_problems') then
    create policy wms_staff_read_problems on wms_pick_problems for select using (is_wms_staff());
  end if;
end $$;
