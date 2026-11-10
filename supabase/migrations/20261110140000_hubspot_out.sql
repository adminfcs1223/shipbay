-- HubSpot out of the portal (Derek, 2026-11-10). Reversible: jobs set inactive, trigger disabled, nothing dropped.
-- Applied live via execute_sql the same day.
select cron.alter_job(4, active := false);   -- shipbay-power-enroll (HubSpot Sequences enrollment)
select cron.alter_job(6, active := false);   -- shipbay-make-blitz-v3 (Make contacts → Blitz v2 in HubSpot)
alter table public.leads disable trigger trg_sync_lead_hubspot;   -- site forms no longer pushed to HubSpot
