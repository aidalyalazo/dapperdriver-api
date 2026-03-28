-- =============================================
-- Seed cities: Paris, Miami, Los Angeles
-- =============================================

-- Insert cities (skip if they exist)
INSERT INTO cities (id, name, slug, status, tax_rate, timezone) VALUES
  ('c1a00001-0000-0000-0000-000000000001', 'Paris', 'paris', 'live', 0.20, 'Europe/Paris'),
  ('c1a00002-0000-0000-0000-000000000002', 'Miami', 'miami', 'live', 0.07, 'America/New_York'),
  ('c1a00003-0000-0000-0000-000000000003', 'Los Angeles', 'los-angeles', 'live', 0.095, 'America/Los_Angeles')
ON CONFLICT (id) DO UPDATE SET tax_rate = EXCLUDED.tax_rate, status = 'live';

-- =============================================
-- Boutique 1: Maison Élégance (Paris)
-- =============================================
INSERT INTO boutiques (id, user_id, name, slug, description, logo_initials, logo_bg, rating, review_count, follower_count, primary_category, category_tags, style_tags, price_tier, status, city_id)
VALUES (
  'b0a00001-0000-0000-0000-000000000001',
  'b0a00001-0000-0000-0000-000000000001',
  'Maison Élégance', 'maison-elegance',
  'Parisian haute couture and ready-to-wear. Timeless French fashion with a modern edge.',
  'MÉ', '#2D2D2D',
  4.8, 156, 2340,
  'Dresses',
  ARRAY['Dresses', 'Coats', 'Accessories'],
  ARRAY['French Chic', 'Haute Couture', 'Minimalist'],
  '$$$',
  'active',
  'c1a00001-0000-0000-0000-000000000001'
) ON CONFLICT (id) DO NOTHING;

-- Paris products
INSERT INTO products (id, boutique_id, name, description, price, compare_price, images, colors, sizes, category, stock, status, source) VALUES
  ('p0a00001-0000-0000-0000-000000000001', 'b0a00001-0000-0000-0000-000000000001', 'Parisian Silk Wrap Dress', 'Flowing silk wrap dress in classic Parisian style. Perfect for evening events.', 285, 340, ARRAY['https://images.unsplash.com/photo-1595777457583-95e059d581b8?w=600'], ARRAY['Black', 'Navy', 'Burgundy'], ARRAY['XS', 'S', 'M', 'L'], 'Dresses', 15, 'active', 'manual'),
  ('p0a00002-0000-0000-0000-000000000002', 'b0a00001-0000-0000-0000-000000000001', 'Wool Trench Coat', 'Double-breasted wool trench coat. A Parisian wardrobe essential.', 420, NULL, ARRAY['https://images.unsplash.com/photo-1539533018447-63fcce2678e3?w=600'], ARRAY['Camel', 'Black', 'Grey'], ARRAY['S', 'M', 'L', 'XL'], 'Coats', 8, 'active', 'manual'),
  ('p0a00003-0000-0000-0000-000000000003', 'b0a00001-0000-0000-0000-000000000001', 'Leather Crossbody Bag', 'Handcrafted Italian leather crossbody bag with gold hardware.', 195, 250, ARRAY['https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=600'], ARRAY['Tan', 'Black', 'Red'], ARRAY['One Size'], 'Accessories', 22, 'active', 'manual'),
  ('p0a00004-0000-0000-0000-000000000004', 'b0a00001-0000-0000-0000-000000000001', 'Cashmere Turtleneck', 'Ultra-soft 100% cashmere turtleneck sweater.', 175, NULL, ARRAY['https://images.unsplash.com/photo-1576566588028-4147f3842f27?w=600'], ARRAY['Cream', 'Charcoal', 'Blush'], ARRAY['XS', 'S', 'M', 'L'], 'Tops', 18, 'active', 'manual'),
  ('p0a00005-0000-0000-0000-000000000005', 'b0a00001-0000-0000-0000-000000000001', 'Pleated Midi Skirt', 'Elegant pleated midi skirt in satin finish.', 145, 180, ARRAY['https://images.unsplash.com/photo-1583496661160-fb5886a0aaaa?w=600'], ARRAY['Gold', 'Black', 'Silver'], ARRAY['XS', 'S', 'M', 'L'], 'Skirts', 12, 'active', 'manual'),
  ('p0a00006-0000-0000-0000-000000000006', 'b0a00001-0000-0000-0000-000000000001', 'Silk Scarf', 'Hand-printed silk scarf with floral motif. Made in Lyon.', 95, NULL, ARRAY['https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=600'], ARRAY['Multi', 'Blue', 'Rose'], ARRAY['One Size'], 'Accessories', 30, 'active', 'manual')
