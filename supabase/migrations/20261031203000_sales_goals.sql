do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'fin_settings' and policyname = 'fin_settings_sales_goals') then
    create policy fin_settings_sales_goals on fin_settings for select using (is_sales() and key = 'sales_goals');
  end if;
end $$;
insert into fin_settings (key, value) values ('sales_goals', '{"team":{"dials_day":60,"dials_week":300,"emails_day":150,"emails_week":750,"booked_day":1,"booked_week":5},"reps":{}}'::jsonb) on conflict (key) do nothing;
