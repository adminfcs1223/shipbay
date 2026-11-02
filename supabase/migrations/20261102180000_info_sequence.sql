-- Two ways out of a call (Derek, 11-02 12:22 ET): "Enroll in Power" or "Send info".
-- Send info = one email with the rundown + booking link; no reply in a day → Power. In HubSpot that is its own sequence
-- (info email on day 0, then the five Power emails from day 1), so the enroller needs a kind → sequence id map.

create table if not exists hs_sequences (
  kind        text primary key,            -- power | info | blitz
  sequence_id text,                        -- HubSpot sequence id; null = not built yet, leads wait in the queue
  name        text,
  updated_at  timestamptz default now()
);
insert into hs_sequences (kind, sequence_id, name) values
  ('power', '802246330', 'Power — cold follow-up (CCE no answer · CBE after blast)'),
  ('blitz', '801686244', 'Blitz v2 — purchased leads'),
  ('info',  null,        'Send info — rundown + booking link, then Power')
on conflict (kind) do nothing;

-- trigger: the rep's answer on the call decides the sequence
create or replace function public.trg_queue_power_on_no_answer()
returns trigger
language plpgsql
as $$
declare want text;
begin
  want := case coalesce(new.email_result, '') when 'send' then 'power' when 'power' then 'power' when 'info' then 'info' else null end;
  if want is not null then
    update sales_leads l
       set sequence = want,
           enroll_at = now(),
           first_email_at = coalesce(l.first_email_at, now())
     where l.id = new.lead_id
       and coalesce(l.source, '') not in ('agency', 'fulfill', 'fulfilment')
       and l.sequence is null
       and l.power_enrolled_at is null
       and coalesce(l.stage, 'new') not in ('replied', 'call_booked', 'won', 'dnc', 'lost', 'signed');
  end if;
  return new;
end $$;

-- enroller: same loop, sequence id from the map; a kind with no id yet is skipped (stays queued, no error)
create or replace function public.hs_enroll_due()
returns integer
language plpgsql
security definer
as $$
declare r record; n int := 0; tok text; rid bigint; seq_id text;
begin
  select value into tok from platform_secrets where key='HUBSPOT_TOKEN';
  for r in select l.id, l.hs_contact_id, l.sequence, s.sequence_id from sales_leads l
           join hs_sequences s on s.kind = l.sequence and s.sequence_id is not null
           where l.sequence in ('power', 'info') and l.enroll_at <= now() and l.power_enrolled_at is null and l.hs_contact_id is not null
             and not exists (select 1 from hs_sequence_enrollments e where e.lead_id=l.id and e.done_at is null)
             and (select count(*) from hs_sequence_enrollments e where e.lead_id=l.id and e.error is not null) < 20
           limit 50
  loop
    seq_id := r.sequence_id;
    rid := net.http_post('https://api.hubapi.com/automation/v4/sequences/enrollments?userId=98126585',
      jsonb_build_object('sequenceId', seq_id, 'contactId', r.hs_contact_id, 'senderEmail', 'derekh@shipbay3pl.com'),
      '{}'::jsonb, jsonb_build_object('Authorization','Bearer '||tok,'Content-Type','application/json'), 15000);
    insert into hs_sequence_enrollments(lead_id, hs_contact_id, sequence, sequence_id, rid, sent_at) values (r.id, r.hs_contact_id, r.sequence, seq_id, rid, now());
    n := n+1;
  end loop;
  return n;
end $$;
