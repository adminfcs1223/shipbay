-- Founder email engine: instant (T0) email per lead type + queued follow-up
-- sequences drained by pg_cron via the lead-emails edge function.

create table if not exists public.sequence_queue (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references public.leads(id) on delete cascade,
  template   text not null,
  send_at    timestamptz not null,
  sent       boolean not null default false,
  sent_at    timestamptz,
  status     text,
  created_at timestamptz not null default now()
);
alter table public.sequence_queue enable row level security;
-- no policies: service-role only, invisible to the public API

create or replace function public.lead_email_kickoff()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  t0 text;
  fu1 text; fu1_at interval;
  fu2 text; fu2_at interval;
begin
  if new.source = 'Rate card request' then
    t0 := 'rate_t0'; fu1 := 'rate_d2'; fu1_at := interval '2 days';
    fu2 := 'rate_d5'; fu2_at := interval '5 days';
  elsif new.intake is not null
     or new.source ~* 'start|get started|migrate|intake|application' then
    t0 := 'app_t0'; fu1 := 'app_d1'; fu1_at := interval '1 day';
    fu2 := 'app_d4'; fu2_at := interval '4 days';
  else
    t0 := 'call_t0'; fu1 := 'call_d2'; fu1_at := interval '2 days';
    fu2 := 'call_d6'; fu2_at := interval '6 days';
  end if;

  -- instant founder email
  perform net.http_post(
    url := 'https://poxlczzkpztmoiixyrth.supabase.co/functions/v1/lead-emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', '<WEBHOOK_SECRET — redacted; value lives in the database function and Netlify env>'
    ),
    body := jsonb_build_object('record', to_jsonb(new), 'template', t0),
    timeout_milliseconds := 5000
  );

  -- queue the follow-up sequence
  insert into public.sequence_queue (lead_id, template, send_at) values
    (new.id, fu1, now() + fu1_at),
    (new.id, fu2, now() + fu2_at);

  return new;
end;
$$;

-- replaces the rate-card-only email trigger
drop trigger if exists trg_send_rate_card on public.leads;
drop trigger if exists trg_lead_email_kickoff on public.leads;
create trigger trg_lead_email_kickoff
  after insert on public.leads
  for each row execute function public.lead_email_kickoff();

-- cron: drain due follow-ups every 30 minutes
create extension if not exists pg_cron;
select cron.schedule(
  'shipbay-run-sequences',
  '*/30 * * * *',
  $$select net.http_post(
      url := 'https://poxlczzkpztmoiixyrth.supabase.co/functions/v1/lead-emails',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', '<WEBHOOK_SECRET — redacted; value lives in the database function and Netlify env>'
      ),
      body := jsonb_build_object('run_due', true),
      timeout_milliseconds := 15000
    )$$
);
