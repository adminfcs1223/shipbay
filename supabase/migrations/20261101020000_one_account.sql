-- One profile per account. Whatever channel first sees a company (cold list, blast reply, website form, Gmail,
-- a quote, onboarding) creates or finds the single sales_leads row; quotes, the client org, calls, emails and
-- meetings all hang off it. Plus a merge for the duplicates that already slipped in.

alter table sales_leads add column if not exists org_id uuid references orgs(id) on delete set null;
create index if not exists sales_leads_org on sales_leads (org_id);
alter table quotes add column if not exists lead_id uuid references sales_leads(id) on delete set null;
create index if not exists quotes_lead on quotes (lead_id);
alter table leads add column if not exists sales_lead_id uuid references sales_leads(id) on delete set null;

-- "Steel Horse Leather Co." ≈ "steel horse leather" ≈ "Steel-Horse Leather LLC"
create or replace function norm_co(t text) returns text immutable language sql as $$
  select rtrim(regexp_replace(regexp_replace(lower(coalesce(t, '')), '\m(the|llc|inc|co|company|corp|corporation|ltd|limited|store|shop|official)\M', '', 'g'), '[^a-z0-9]', '', 'g'), 's')
$$;
create or replace function mail_domain(e text) returns text immutable language sql as $$
  select case when e ~ '@' and split_part(lower(e), '@', 2) !~ '^(gmail|yahoo|hotmail|outlook|icloud|aol|proton|protonmail|me|live|msn)\.' then split_part(lower(e), '@', 2) end
$$;
create index if not exists sales_leads_norm_co on sales_leads (norm_co(company));

