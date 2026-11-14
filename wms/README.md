# ShipBay WMS

wms.shipbay3pl.com. Warehouse management for every brand in the building; shares the Supabase project and the staff
logins with the dashboard (`portal/`), so what the floor records here is what a brand sees in its portal.

- Netlify project `shipbay-wms`: base directory `wms`, custom domain `wms.shipbay3pl.com`. The public Supabase URL and
  key are in `netlify.toml`.
- Step 1 (2026-11-13): receiving station + pallet register. Table `wms_pallets`, functions `wms_receive_pallets`,
  `wms_mark_printed`, `wms_void_pallet` (migration `20261113210000_wms_pallets.sql`).
- Check the UI: `VITE_SUPABASE_URL=https://stub.supabase.co VITE_SUPABASE_KEY=stub npx vite build && node preview-wms.cjs out`
  (screens with sample data + `labels.pdf`, the 4x6 labels exactly as they print).
