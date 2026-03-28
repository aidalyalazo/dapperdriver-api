-- ============================================================================
-- Support Tickets table
-- ============================================================================

CREATE TABLE IF NOT EXISTS support_tickets (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  ticket_number text UNIQUE NOT NULL,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_email    text NOT NULL,
  user_role     text NOT NULL CHECK (user_role IN ('shopper', 'boutique', 'driver')),
  category      text NOT NULL CHECK (category IN ('order_issue', 'account_problem', 'payment_issue', 'app_bug', 'other')),
  subject       text NOT NULL,
  description   text NOT NULL,
  order_id      uuid REFERENCES orders(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  priority      text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  admin_notes   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Index for fast user-scoped queries
CREATE INDEX IF NOT EXISTS idx_support_tickets_user_id ON support_tickets(user_id);

-- Index for admin dashboard filtering
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION update_support_tickets_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_support_tickets_updated_at
  BEFORE UPDATE ON support_tickets
  FOR EACH ROW
  EXECUTE FUNCTION update_support_tickets_updated_at();
