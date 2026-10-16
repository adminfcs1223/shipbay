-- Signed-in users (e.g. team members testing the booking form) may also submit leads.
drop policy if exists "authed can submit leads" on public.leads;
create policy "authed can submit leads"
  on public.leads for insert
  to authenticated
  with check (true);
