alter table orgs add column if not exists sales_rep_id uuid references profiles(id);
update orgs o set sales_rep_id = p.id from profiles p where o.sales_rep_id is null and o.sales_rep is not null and lower(p.full_name) = lower(o.sales_rep);
