-- Email the sales desk (via the notify-lead edge function -> Resend) on every new lead.
create extension if not exists pg_net with schema extensions;

create or replace function public.notify_lead_email()
returns trigger
language plpgsql security definer
set search_path = public, extensions
as $$
begin
  perform net.http_post(
    url := 'https://poxlczzkpztmoiixyrth.supabase.co/functions/v1/notify-lead',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', '<WEBHOOK_SECRET — redacted; value lives in the database function and Netlify env>'
    ),
    body := jsonb_build_object('record', to_jsonb(new))
  );
  return new;
end;
$$;

drop trigger if exists trg_notify_lead_email on public.leads;
create trigger trg_notify_lead_email
  after insert on public.leads
  for each row execute function public.notify_lead_email();
