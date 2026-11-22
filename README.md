# ShipBay development preview: Nexus staging (branch `nexus-dev`)

Development only. A separate Netlify site that shows the shared warehouse map and a synthetic shared calendar from
**Nexus staging**, test floor `HILLSBOROUGH-TEST`. It is not connected to ShipBay's database and contains none of
ShipBay's production code, data or settings: this branch has no history in common with `main`.

## What is here
- `netlify/functions/nexus.mjs`: the only code that holds the Nexus key. It offers a fixed list of operations
  (health, map, occupancy, change feed, calendar read, synthetic calendar write and cancel) on one fixed staging host.
  Pallet assign, move and release are refused before anything is sent. It is not a general proxy.
- `public/`: the preview page. It calls `/api/nexus/...` on this site only and holds no Nexus credential.
- `test/`: `function.test.mjs` (runs at every build; a failing test stops the deploy), a stand-in Nexus, and a browser check.

## Server-side secrets (set in Netlify for this site only; never in this repository, a URL or the browser)
| Name | What it is |
| --- | --- |
| `NEXUS_STAGING_API_KEY` | ShipBay's Nexus **staging** key (test floor; read and calendar scopes). |
| `PREVIEW_PASSCODE` | A passphrase of 12 or more characters that people type to open the preview. |

Without both, every operation answers `not_configured` and the page says so.

## Guards
- The Nexus address is written in the function and cannot be changed by a setting or a request.
- Every answer that names a floor must name the test floor; otherwise nothing is shown and nothing is written.
- Calendar writes accept only ids starting `DEV-`; `reference` and `note` are set by the function.
- The function writes nothing to its log.

## Run the tests
    node --test test/function.test.mjs
    PLAYWRIGHT=<path to playwright> CHROME=<path to chrome> node test/preview.e2e.cjs
