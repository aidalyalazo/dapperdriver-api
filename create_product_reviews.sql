-- Product reviews table
CREATE TABLE IF NOT EXISTS product_reviews (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  shopper_id UUID NOT NULL REFERENCES auth.users(id),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES orders(id),
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  height TEXT,
  weight TEXT,
  photo_urls TEXT[] DEFAULT '{}',
  selected_size TEXT,
  selected_color TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(shopper_id, product_id, order_id)
);

-- Add rating and review_count columns to products if they don't exist
ALTER TABLE products ADD COLUMN IF NOT EXISTS rating NUMERIC(2,1) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS review_count INTEGER DEFAULT 0;

-- Add selected_size and selected_color to order_items if they don't exist
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS selected_size TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS selected_color TEXT;

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_product_reviews_product ON product_reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_product_reviews_shopper ON product_reviews(shopper_id);

-- RLS
ALTER TABLE product_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read reviews"
  ON product_reviews FOR SELECT
  USING (true);

CREATE POLICY "Shoppers can insert own reviews"
  ON product_reviews FOR INSERT
  WITH CHECK (auth.uid() = shopper_id);
