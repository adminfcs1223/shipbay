-- email_send_reply_marks_lead: a real reply on a send moves the lead to 'replied' (unless it's already further along).
-- Fix 2026-11-03: the live version filtered on `sales_leads.campaign`, a column that doesn't exist, so every
-- sales_email_sends upsert batch that carried a new reply failed and the reply never reached the portal
-- (34 Smartlead sends from 11-02 midday on were missing, incl. LINHART NYC's 11-03 reply). The HubSpot
-- exclusion belongs on the send's own campaign.
CREATE OR REPLACE FUNCTION public.email_send_reply_marks_lead()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  if new.lead_id is not null and new.replied and coalesce(new.bounced, false) = false and (tg_op = 'INSERT' or old.replied is distinct from new.replied)
     and coalesce(new.reply_type, '') not in ('Bounce-back', 'Out of office', 'OOO') and coalesce(new.campaign, '') not like 'hubspot%' then
    update sales_leads set stage = case when stage in ('new', 'contacted') then 'replied' else stage end,
      answered_at = coalesce(answered_at, coalesce(new.reply_at, new.sent_at)), last_touch_at = greatest(coalesce(last_touch_at, now()), coalesce(new.reply_at, new.sent_at))
      where id = new.lead_id;
  end if;
  return new;
end $function$;

create or replace trigger email_send_reply_marks_lead after insert or update of replied on public.sales_email_sends
  for each row execute function public.email_send_reply_marks_lead();

-- Smartlead has its own schedule (was inside the 3-min owner tick, which then ran past pg_net's 120 s):
-- select cron.schedule('shipbay-smartlead-sync', '*/5 * * * *', $$select net.http_post(url := 'https://poxlczzkpztmoiixyrth.supabase.co/functions/v1/owner', headers := '{"Content-Type":"application/json","x-cron-key":"<CRON_KEY>"}'::jsonb, body := '{"action":"smartlead_sync"}'::jsonb, timeout_milliseconds := 150000)$$);
