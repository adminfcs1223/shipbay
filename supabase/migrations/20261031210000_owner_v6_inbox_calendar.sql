alter table sales_email_sends add column if not exists read_at timestamptz;      -- reply opened in the portal
alter table sales_email_sends add column if not exists read_by uuid;
alter table sales_meetings add column if not exists description text;
alter table sales_meetings add column if not exists all_day boolean not null default false;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'sales_email_sends' and policyname = 'sales_email_sends_rep_update') then
    create policy sales_email_sends_rep_update on sales_email_sends for update using (exists (select 1 from sales_leads l where l.id = sales_email_sends.lead_id and l.assigned_to = auth.uid())) with check (exists (select 1 from sales_leads l where l.id = sales_email_sends.lead_id and l.assigned_to = auth.uid()));
  end if;
end $$;
