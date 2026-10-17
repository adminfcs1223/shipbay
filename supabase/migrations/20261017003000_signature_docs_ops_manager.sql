-- Documents shipbay uploads for the client to sign (rate card, agreement, SLA) — not themselves approvals
alter table documents add column if not exists for_signature boolean not null default false;

create or replace function documents_sync_task() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.task_key is null or new.for_signature then return new; end if;
  if new.status = 'approved' then
    update onboarding_tasks set done = true, done_at = coalesce(new.reviewed_at, now()), done_by = new.reviewed_by
      where org_id = new.org_id and key = new.task_key and kind = 'document';
  else
    update onboarding_tasks set done = false, done_at = null, done_by = null
      where org_id = new.org_id and key = new.task_key and kind = 'document'
        and not exists (select 1 from documents d where d.org_id = new.org_id and d.task_key = new.task_key and d.status = 'approved' and not d.for_signature and d.id <> new.id);
  end if;
  return new;
end $$;

-- Account Operations Manager shown next to the sales rep (per account, defaults to Xavier)
alter table orgs add column if not exists ops_manager text not null default 'Xavier Delmonte';
alter table orgs add column if not exists ops_manager_phone text not null default '(732) 783-6604';
alter table orgs add column if not exists ops_manager_email text not null default 'xavierd@shipbay3pl.com';
alter table orgs add column if not exists sales_rep_phone text not null default '(610) 478-5432';
alter table orgs add column if not exists sales_rep_email text not null default 'derekh@shipbay3pl.com';
