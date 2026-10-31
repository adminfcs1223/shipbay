-- Sales team: reps share the untouched pool (new + unassigned), own what they touch, see only their own work.
create or replace function is_sales() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_sales or is_owner from profiles where id = auth.uid()), false)
$$;
revoke all on function is_sales() from public;
grant execute on function is_sales() to authenticated;

-- a rep can read + update their own leads and any untouched lead; whatever they write must end up assigned to them
alter policy sales_leads_rep on sales_leads
  using (is_sales() and (assigned_to = auth.uid() or (assigned_to is null and stage = 'new')))
  with check (is_sales() and assigned_to = auth.uid());

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'sales_sources' and policyname = 'sales_sources_rep') then
    create policy sales_sources_rep on sales_sources for select using (is_sales());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'sales_call_sessions' and policyname = 'sales_call_sessions_rep') then
    create policy sales_call_sessions_rep on sales_call_sessions for all using (by_user = auth.uid()) with check (by_user = auth.uid());
  end if;
end $$;

-- round-robin for email replies: which reps are in the rotation + whose turn is next
insert into fin_settings (key, value) select 'round_robin', jsonb_build_object('members', (select coalesce(jsonb_agg(id order by email), '[]'::jsonb) from profiles where is_sales and active), 'next', 0)
where not exists (select 1 from fin_settings where key = 'round_robin');
