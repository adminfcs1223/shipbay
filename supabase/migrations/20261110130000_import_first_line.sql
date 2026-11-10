-- Import leads (Admin): the hand-written first line for cold email E1 rides on the lead so the Smartlead push can carry it.
alter table public.sales_leads add column if not exists first_line text;