/** the one account row for this email / website / company, if we already have it */
create or replace function find_lead(p_email text, p_domain text, p_company text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from sales_leads
  where (nullif(lower(p_email), '') is not null and lower(email) = lower(p_email))
     or (nullif(lower(coalesce(p_domain, mail_domain(p_email))), '') is not null and lower(domain) = lower(coalesce(nullif(p_domain, ''), mail_domain(p_email))))
     or (length(norm_co(p_company)) >= 4 and norm_co(company) = norm_co(p_company))
  order by (lower(email) = lower(p_email)) desc, (lower(domain) = lower(coalesce(nullif(p_domain, ''), mail_domain(p_email)))) desc,
           (org_id is not null) desc, (stage = 'signed') desc, created_at
  limit 1
$$;
revoke execute on function find_lead(text, text, text) from public, anon;
grant execute on function find_lead(text, text, text) to authenticated;

create or replace function stage_rank(s text) returns int immutable language sql as $$
  select case s when 'dnc' then 90 when 'signed' then 80 when 'quoted' then 50 when 'call_booked' then 40 when 'replied' then 30 when 'contacted' then 20 when 'new' then 10 when 'lost' then 5 else 0 end
$$;

/** fold duplicate rows into one: history moves over, blanks fill in, the furthest stage wins, the rest are deleted */
create or replace function merge_leads(p_keep uuid, p_drop uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare k sales_leads%rowtype; d sales_leads%rowtype; best text; notes_all text;
begin
  if not is_shipbay() then raise exception 'not authorized'; end if;
  select * into k from sales_leads where id = p_keep; if k.id is null then raise exception 'keep row not found'; end if;
  p_drop := array_remove(p_drop, p_keep); if coalesce(array_length(p_drop, 1), 0) = 0 then return; end if;
  update sales_calls set lead_id = p_keep where lead_id = any(p_drop);
  update sales_email_sends set lead_id = p_keep where lead_id = any(p_drop);
  update sales_touches set lead_id = p_keep where lead_id = any(p_drop);
  update sales_meetings set lead_id = p_keep where lead_id = any(p_drop);
  update gmail_messages set lead_id = p_keep where lead_id = any(p_drop);
  update quotes set lead_id = p_keep where lead_id = any(p_drop);
  update leads set sales_lead_id = p_keep where sales_lead_id = any(p_drop);
  best := k.stage; notes_all := coalesce(k.notes, '');
  for d in select * from sales_leads where id = any(p_drop) order by created_at loop
    if stage_rank(d.stage) > stage_rank(best) then best := d.stage; end if;
    if coalesce(d.notes, '') <> '' and position(d.notes in notes_all) = 0 then notes_all := nullif(notes_all, '') || case when notes_all = '' then '' else E'\n' end || d.notes; end if;
    update sales_leads set
      email = coalesce(nullif(email, ''), d.email), phone = coalesce(nullif(phone, ''), d.phone), contact_name = coalesce(nullif(contact_name, ''), d.contact_name),
      domain = coalesce(nullif(domain, ''), d.domain), title = coalesce(nullif(title, ''), d.title), city = coalesce(nullif(city, ''), d.city), state = coalesce(nullif(state, ''), d.state),
      est_sales_usd = coalesce(est_sales_usd, d.est_sales_usd), deal_value = coalesce(deal_value, d.deal_value), filter_id = coalesce(filter_id, d.filter_id),
      org_id = coalesce(org_id, d.org_id), assigned_to = coalesce(assigned_to, d.assigned_to), answered_at = coalesce(answered_at, d.answered_at), won_at = coalesce(won_at, d.won_at),
      last_touch_at = greatest(last_touch_at, d.last_touch_at), in_email = in_email or d.in_email
    where id = p_keep;
  end loop;
  update sales_leads set stage = best, notes = nullif(notes_all, '') where id = p_keep;
  delete from sales_leads where id = any(p_drop);
end $$;
revoke execute on function merge_leads(uuid, uuid[]) from public, anon;
grant execute on function merge_leads(uuid, uuid[]) to authenticated;

/** mark an account Won: the client org is created (or linked), the quote follows, the rep keeps it */
create or replace function win_lead(p_lead_id uuid, p_deal_value numeric default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare l sales_leads%rowtype; v_org uuid; v_slug text; n int := 0;
begin
  if not is_shipbay() then raise exception 'not authorized'; end if;
  select * into l from sales_leads where id = p_lead_id; if l.id is null then raise exception 'lead not found'; end if;
  v_org := l.org_id;
  if v_org is null then
    select id into v_org from orgs where (nullif(lower(l.email), '') is not null and lower(contact_email) = lower(l.email)) or (length(norm_co(l.company)) >= 4 and norm_co(name) = norm_co(l.company)) order by created_at limit 1;
  end if;
  if v_org is null then
    v_slug := regexp_replace(lower(coalesce(nullif(l.company, ''), l.domain, l.email)), '[^a-z0-9]+', '-', 'g');
    while exists (select 1 from orgs where slug = case when n = 0 then v_slug else v_slug || '-' || n end) loop n := n + 1; end loop;
    if n > 0 then v_slug := v_slug || '-' || n; end if;
    insert into orgs (name, slug, contact_name, contact_email, contact_phone, sales_rep_id, notes)
      values (coalesce(nullif(l.company, ''), l.domain, l.email), v_slug, nullif(l.contact_name, ''), nullif(l.email, ''), nullif(l.phone, ''), l.assigned_to, 'Won in Sales (' || l.source || ')')
      returning id into v_org;
    insert into rate_cards (org_id, label) values (v_org, 'Standard (<1,000 orders/mo)');
  end if;
  update sales_leads set org_id = v_org, stage = 'signed', won_at = coalesce(won_at, now()), deal_value = coalesce(p_deal_value, deal_value), last_touch_at = now(), assigned_to = coalesce(assigned_to, auth.uid()) where id = l.id;
  update orgs set sales_rep_id = coalesce(sales_rep_id, l.assigned_to, auth.uid()) where id = v_org;
  update quotes set org_id = v_org where lead_id = l.id and org_id is null;
  return v_org;
end $$;
revoke execute on function win_lead(uuid, numeric) from public, anon;
grant execute on function win_lead(uuid, numeric) to authenticated;

-- a client org created any other way (Onboarding → Start onboarding) still gets its one account row
create or replace function orgs_link_account() returns trigger language plpgsql security definer set search_path = public as $$
declare v_lead uuid;
begin
  v_lead := find_lead(new.contact_email, null, new.name);
  if v_lead is null then
    insert into sales_leads (company, contact_name, email, phone, domain, source, stage, won_at, org_id, assigned_to, last_touch_at, notes)
      values (new.name, new.contact_name, new.contact_email, new.contact_phone, mail_domain(new.contact_email), 'other', 'signed', now(), new.id, new.sales_rep_id, now(), 'Created as a client directly.')
      returning id into v_lead;
  else
    update sales_leads set org_id = coalesce(org_id, new.id), stage = case when stage = 'dnc' then stage else 'signed' end, won_at = coalesce(won_at, now()),
      email = coalesce(nullif(email, ''), new.contact_email), contact_name = coalesce(nullif(contact_name, ''), new.contact_name), phone = coalesce(nullif(phone, ''), new.contact_phone),
      assigned_to = coalesce(assigned_to, new.sales_rep_id), last_touch_at = now() where id = v_lead;
  end if;
  update orgs o set sales_rep_id = coalesce(o.sales_rep_id, s.assigned_to) from sales_leads s where o.id = new.id and s.id = v_lead;
  update quotes set org_id = new.id where lead_id = v_lead and org_id is null;
  return new;
end $$;
drop trigger if exists orgs_link_account on orgs;
create trigger orgs_link_account after insert on orgs for each row execute function orgs_link_account();
revoke execute on function orgs_link_account() from public, anon, authenticated;

-- a website form submission lands in the CRM as an inbound lead (or wakes up the existing account)
create or replace function leads_to_account() returns trigger language plpgsql security definer set search_path = public as $$
declare v_lead uuid; v_notes text;
begin
  v_notes := concat_ws(E'\n', nullif('Volume: ' || coalesce(new.volume, ''), 'Volume: '), nullif('Current setup: ' || coalesce(new.current_setup, ''), 'Current setup: '), nullif(new.notes, ''));
  v_lead := find_lead(new.email, null, coalesce(new.brand, new.name));
  if v_lead is null then
    insert into sales_leads (company, contact_name, email, phone, domain, source, stage, last_touch_at, notes)
      values (coalesce(nullif(new.brand, ''), new.name, new.email), new.name, new.email, new.phone, mail_domain(new.email), 'inbound', 'new', now(), nullif('Website form (' || coalesce(new.source, 'site') || E')\n' || v_notes, 'Website form (site)' || E'\n'))
      returning id into v_lead;
  else
    update sales_leads set stage = case when stage in ('new', 'contacted') then 'replied' else stage end, last_touch_at = now(),
      email = coalesce(nullif(email, ''), new.email), phone = coalesce(nullif(phone, ''), new.phone), contact_name = coalesce(nullif(contact_name, ''), new.name),
      notes = concat_ws(E'\n', nullif(notes, ''), 'Website form ' || to_char(now(), 'Mon DD') || case when v_notes <> '' then ': ' || v_notes else '' end)
      where id = v_lead;
  end if;
  update leads set sales_lead_id = v_lead where id = new.id;
  return new;
end $$;
drop trigger if exists leads_to_account on leads;
create trigger leads_to_account after insert on leads for each row execute function leads_to_account();
revoke execute on function leads_to_account() from public, anon, authenticated;

-- a quote always belongs to an account; sending it moves the account to Quoted
create or replace function quotes_link_account() returns trigger language plpgsql security definer set search_path = public as $$
declare v_lead uuid; l sales_leads%rowtype;
begin
  if new.lead_id is null then
    v_lead := find_lead(new.contact_email, null, new.company);
    if v_lead is null then
      insert into sales_leads (company, contact_name, email, phone, domain, source, stage, assigned_to, last_touch_at, notes)
        values (new.company, new.contact_name, new.contact_email, new.contact_phone, mail_domain(new.contact_email), 'other', 'quoted', coalesce(new.created_by, auth.uid()), now(), 'Started from a quote.')
        returning id into v_lead;
    end if;
    new.lead_id := v_lead;
  end if;
  select * into l from sales_leads where id = new.lead_id;
  if new.org_id is null and l.org_id is not null then new.org_id := l.org_id; end if;
  if new.org_id is not null and l.org_id is null then update sales_leads set org_id = new.org_id where id = l.id; end if;
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    if new.status in ('sent', 'accepted') and stage_rank(l.stage) < stage_rank('quoted') then update sales_leads set stage = 'quoted', last_touch_at = now() where id = l.id; end if;
  end if;
  return new;
end $$;
drop trigger if exists quotes_link_account on quotes;
create trigger quotes_link_account before insert or update on quotes for each row execute function quotes_link_account();
revoke execute on function quotes_link_account() from public, anon, authenticated;

-- ===== backfill: fold the duplicates that already exist, tie clients + quotes to their one row =====
-- staff ids: Derek 2ad97f56-03f5-453b-99a0-5b7523ef5c8a · Xavier 740c00d8-9056-49de-9649-4f23f01ffda5
update orgs set sales_rep_id = '2ad97f56-03f5-453b-99a0-5b7523ef5c8a' where sales_rep_id is null or sales_rep_id not in (select id from profiles);
update orgs set sales_rep_id = '740c00d8-9056-49de-9649-4f23f01ffda5' where lower(name) like 'souled%';
do $$ declare keep uuid; begin
  -- Steel Horse Leather: keep the live row, fold the empty agency row into it
  select id into keep from sales_leads where norm_co(company) = norm_co('Steel Horse Leather') order by (email <> '') desc, created_at limit 1;
  if keep is not null then
    perform merge_leads(keep, array(select id from sales_leads where norm_co(company) = norm_co('Steel Horse Leather') and id <> keep));
    update sales_leads set email = 'dave@steelhorseleather.com', domain = 'steelhorseleather.com', phone = coalesce(nullif(phone, ''), '(718) 218-3161'), contact_name = 'David', org_id = 'a1b2c3d4-0000-4000-8000-000000000001', stage = 'signed', won_at = coalesce(won_at, '2026-10-16'), assigned_to = coalesce(assigned_to, '2ad97f56-03f5-453b-99a0-5b7523ef5c8a'),
      notes = concat_ws(E'\n', nullif(notes, ''), 'Also writes from steelhorseleatherco@gmail.com') where id = keep;
    update quotes set lead_id = keep where norm_co(company) = norm_co('Steel Horse Leather');
    update leads set sales_lead_id = keep where norm_co(coalesce(brand, name)) = norm_co('Steel Horse Leather');
    update gmail_messages set lead_id = keep where lower(from_email) in ('dave@steelhorseleather.com', 'steelhorseleatherco@gmail.com') or lower(to_email) like '%steelhorseleather%';
  end if;
  -- Vinyl Moon: one row, tied to the Vinyl Moons org and both quotes
  select id into keep from sales_leads where norm_co(company) = norm_co('Vinyl Moon') or lower(domain) = 'vinylmoon.co' or lower(email) = 'hello@vinylmoon.co' order by created_at limit 1;
  if keep is not null then
    perform merge_leads(keep, array(select id from sales_leads where (norm_co(company) = norm_co('Vinyl Moon') or lower(domain) = 'vinylmoon.co' or lower(email) = 'hello@vinylmoon.co') and id <> keep));
    update sales_leads set company = 'Vinyl Moon', contact_name = 'Brandon Bogajewicz', org_id = 'b00c40ce-d8b1-4166-b148-54c10b857c88', stage = 'signed', won_at = coalesce(won_at, '2026-10-31'), assigned_to = coalesce(assigned_to, '2ad97f56-03f5-453b-99a0-5b7523ef5c8a') where id = keep;
    update quotes set lead_id = keep, org_id = 'b00c40ce-d8b1-4166-b148-54c10b857c88' where norm_co(company) = norm_co('Vinyl Moon');
    update gmail_messages set lead_id = keep where lower(from_email) like '%@vinylmoon.co' or lower(to_email) like '%@vinylmoon.co';
  end if;
end $$;
-- every other quote without an account gets one (the trigger does the matching)
update quotes set lead_id = null where lead_id is null;
-- real website submissions join the CRM (test entries from our own domains stay out)
do $$ declare r record; v_lead uuid; begin
  for r in select * from leads where sales_lead_id is null and email ~ '^[^@]+@[^@]+\.[a-z]{2,}$' and split_part(lower(email), '@', 2) not in ('shiphl.com', 'shipbay3pl.com', 'harrison-lewis.com', 'fcsshipping.com', 'example.com', 'test.com') and length(coalesce(brand, name, '')) >= 3 loop
    v_lead := find_lead(r.email, null, coalesce(r.brand, r.name));
    if v_lead is null then
      insert into sales_leads (company, contact_name, email, phone, domain, source, stage, last_touch_at, notes, created_at)
        values (coalesce(nullif(r.brand, ''), r.name), r.name, r.email, r.phone, mail_domain(r.email), 'inbound', case when r.stage in ('new','contacted','replied','call_booked','quoted','lost') then r.stage else 'new' end, r.created_at, concat_ws(E'\n', 'Website form', nullif('Volume: ' || coalesce(r.volume, ''), 'Volume: '), nullif('Current setup: ' || coalesce(r.current_setup, ''), 'Current setup: '), nullif(r.notes, '')), r.created_at)
        returning id into v_lead;
    end if;
    update leads set sales_lead_id = v_lead where id = r.id;
  end loop;
end $$;
