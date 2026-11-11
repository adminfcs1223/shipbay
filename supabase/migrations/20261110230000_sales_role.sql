-- A sales role: the menu shows Sales (Appt. Setting + CRM) only. (Derek, 2026-11-10 18:58 ET)
-- The CRM needs quotes, brands and onboarding, so the database treats the role as staff (is_shipbay); what it removes is
-- the Warehouse and Admin screens, not the data behind them.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('shipbay_admin', 'shipbay_staff', 'shipbay_sales', 'shipbay_setter', 'client_admin', 'client_user'));
create or replace function public.is_shipbay() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role in ('shipbay_admin','shipbay_staff','shipbay_sales'));
$$;
create or replace function public.is_closer(p uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = p and active is not false and (is_sales or is_owner) and role in ('shipbay_admin', 'shipbay_staff', 'shipbay_sales'))
$$;
