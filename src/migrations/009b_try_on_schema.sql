-- ============================================================================
-- 009b — Full Try-On schema (Phase 1)
-- Additive only. Runs AFTER 009a (inventory_holds must already exist).
-- ============================================================================

-- ── 1. Slots — time windows a boutique releases ───────────────────────────────

CREATE TABLE IF NOT EXISTS try_on_boutique_slots (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  boutique_id          UUID        NOT NULL REFERENCES boutiques(id) ON DELETE CASCADE,
  scheduled_at         TIMESTAMPTZ NOT NULL,
  duration_minutes     INT         NOT NULL DEFAULT 90,
  status               TEXT        NOT NULL DEFAULT 'available',
    -- 'available' | 'claimed' | 'reserved' | 'expired' | 'blocked'
  reserved_for_session UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(boutique_id, scheduled_at)
);

CREATE INDEX IF NOT EXISTS idx_try_on_slots_boutique_scheduled
  ON try_on_boutique_slots(boutique_id, scheduled_at)
  WHERE status IN ('available', 'claimed', 'reserved');

ALTER TABLE try_on_boutique_slots ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read slots (needed for shopper browse)
CREATE POLICY "try_on_slots_read_auth"
  ON try_on_boutique_slots FOR SELECT
  USING (auth.role() = 'authenticated');

-- Boutique owner can write their own slots
CREATE POLICY "try_on_slots_boutique_write"
  ON try_on_boutique_slots FOR ALL
  USING (boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid()));

