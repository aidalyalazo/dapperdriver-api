# DapperDriver Try-On — Operations Runbook

**Decision in effect: Decision A** — normal orders AND try-on sessions share the same `inventory_holds` table and `fn_reserve_for_order`/`fn_reserve_items` functions. Holds are placed before any Stripe PaymentIntent is created.

---

## Architecture Summary

| Layer | What it does |
|---|---|
| `inventory_holds` table | Single source of truth for stock reservations. `available = products.stock − SUM(active holds)`. |
| `fn_reserve_for_order(order_id, product_ids)` | Atomic (FOR UPDATE): checks availability, inserts holds OR cancels the order — in one DB transaction. No PI created on failure. |
| `fn_reserve_items(ref_id, product_ids, hold_type)` | Atomic: same lock, used by try-on bookings. |
| `orders_holds_enabled` flag | Set `{"enabled": false}` in `platform_settings` to disable the order-path hold check without a redeploy. |
| `try_on_feature_enabled` flag | Set `{"enabled": false}` to stop new try-on bookings instantly. In-flight sessions are NOT affected. |
| `try_on_enabled_cities` | Array of city_ids where try-on is live. Add Chicago's city_id to launch. |

---

## Pausing the feature

**Pause try-on immediately (no redeploy):**
```sql
UPDATE platform_settings
SET value = '{"enabled": false}'
WHERE key = 'try_on_feature_enabled';
```

**Pause order-path hold check (fall back to pre-Decision-A behavior):**
```sql
UPDATE platform_settings
SET value = '{"enabled": false}'
WHERE key = 'orders_holds_enabled';
```

**Re-enable:**
```sql
UPDATE platform_settings SET value = '{"enabled": true}'
WHERE key IN ('try_on_feature_enabled', 'orders_holds_enabled');
```

> Note: `platformSettings.js` caches values for 5 minutes. Changes take effect within 5 min without restart, or instantly after calling `invalidateSetting(key)`.

---

## Releasing stuck holds

**Find all active holds:**
```sql
SELECT h.id, h.product_id, h.hold_type, h.session_id, h.order_id,
       h.status, h.created_at, h.expires_at,
       p.name AS product_name
FROM inventory_holds h
JOIN products p ON p.id = h.product_id
WHERE h.status = 'active'
ORDER BY h.created_at;
```

**Release holds for a specific session:**
```sql
UPDATE inventory_holds
SET status = 'released'
WHERE session_id = '<session-id>' AND status = 'active';
```

**Release holds for a specific order:**
```sql
UPDATE inventory_holds
SET status = 'released'
WHERE order_id = '<order-id>' AND status = 'active';
```

**Nuclear: release ALL active holds (use only in emergency):**
```sql
UPDATE inventory_holds SET status = 'released' WHERE status = 'active';
```

---

## Manually completing a stuck session

Sessions stuck in `returning` > 4h are auto-completed by `tryOnSessionTimeoutProcessor`. To do it manually:

```sql
UPDATE try_on_sessions
SET status = 'completed',
    driver_return_at = now(),
    updated_at = now()
WHERE id = '<session-id>'
  AND status = 'returning';

-- Release any remaining active holds
UPDATE inventory_holds
SET status = 'released'
WHERE session_id = '<session-id>' AND status = 'active';
```

---

## Launching in Chicago

1. Find Chicago's city_id:
   ```sql
   SELECT id FROM cities WHERE name ILIKE '%chicago%';
   ```

2. Add it to the enabled cities list:
   ```sql
   UPDATE platform_settings
   SET value = '{"city_ids": ["<chicago-city-id>"]}'
   WHERE key = 'try_on_enabled_cities';
   ```

3. Enroll founding boutiques via the admin API:
   ```
   PATCH /api/v1/try-on/admin/boutiques/:id/enroll
   Body: { "enabled": true, "founding_partner": true }
   ```

4. Verify eligibility check passes:
   ```
   GET /api/v1/try-on/eligibility?city_id=<chicago-id>&cart_value_cents=25000&product_count=2
   ```
   Should return `{ "eligible": true, "reasons": [] }`.

---

## Cron jobs

| Job | Schedule | What it does |
|---|---|---|
| `tryOnHoldExpiryProcessor` | Every 5 min | Releases holds past `expires_at` or whose session is terminal |
| `tryOnSessionTimeoutProcessor` | Every 1 min | Cancels no-show sessions (>2h), force-ends overtime in-home (>45min) |
| `tryOnReminderProcessor` | Every 5 min | Sends 24h / 2h / 30min pre-session notifications |
| `tryOnQueueExpiryProcessor` | Every 1 min | Expires queue offers past `claim_deadline`; expires old waiting entries |
| `tryOnCircuitBreakerJob` | Hourly | Computes buy/damage/driver rates; pauses feature if thresholds breached |

---

## Circuit breaker thresholds (adjustable in platform_settings)

| Key | Default | Meaning |
|---|---|---|
| `try_on_circuit_buy_rate_min_pct` | 25% | Pause if <25% of sessions result in a keep |
| `try_on_circuit_damage_rate_max_pct` | 10% | Pause if >10% of sessions have damage |
| `try_on_circuit_driver_acceptance_min_pct` | 70% | Pause if drivers accept <70% of jobs |
| `try_on_circuit_boutique_issues_max_per_week` | 2 | Flag boutique if they cancel >2 sessions/week |

The circuit breaker requires a minimum of 10 completed sessions before activating.

---

## Concurrency test

Run before enabling `orders_holds_enabled` in production:

```bash
node src/tests/inventory_holds_concurrency.test.js
```

Should output: `✅ All races resolved correctly — no double allocation detected.`

---

## Key environment variables

| Var | Required for |
|---|---|
| `STRIPE_SECRET_KEY` | Fee PI creation/capture |
| `SUPABASE_SERVICE_ROLE_KEY` | All DB writes (bypasses RLS) |
| `SUPABASE_STORAGE_BUCKET_TRY_ON_PHOTOS` | Photo uploads (set to `boutique-assets`) |

