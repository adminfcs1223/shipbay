# Real-schema staging (local, free, no production rows)

A local Postgres 17.6 (production's version) rebuilt from a **schema-only** extract of production: 76 tables,
137 functions, 8 views, 45 triggers, 121 RLS policies and the grants, read from the system catalogs only. No table
rows were read. Four hard-coded webhook secrets in function bodies were replaced by `<<REDACTED>>`.

The extract is not in the repo (it is production's exact schema, including staff contact defaults). Rebuild it with
the catalog queries listed in its README, then:

    EXTRACT=/path/to/extract ./load.sh            # 127.0.0.1:54317, database "staging"
    node --test flow.test.mjs                      # synthetic data; refuses any host but 127.0.0.1

`supabase-shim.sql` stands in for what Supabase provides around `public`: the roles (anon, authenticated,
service_role, authenticator), `auth.users` + `auth.uid()/jwt()/role()` reading `request.jwt.claims` the way PostgREST
sets them, `extensions` (pgcrypto, uuid-ossp), and a `net.http_post` that records calls and sends nothing.
Not covered: storage, edge functions, PostgREST itself, `auth` triggers other than `on_auth_user_created`, pg_cron.

`flow.test.mjs` runs receive → scan → count → put-away → pick → pack → dispatch as the real roles on the live
functions (shows the double deduction), applies the candidate, repeats the flow, then runs the rollback.