-- ── 2. Queue ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS try_on_queue (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id      UUID        NOT NULL REFERENCES auth.users(id),
  boutique_id     UUID        NOT NULL REFERENCES boutiques(id),
  product_ids     UUID[]      NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'waiting',
    -- 'waiting' | 'offered' | 'claimed' | 'expired' | 'cancelled'
  offered_slot_id UUID        REFERENCES try_on_boutique_slots(id),
  offered_at      TIMESTAMPTZ,
  claim_deadline  TIMESTAMPTZ,
  position        INT         NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active queue entry per shopper per boutique
CREATE UNIQUE INDEX IF NOT EXISTS uq_try_on_queue_one_active
  ON try_on_queue(shopper_id, boutique_id)
  WHERE status = 'waiting';

CREATE INDEX IF NOT EXISTS idx_try_on_queue_boutique_position
  ON try_on_queue(boutique_id, position)
  WHERE status = 'waiting';

ALTER TABLE try_on_queue ENABLE ROW LEVEL SECURITY;
-- Shopper sees own queue entries; service role full access
CREATE POLICY "try_on_queue_shopper_own"
  ON try_on_queue FOR ALL
  USING (shopper_id = auth.uid());

-- ── 3. Core sessions ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS try_on_sessions (
  id                            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id                    UUID        NOT NULL REFERENCES auth.users(id),
  boutique_id                   UUID        NOT NULL REFERENCES boutiques(id),
  driver_id                     UUID        REFERENCES auth.users(id),
  slot_id                       UUID        NOT NULL REFERENCES try_on_boutique_slots(id),
  city_id                       UUID        NOT NULL REFERENCES cities(id),
  scheduled_at                  TIMESTAMPTZ NOT NULL,

  -- Financial (cents)
  fee_charged_cents             INT         NOT NULL,
  credit_amount_cents           INT         NOT NULL DEFAULT 0,
  driver_pay_cents              INT         NOT NULL,
  overage_charged_cents         INT         NOT NULL DEFAULT 0,
  tip_cents                     INT         NOT NULL DEFAULT 0,

  -- Stripe
  stripe_payment_intent_id      TEXT,         -- session fee auth (manual capture)
  stripe_items_payment_intent_id TEXT,        -- items cart auth at driver pickup

  -- Delivery
  delivery_address              JSONB        NOT NULL,
  delivery_lat                  NUMERIC,
  delivery_lng                  NUMERIC,

  -- Status: booked → pickup_pending → en_route → arrived →
  --         in_home → returning → completed
  --         ↓ cancelled (from any pre-completed state)
  status                        TEXT        NOT NULL DEFAULT 'booked',

  -- Timing (admin-only visibility — shoppers/drivers only see in-home timer)
  driver_pickup_at              TIMESTAMPTZ,
  driver_arrival_at             TIMESTAMPTZ,
  in_home_started_at            TIMESTAMPTZ,
  in_home_ended_at              TIMESTAMPTZ,
  driver_return_at              TIMESTAMPTZ,
  total_elapsed_seconds         INT,

  -- Outcome
  items_kept_count              INT         NOT NULL DEFAULT 0,
  items_returned_count          INT         NOT NULL DEFAULT 0,
  product_revenue_cents         INT         NOT NULL DEFAULT 0,
  commission_cents              INT         NOT NULL DEFAULT 0,

  -- Cancellation
  cancelled_at                  TIMESTAMPTZ,
  cancelled_by                  TEXT,        -- 'shopper' | 'boutique' | 'driver' | 'system'
  cancellation_fee_cents        INT         NOT NULL DEFAULT 0,
  cancellation_reason           TEXT,

  -- Damage
  damage_reported               BOOLEAN     NOT NULL DEFAULT FALSE,
  damage_notes                  TEXT,

  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_try_on_sessions_shopper
  ON try_on_sessions(shopper_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_try_on_sessions_boutique
  ON try_on_sessions(boutique_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_try_on_sessions_driver
  ON try_on_sessions(driver_id, scheduled_at DESC)
  WHERE driver_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_try_on_sessions_status
  ON try_on_sessions(status);

ALTER TABLE try_on_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "try_on_sessions_shopper_own"
  ON try_on_sessions FOR ALL
  USING (shopper_id = auth.uid());

CREATE POLICY "try_on_sessions_boutique_own"
  ON try_on_sessions FOR SELECT
  USING (boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid()));

CREATE POLICY "try_on_sessions_driver_own"
  ON try_on_sessions FOR SELECT
  USING (driver_id = auth.uid());

-- ── 4. Wire inventory_holds → try_on_sessions FK (was deferred in 009a) ───────

ALTER TABLE inventory_holds
  ADD CONSTRAINT fk_inventory_holds_session
  FOREIGN KEY (session_id) REFERENCES try_on_sessions(id) ON DELETE CASCADE
  NOT VALID;  -- NOT VALID = fast, validated lazily; no table scan on existing empty table

-- ── 5. Session items (snapshot at booking) ────────────────────────────────────

CREATE TABLE IF NOT EXISTS try_on_session_items (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     UUID        NOT NULL REFERENCES try_on_sessions(id) ON DELETE CASCADE,
  product_id     UUID        NOT NULL REFERENCES products(id),
  name           TEXT        NOT NULL,
  price_cents    INT         NOT NULL,
  image_url      TEXT,
  selected_size  TEXT,
  selected_color TEXT,
  status         TEXT        NOT NULL DEFAULT 'pending',
    -- 'pending' | 'kept' | 'returned' | 'unavailable' | 'damaged'
  decided_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_try_on_session_items_session
  ON try_on_session_items(session_id);

ALTER TABLE try_on_session_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "try_on_session_items_participant"
  ON try_on_session_items FOR ALL
  USING (session_id IN (
    SELECT id FROM try_on_sessions
    WHERE shopper_id = auth.uid()
       OR boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid())
       OR driver_id = auth.uid()
  ));

-- ── 6. Photos (four mandatory checkpoints) ────────────────────────────────────

CREATE TABLE IF NOT EXISTS try_on_photos (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           UUID        NOT NULL REFERENCES try_on_sessions(id) ON DELETE CASCADE,
  item_id              UUID        REFERENCES try_on_session_items(id),
  uploaded_by_user_id  UUID        NOT NULL REFERENCES auth.users(id),
  uploaded_by_role     TEXT        NOT NULL,  -- 'boutique' | 'driver' | 'shopper'
  checkpoint           TEXT        NOT NULL,
    -- 'boutique_prep' | 'boutique_return' | 'driver_return' | 'shopper_final'
  image_url            TEXT        NOT NULL,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_try_on_photos_session
  ON try_on_photos(session_id, checkpoint);

ALTER TABLE try_on_photos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "try_on_photos_participant"
  ON try_on_photos FOR ALL
  USING (session_id IN (
    SELECT id FROM try_on_sessions
    WHERE shopper_id = auth.uid()
       OR boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid())
       OR driver_id = auth.uid()
  ));

-- ── 7. Admin-only tables (service role only) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS try_on_shopper_flags (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id  UUID        NOT NULL REFERENCES auth.users(id),
  session_id  UUID        REFERENCES try_on_sessions(id),
  flag_type   TEXT        NOT NULL,
  severity    TEXT        NOT NULL DEFAULT 'info', -- 'info' | 'watch' | 'critical'
  notes       TEXT,
  created_by  UUID        REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_try_on_shopper_flags_shopper
  ON try_on_shopper_flags(shopper_id, created_at DESC);

ALTER TABLE try_on_shopper_flags ENABLE ROW LEVEL SECURITY;
-- service role only — no client policies

CREATE TABLE IF NOT EXISTS try_on_outreach (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id       UUID        NOT NULL REFERENCES auth.users(id),
  sent_by          UUID        NOT NULL REFERENCES auth.users(id),
  template         TEXT        NOT NULL,
  message_body     TEXT        NOT NULL,
  channel          TEXT        NOT NULL, -- 'email' | 'sms' | 'in_app'
  shopper_response TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE try_on_outreach ENABLE ROW LEVEL SECURITY;
-- service role only

-- ── 8. platform_settings seed (try-on defaults) ───────────────────────────────

INSERT INTO platform_settings (key, value) VALUES
  ('try_on_fee_cents',                       '{"amount": 2500}'),
  ('try_on_credit_cents',                    '{"amount": 1000}'),
  ('try_on_driver_pay_cents',                '{"amount": 2000}'),
  ('try_on_overage_per_minute_cents',        '{"amount": 100}'),
  ('try_on_cancellation_fee_cents',          '{"amount": 1500}'),
  ('try_on_min_cart_value_cents',            '{"amount": 20000}'),
  ('try_on_max_items_per_session',           '{"count": 3}'),
  ('try_on_max_sessions_per_boutique_per_week', '{"count": 2}'),
  ('try_on_max_sessions_per_shopper_per_month', '{"count": 2}'),
  ('try_on_max_in_home_minutes',             '{"minutes": 15}'),
  ('try_on_max_overage_minutes',             '{"minutes": 30}'),
  ('try_on_service_radius_miles',            '{"miles": 10}'),
  ('try_on_queue_horizon_days',              '{"days": 10}'),
  ('try_on_claim_window_minutes',            '{"minutes": 30}'),
  ('try_on_cancellation_cutoff_hours',       '{"hours": 4}'),
  ('try_on_weekday_hours',                   '{"open": "10:00", "close": "17:00"}'),
  ('try_on_weekend_hours',                   '{"open": "10:00", "close": "16:00"}'),
  ('try_on_damage_suspension_threshold',     '{"count": 2}'),
  ('try_on_circuit_buy_rate_min_pct',        '{"pct": 25}'),
  ('try_on_circuit_damage_rate_max_pct',     '{"pct": 10}'),
  ('try_on_circuit_driver_acceptance_min_pct', '{"pct": 70}'),
  ('try_on_circuit_boutique_issues_max_per_week', '{"count": 2}'),
  ('try_on_feature_enabled',                 '{"enabled": true}'),
  ('try_on_enabled_cities',                  '{"city_ids": []}'),
  ('try_on_sms_enabled',                     '{"enabled": false}')
ON CONFLICT (key) DO NOTHING;


-- ── 9. Add sent_reminders column (for reminder deduplication) ─────────────────
ALTER TABLE try_on_sessions
  ADD COLUMN IF NOT EXISTS sent_reminders JSONB DEFAULT '{}';
