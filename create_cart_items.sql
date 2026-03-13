-- Create cart_items table for shopper carts
-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS cart_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id UUID NOT NULL REFERENCES shoppers(user_id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
  selected_color TEXT,
  selected_size TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(shopper_id, product_id, selected_color, selected_size)
);

CREATE INDEX IF NOT EXISTS idx_cart_items_shopper_id ON cart_items(shopper_id);
