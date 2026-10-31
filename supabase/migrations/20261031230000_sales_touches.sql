create table if not exists sales_touches (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references sales_leads(id) on delete cascade,
  kind text not null check (kind in ('email_sent','note','sms','meeting_note')),
  note text,
  at timestamptz not null default now(),
  by_user uuid
);
create index if not exists sales_touches_lead on sales_touches (lead_id);
alter table sales_touches enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'sales_touches' and policyname = 'sales_touches_owner_all') then
    create policy sales_touches_owner_all on sales_touches for all using (is_owner()) with check (is_owner());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'sales_touches' and policyname = 'sales_touches_rep') then
    create policy sales_touches_rep on sales_touches for all using (by_user = auth.uid()) with check (by_user = auth.uid());
  end if;
end $$;
update fin_settings set value = jsonb_set(value, '{bonus}', (value->'bonus') || '{"rules": [{"metric": "booked", "target": 20}, {"metric": "won", "target": 3}]}'::jsonb) where key = 'sales_goals' and not ((value->'bonus') ? 'rules');
