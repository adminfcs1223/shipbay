-- Post-call debrief (Derek, 2026-11-02): nine questions after every dial, stored on the call and summarized on the lead,
-- pushed to HubSpot as call + contact properties by the owner function. Connector-safe (additive only).
alter table sales_calls add column if not exists dial_result text;        -- no_answer | voicemail | bad_number | gatekeeper | decision_maker
alter table sales_calls add column if not exists picked_up text;          -- owner_founder | ops | cs | retail_floor
alter table sales_calls add column if not exists fit text;                -- fit | not_fit | unknown
alter table sales_calls add column if not exists not_fit_reason text;     -- on_3pl | ships_own_store | too_small | too_big | product_type | out_of_region | amazon_only | dormant | b2b_only
alter table sales_calls add column if not exists not_fit_detail text;     -- the 3PL name / product type
alter table sales_calls add column if not exists orders_month integer;    -- their actual orders / month, rough
alter table sales_calls add column if not exists current_setup text;      -- self_shipstation | self_shippo | self_pirateship | self_veeqo | self_other | threepl | hybrid | fba
alter table sales_calls add column if not exists pain text;               -- space | time | q4 | cost | moving | none
alter table sales_calls add column if not exists result text;             -- booked | callback | send_info | soft_no | hard_no
alter table sales_calls add column if not exists callback_at timestamptz;
alter table sales_calls add column if not exists hour_block smallint;     -- 0–23, America/New_York, when the dial started
alter table sales_calls add column if not exists email_result text;       -- bounced | replied | nothing (only when hand-emailing)
alter table sales_calls add column if not exists list_id text;            -- the lead's filter_id at the time of the call (lists get re-cut weekly)

alter table sales_leads add column if not exists orders_month_actual integer;
alter table sales_leads add column if not exists current_setup text;
alter table sales_leads add column if not exists pain text;
alter table sales_leads add column if not exists not_fit_reason text;
alter table sales_leads add column if not exists picked_up text;
alter table sales_leads add column if not exists first_email_at timestamptz;   -- first hand email after a cold call
alter table sales_leads add column if not exists blitz_enroll_at timestamptz;  -- when the Blitz should start (first_email_at + 1 day); the enrollment job reads this

create index if not exists sales_calls_list on sales_calls (list_id);
create index if not exists sales_leads_blitz_enroll on sales_leads (blitz_enroll_at) where blitz_enroll_at is not null;

-- hour block in ET for calls logged before this migration
update sales_calls set hour_block = extract(hour from (started_at at time zone 'America/New_York'))::smallint where hour_block is null;
update sales_calls c set list_id = l.filter_id from sales_leads l where c.lead_id = l.id and c.list_id is null;
