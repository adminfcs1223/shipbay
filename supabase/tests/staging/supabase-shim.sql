-- Supabase stand-ins for an isolated local Postgres 17.6. No production data, no secrets.
create role anon nologin noinherit; create role authenticated nologin noinherit; create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit; grant anon, authenticated, service_role to authenticator;
create role supabase_admin nologin;
create schema extensions; create extension pgcrypto schema extensions; create extension "uuid-ossp" schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
alter database staging set search_path = "$user", public, extensions;
create schema auth; grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}', created_at timestamptz default now());
-- same shape as Supabase's helpers: read the request's JWT claims
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt()->>'sub','')::uuid $$;
create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
create function auth.email() returns text language sql stable as $$ select auth.jwt()->>'email' $$;
grant execute on all functions in schema auth to anon, authenticated, service_role;
-- pg_net stand-in: records calls, sends nothing
create schema net; create table net.calls (id bigserial primary key, url text, body jsonb, at timestamptz default now());
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ insert into net.calls(url, body) values (url, body) returning id $$;
create function net.http_get(url text, params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ insert into net.calls(url) values (url) returning id $$;
grant usage on schema net to anon, authenticated, service_role; grant all on all tables in schema net to anon, authenticated, service_role; grant all on all sequences in schema net to anon, authenticated, service_role;
grant execute on all functions in schema net to anon, authenticated, service_role;
create table net._http_response (id bigint primary key, status_code int, content text, created timestamptz default now()); grant all on net._http_response to anon, authenticated, service_role;
