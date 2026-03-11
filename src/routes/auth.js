const router = require('express').Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { supabaseAdmin } = require('../config/supabase');
const { createClient } = require('@supabase/supabase-js');

/**
 * Public Supabase client — used for sign-up / sign-in.
 * The anon key is safe to use here; JWT is returned to the client.
 */
const supabasePublic = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── Registration ──────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/register
 * Creates a Supabase Auth user and the corresponding profile record.
 * `role` must be one of: shopper | boutique | driver
 */
router.post(
  '/register',
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('role').isIn(['shopper', 'boutique', 'driver']).withMessage('role must be shopper, boutique, or driver'),
    body('full_name').notEmpty().withMessage('full_name is required'),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const { email, password, role, full_name, phone } = req.body;

    // 1. Create Supabase Auth user with role in metadata
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // skip email verification in dev; set false in prod
      user_metadata: { role, full_name },
    });

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    const userId = authData.user.id;

    // 2. Insert into the appropriate profile table
    const profileTable = role === 'boutique' ? 'boutiques' : role === 'driver' ? 'drivers' : 'shoppers';
    const profileData = {
      email,
      phone:     phone || null,
      created_at: new Date().toISOString(),
    };

    // Each table uses a different column name for the user's name
    // and a different key for the auth user id
    if (role === 'shopper') {
      profileData.id           = userId;  // shoppers.id = auth user id
      profileData.display_name = full_name;
    } else if (role === 'boutique') {
      profileData.user_id    = userId;  // boutiques uses separate user_id column
      profileData.owner_name = full_name;
      profileData.name       = req.body.boutique_name || full_name;
      // status defaults to 'pending' in DB
    } else {
      profileData.id         = userId;  // drivers.id = auth user id
      profileData.full_name  = full_name;
    }

    const { error: profileError } = await supabaseAdmin.from(profileTable).insert(profileData);
    if (profileError) {
      // Rollback auth user if profile insert fails
      await supabaseAdmin.auth.admin.deleteUser(userId);
      return res.status(400).json({ error: profileError.message });
    }

    res.status(201).json({
      message: 'Account created successfully.',
      user_id: userId,
      role,
    });
  })
);

// ── Login ─────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/login
 * Returns Supabase JWT access_token and refresh_token.
 */
router.post(
  '/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    const { data, error } = await supabasePublic.auth.signInWithPassword({ email, password });

    if (error) return res.status(401).json({ error: error.message });

    res.json({
      access_token:  data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in:    data.session.expires_in,
      user: {
        id:   data.user.id,
        email: data.user.email,
        role: data.user.user_metadata?.role,
      },
    });
  })
);

// ── Token Refresh ─────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/refresh
 */
router.post(
  '/refresh',
  [body('refresh_token').notEmpty(), validate],
  asyncHandler(async (req, res) => {
    const { data, error } = await supabasePublic.auth.refreshSession({
      refresh_token: req.body.refresh_token,
    });

    if (error) return res.status(401).json({ error: error.message });

    res.json({
      access_token:  data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in:    data.session.expires_in,
    });
  })
);

// ── Logout ────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/logout
 */
router.post('/logout', authenticate, asyncHandler(async (req, res) => {
  // Revoke session server-side
  await supabaseAdmin.auth.admin.signOut(req.userId);
  res.json({ message: 'Logged out.' });
}));

// ── Password Reset ────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/forgot-password
 */
router.post(
  '/forgot-password',
  [body('email').isEmail().normalizeEmail(), validate],
  asyncHandler(async (req, res) => {
    await supabasePublic.auth.resetPasswordForEmail(req.body.email, {
      redirectTo: `${process.env.FRONTEND_URL}/reset-password`,
    });
    // Always return 200 to prevent email enumeration
    res.json({ message: 'If that email exists, a reset link has been sent.' });
  })
);

/**
 * POST /api/v1/auth/reset-password
 */
router.post(
  '/reset-password',
  authenticate,
  [body('password').isLength({ min: 8 }), validate],
  asyncHandler(async (req, res) => {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(req.userId, {
      password: req.body.password,
    });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: 'Password updated successfully.' });
  })
);

module.exports = router;
