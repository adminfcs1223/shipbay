alter policy fin_settings_sales_goals on fin_settings using (is_sales() and key in ('sales_goals', 'booking_link'));
insert into fin_settings (key, value) values ('booking_link', '{"url": ""}'::jsonb) on conflict (key) do nothing;
update fin_settings set value = value || '{"bonus": {"metric": "booked", "target": 10, "payout": 500, "period": "month", "message": "NO YOU''RE WEAK"}}'::jsonb where key = 'sales_goals' and not (value ? 'bonus');
