# Inventory Integrations — turn-on guide

The integration **code is launch-safe** (signed OAuth state, manual-product
de-duplication, merge tools). To actually let boutiques connect a store, set the
platform credentials below in **Railway → Variables**. Until a platform's keys
are set, its "Connect" button just fails gracefully — nothing breaks.

## Required environment variables (Railway)

**Shared**
| Var | Purpose |
|---|---|
| `API_BASE_URL` | Public API URL, e.g. `https://dapperdriver-api-production.up.railway.app` — used to build each platform's OAuth `redirect_uri`. Must match the redirect URI registered in each platform's app settings. |
| `INTEGRATION_STATE_SECRET` | Dedicated HMAC key for signing the OAuth `state`. Any long random string. Falls back to the service-role key if unset (works, but a dedicated key is cleaner). |
| `APP_DEEP_LINK` | Deep link back into the app after connecting, e.g. `dapperdriver://`. |

**Shopify** — create a custom app at partners.shopify.com
| Var | From |
|---|---|
| `SHOPIFY_API_KEY` | App credentials |
| `SHOPIFY_API_SECRET` | App credentials (also used to verify the callback HMAC) |
> Register redirect URL: `${API_BASE_URL}/api/v1/integrations/shopify/callback`

**Square** — create an app at developer.squareup.com
| Var | From |
|---|---|
| `SQUARE_APP_ID` | App credentials |
| `SQUARE_APP_SECRET` | App credentials |
> Redirect URL: `${API_BASE_URL}/api/v1/integrations/square/callback`

**Lightspeed Retail (R-Series)** — apps at developers.lightspeedhq.com
| Var | From |
|---|---|
| `LIGHTSPEED_CLIENT_ID` | App credentials |
| `LIGHTSPEED_CLIENT_SECRET` | App credentials |
> Redirect URL: `${API_BASE_URL}/api/v1/integrations/lightspeed/callback`

## How duplicates are handled (your question)
- Manual products are **never** deleted or overwritten by a sync.
- On sync, an item with no existing mapping **adopts** a matching manual product
  (exact SKU, else exact name) instead of creating a second listing — it links
  the manual row to the integration and keeps its stock in sync.
- Anything the exact-match adopt misses (e.g. "Silk Blouse" vs "Silk blouse,
  navy") shows up under **Boutique portal → Integrations → Review Duplicates**,
  where the owner taps "Keep this" on one and the rest are hidden.

## Token encryption at rest — DONE ✅
Integration access/refresh tokens are encrypted with **AES-256-GCM**
(`utils/tokenCrypto.js`) on write and decrypted on read. The key derives from
`TOKEN_ENC_KEY` if set, else the service-role key. Legacy plaintext tokens keep
working and re-encrypt on next write (no migration needed).
- **Recommended:** set a dedicated `TOKEN_ENC_KEY` (any long random string) in
  Railway so token encryption doesn't depend on the service-role key. If you set
  it AFTER tokens already exist, reconnect those integrations once so they
  re-encrypt under the new key.

## Later enhancement (not blocking)
- **Webhook-based stock** (vs. polling `Sync Now`) for near-real-time updates.
