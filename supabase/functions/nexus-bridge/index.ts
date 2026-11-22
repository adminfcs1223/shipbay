// Edge Function "nexus-bridge": the thin host around core.js. NOT DEPLOYED ANYWHERE. Deploy with verify_jwt on.
// Every decision is in core.js, calendar.js and pallets.js, which are tested under Node; this file only wires them to Deno.
import { makeBridge } from './core.js';
import { calendarRoutes } from './calendar.js';
import { palletRoutes } from './pallets.js';
import { postgrest } from './postgrest.js';

const env = Deno.env.toObject();
const handle = makeBridge({
  env, fetchImpl: fetch, routes: [...calendarRoutes, ...palletRoutes],
  db: postgrest({ url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY }),
});
Deno.serve(handle);
