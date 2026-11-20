# WMS receiving graft on the deployed WMS (dc024b2) — candidate, not released

Branch `graft/wms-receiving-dc024b2` from `dc024b2b7ac44120f7d7e8a9d7f17c159b31e9ce`. Portal: unchanged (no portal file).

App files (WMS only): `wms/src/Receive.jsx` (booking select, partial / HOLD / last-of-booking, booked "Did it go through?"),
`wms/src/cartons.js` (`lookupBookedReceipt`), `wms/src/bookingProgress.js` (progress text), `wms/src/wms.css` (booking styles).
Unbooked receiving, retry, printing, scanning, login and navigation code paths are unchanged; with no booking chosen (or no
booking functions on the database) the screen behaves exactly as dc024b2.

Database: `20261123_wms_booking_receiving.sql` (one file; production `wms_receive` and `generate_invoice` untouched).
Fix-forward: `.disable.sql` (booked route off, every record and the HOLD gate kept) / `.enable.sql`.
Full rollback: `.rollback.sql` (refuses while any booked receipt or HOLD exists).

Release order: 1) database candidate; 2) WMS build. Either order is safe: a WMS without the database functions hides the
booking list; the database functions are unused until the WMS shows them. Back out: WMS build of dc024b2 (the current
deploy), then `.disable.sql`; full rollback only if the route was never used.

Test-only additions: `supabase/tests/staging/*` (guard, loader, shim, `wms-graft.test.mjs`), `supabase/tests/db/package*.json`,
`wms/test/booking-e2e/*`, `wms/test/cartons.test.mjs` (3 lookup tests).
