-- Power enrollment is gated on the rep's click, not on the dial result alone.
-- Debrief quick path (no answer / voicemail): "2 · Send the email?" → sales_calls.email_result = 'send' | 'skip'.
-- 'send' queues the lead for the Power sequence (sequence='power', enroll_at=now()); 'skip' leaves it alone.
-- Replaces trg_queue_power_on_no_answer, which queued every no-answer whether or not the rep wanted the email out.

create or replace function public.trg_queue_power_on_no_answer()
returns trigger
language plpgsql
as $$
begin
  if coalesce(new.email_result, '') = 'send'
     and regexp_replace(lower(coalesce(new.dial_result, new.outcome, '')), '[^a-z]', '', 'g') in ('noanswer', 'voicemail') then
    update sales_leads l
       set sequence = 'power',
           enroll_at = now(),
           first_email_at = coalesce(l.first_email_at, now())
     where l.id = new.lead_id
       and coalesce(l.source, '') not in ('agency', 'fulfill', 'fulfilment')   -- third-party leads are Blitz, never Power
       and l.sequence is null
       and l.power_enrolled_at is null
       and coalesce(l.stage, 'new') not in ('replied', 'call_booked', 'won', 'dnc', 'lost', 'signed');
  end if;
  return new;
end $$;

drop trigger if exists queue_power_on_no_answer on public.sales_calls;
create trigger queue_power_on_no_answer
  after insert or update of outcome, dial_result, email_result on public.sales_calls
  for each row execute function public.trg_queue_power_on_no_answer();