ON CONFLICT (id) DO NOTHING;

-- =============================================
-- Boutique 2: Miami Swim Co. (Miami)
-- =============================================
INSERT INTO boutiques (id, user_id, name, slug, description, logo_initials, logo_bg, rating, review_count, follower_count, primary_category, category_tags, style_tags, price_tier, status, city_id)
VALUES (
  'b0a00002-0000-0000-0000-000000000002',
  'b0a00002-0000-0000-0000-000000000002',
  'Miami Swim Co.', 'miami-swim-co',
  'Resort wear and swimwear for the bold and beautiful. Designed for life under the sun.',
  'MS', '#00BCD4',
  4.6, 89, 1560,
  'Swimwear',
  ARRAY['Swimwear', 'Resort Wear', 'Accessories'],
  ARRAY['Tropical', 'Bold', 'Resort'],
  '$$',
  'active',
  'c1a00002-0000-0000-0000-000000000002'
) ON CONFLICT (id) DO NOTHING;

-- Miami products
INSERT INTO products (id, boutique_id, name, description, price, compare_price, images, colors, sizes, category, stock, status, source) VALUES
  ('p0b00001-0000-0000-0000-000000000001', 'b0a00002-0000-0000-0000-000000000002', 'Tropical Print Bikini Set', 'Bold tropical print two-piece bikini with adjustable straps.', 68, 85, ARRAY['https://images.unsplash.com/photo-1570976447640-ac859083963f?w=600'], ARRAY['Tropical', 'Coral', 'Ocean Blue'], ARRAY['XS', 'S', 'M', 'L'], 'Swimwear', 25, 'active', 'manual'),
  ('p0b00002-0000-0000-0000-000000000002', 'b0a00002-0000-0000-0000-000000000002', 'Linen Beach Cover-Up', 'Oversized linen cover-up dress. Perfect poolside-to-dinner transition.', 95, NULL, ARRAY['https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=600'], ARRAY['White', 'Sand', 'Sky Blue'], ARRAY['S/M', 'M/L'], 'Resort Wear', 18, 'active', 'manual'),
  ('p0b00003-0000-0000-0000-000000000003', 'b0a00002-0000-0000-0000-000000000002', 'Straw Sun Hat', 'Wide-brim natural straw hat with ribbon detail.', 45, NULL, ARRAY['https://images.unsplash.com/photo-1572307480813-ceb0e59d8325?w=600'], ARRAY['Natural', 'Black Ribbon', 'White Ribbon'], ARRAY['One Size'], 'Accessories', 35, 'active', 'manual'),
  ('p0b00004-0000-0000-0000-000000000004', 'b0a00002-0000-0000-0000-000000000002', 'High-Waist Swim Bottom', 'Retro-inspired high-waist swim bottom with tummy control.', 42, 55, ARRAY['https://images.unsplash.com/photo-1509631179647-0177331693ae?w=600'], ARRAY['Black', 'Red', 'Navy'], ARRAY['XS', 'S', 'M', 'L', 'XL'], 'Swimwear', 20, 'active', 'manual'),
  ('p0b00005-0000-0000-0000-000000000005', 'b0a00002-0000-0000-0000-000000000002', 'Crochet Beach Bag', 'Handmade crochet tote bag. Roomy enough for all your beach essentials.', 58, NULL, ARRAY['https://images.unsplash.com/photo-1590874103328-eac38a683ce7?w=600'], ARRAY['Natural', 'Multi'], ARRAY['One Size'], 'Accessories', 15, 'active', 'manual'),
  ('p0b00006-0000-0000-0000-000000000006', 'b0a00002-0000-0000-0000-000000000002', 'Flowy Maxi Dress', 'Lightweight flowy maxi dress with side slit. Resort ready.', 120, 150, ARRAY['https://images.unsplash.com/photo-1496747611176-843222e1e57c?w=600'], ARRAY['Sunset Orange', 'Ocean', 'White'], ARRAY['XS', 'S', 'M', 'L'], 'Dresses', 12, 'active', 'manual')
