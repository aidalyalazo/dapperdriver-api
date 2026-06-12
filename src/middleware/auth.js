const { supabaseAdmin } = require('../config/supabase');

/**
 * Verifies the Supabase JWT from the Authorization header.
 * Attaches `req.user` (the Supabase user object) and `req.userId` on success.
 *
 * Usage:
 *   router.get('/profile', authenticate, handler)
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
    }

    const token = authHeader.split(' ')[1];

    const {
      data: { user },
      error,
    } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }

    req.user = user;
    req.userId = user.id;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Role-based guard. Call AFTER authenticate.
 * app_metadata.role is authoritative (only writable server-side); falls back
 * to user_metadata.role for legacy accounts — EXCEPT for 'admin', which must
 * come from app_metadata because users can edit their own user_metadata via
 * the Supabase auth API.
 *
 * @param {...string} roles  — accepted roles, e.g. requireRole('boutique', 'admin')
 */
function requireRole(...roles) {
  return (req, res, next) => {
    const appRole = req.user?.app_metadata?.role;
    let userRole = appRole || req.user?.user_metadata?.role;
    if (userRole === 'admin' && appRole !== 'admin') userRole = null;
    if (!userRole || !roles.includes(userRole)) {
      return res.status(403).json({
        error: `Access denied. Required role(s): ${roles.join(', ')}.`,
      });
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
