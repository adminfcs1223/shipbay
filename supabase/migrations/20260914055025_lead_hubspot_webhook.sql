-- Sync every new lead to HubSpot (contact + deal + note) alongside the email notification.
create or replace function public.sync_lead_hubspot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://poxlczzkpztmoiixyrth.supabase.co/functions/v1/hubspot-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', '<WEBHOOK_SECRET — redacted; value lives in the database function and Netlify env>'
    ),
    body := jsonb_build_object('record', to_jsonb(new)),
    timeout_milliseconds := 5000
  );
  return new;
end;
$$;

drop trigger if exists trg_sync_lead_hubspot on public.leads;
create trigger trg_sync_lead_hubspot
  after insert on public.leads
  for each row execute function public.sync_lead_hubspot();
