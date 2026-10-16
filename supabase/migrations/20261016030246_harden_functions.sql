-- Portal RPCs: only signed-in users may call; staff checks happen inside
revoke execute on function ship_order(uuid,text,text,text,text,numeric,text,numeric) from public, anon;
revoke execute on function receive_inbound(uuid,jsonb) from public, anon;
revoke execute on function generate_invoice(uuid,date) from public, anon;
revoke execute on function convert_lead(uuid,text) from public, anon;
revoke execute on function snapshot_storage(uuid,int,int,int,text) from public, anon;
revoke execute on function is_shipbay() from public, anon;
revoke execute on function current_org_id() from public, anon;
-- Trigger functions: never callable via API
revoke execute on function handle_new_user() from public, anon, authenticated;
revoke execute on function log_status_event() from public, anon, authenticated;
revoke execute on function touch_updated_at() from public, anon, authenticated;
revoke execute on function set_order_cutoff() from public, anon, authenticated;
revoke execute on function guard_receiving_waived() from public, anon, authenticated;

-- Pin search_path
alter function touch_updated_at() set search_path = public;
alter function set_order_cutoff() set search_path = public;
alter function guard_receiving_waived() set search_path = public;

-- Leftover test helper: make inert (cannot be dropped through this connector)
create or replace function _impersonate(p_email text) returns void language plpgsql set search_path = public as $$
begin raise exception 'disabled'; end $$;
revoke execute on function _impersonate(text) from public, anon, authenticated;

-- Secrets table + website-internal tables: explicit deny-all for API roles (RLS with no policies already denies; this documents intent)
comment on table org_integrations is 'Shopify tokens. No RLS policies on purpose: only service-role edge functions read this.';