ON CONFLICT (id) DO NOTHING;

-- =============================================
-- Boutique 3: LA Street Style (Los Angeles)
-- =============================================
INSERT INTO boutiques (id, user_id, name, slug, description, logo_initials, logo_bg, rating, review_count, follower_count, primary_category, category_tags, style_tags, price_tier, status, city_id)
VALUES (
  'b0a00003-0000-0000-0000-000000000003',
  'b0a00003-0000-0000-0000-000000000003',
  'LA Street Style', 'la-street-style',
  'California cool meets streetwear. Effortless everyday pieces with an edge.',
  'LA', '#FF6B35',
  4.7, 214, 3100,
  'Streetwear',
  ARRAY['Streetwear', 'Denim', 'Sneakers'],
  ARRAY['Streetwear', 'Casual', 'Athleisure'],
  '$$',
  'active',
  'c1a00003-0000-0000-0000-000000000003'
) ON CONFLICT (id) DO NOTHING;

-- LA products
INSERT INTO products (id, boutique_id, name, description, price, compare_price, images, colors, sizes, category, stock, status, source) VALUES
  ('p0c00001-0000-0000-0000-000000000001', 'b0a00003-0000-0000-0000-000000000003', 'Vintage Wash Denim Jacket', 'Oversized vintage wash denim jacket with distressed details.', 128, 160, ARRAY['https://images.unsplash.com/photo-1551537482-f2075a1d41f2?w=600'], ARRAY['Light Wash', 'Medium Wash', 'Black'], ARRAY['S', 'M', 'L', 'XL'], 'Denim', 20, 'active', 'manual'),
  ('p0c00002-0000-0000-0000-000000000002', 'b0a00003-0000-0000-0000-000000000003', 'Graphic Oversized Tee', 'Premium cotton oversized tee with original LA-inspired graphic.', 48, NULL, ARRAY['https://images.unsplash.com/photo-1576566588028-4147f3842f27?w=600'], ARRAY['White', 'Black', 'Sage'], ARRAY['S', 'M', 'L', 'XL', 'XXL'], 'Tops', 50, 'active', 'manual'),
  ('p0c00003-0000-0000-0000-000000000003', 'b0a00003-0000-0000-0000-000000000003', 'Cargo Joggers', 'Relaxed-fit cargo joggers with elastic cuffs. Street-ready comfort.', 78, 95, ARRAY['https://images.unsplash.com/photo-1552902865-b72c031ac5ea?w=600'], ARRAY['Olive', 'Black', 'Khaki'], ARRAY['XS', 'S', 'M', 'L', 'XL'], 'Bottoms', 30, 'active', 'manual'),
  ('p0c00004-0000-0000-0000-000000000004', 'b0a00003-0000-0000-0000-000000000003', 'Platform Sneakers', 'White leather platform sneakers with chunky sole.', 135, NULL, ARRAY['https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?w=600'], ARRAY['White', 'White/Black', 'All Black'], ARRAY['6', '7', '8', '9', '10', '11'], 'Sneakers', 15, 'active', 'manual'),
  ('p0c00005-0000-0000-0000-000000000005', 'b0a00003-0000-0000-0000-000000000003', 'Cropped Hoodie', 'Soft-touch cropped hoodie with embroidered logo.', 65, NULL, ARRAY['https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=600'], ARRAY['Lavender', 'Grey', 'Black'], ARRAY['XS', 'S', 'M', 'L'], 'Tops', 25, 'active', 'manual'),
  ('p0c00006-0000-0000-0000-000000000006', 'b0a00003-0000-0000-0000-000000000003', 'Wide Leg Jeans', 'High-rise wide leg jeans in premium stretch denim.', 98, 125, ARRAY['https://images.unsplash.com/photo-1541099649105-f69ad21f3246?w=600'], ARRAY['Indigo', 'Light Blue', 'Black'], ARRAY['24', '25', '26', '27', '28', '29', '30'], 'Denim', 18, 'active', 'manual')
ON CONFLICT (id) DO NOTHING;
