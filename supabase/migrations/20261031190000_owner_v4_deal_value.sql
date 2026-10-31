alter table sales_leads add column if not exists deal_value numeric(12,2);   -- expected services $/mo if won
alter table sales_leads add column if not exists lost_reason text;
alter table sales_leads add column if not exists won_at timestamptz;
