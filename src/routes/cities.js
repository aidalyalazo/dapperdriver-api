const router = require('express').Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { supabaseAdmin } = require('../config/supabase');

/**
 * GET /api/v1/cities
 * Public — list all live cities.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('cities')
      .select('id, name, slug, status')
      .eq('status', 'live')
      .order('name');

    if (error) throw new Error(error.message);
    res.json({ data });
  })
);

module.exports = router;
