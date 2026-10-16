-- Auto-email the full rate card when a lead's source is 'Rate card request'.
create or replace function public.send_rate_card()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.source = 'Rate card request' then
    perform net.http_post(
      url := 'https://poxlczzkpztmoiixyrth.supabase.co/functions/v1/send-rate-card',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', '<WEBHOOK_SECRET — redacted; value lives in the database function and Netlify env>'
      ),
      body := jsonb_build_object('record', to_jsonb(new)),
      timeout_milliseconds := 5000
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_send_rate_card on public.leads;
create trigger trg_send_rate_card
  after insert on public.leads
  for each row execute function public.send_rate_card();
