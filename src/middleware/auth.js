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
    const userRole = resolveRole(req);
    // Admin passes every role gate — the admin's personal account keeps
    // working in the shopper app.
    if (userRole === 'admin') return next();
    if (!userRole || !roles.includes(userRole)) {
      return res.status(403).json({
        error: `Access denied. Required role(s): ${roles.join(', ')}.`,
      });
    }
    next();
  };
}

/**
 * Canonical, trust-safe role for authorization decisions.
 *
 * app_metadata.role is authoritative (server-writable only). user_metadata is
 * self-editable via the Supabase auth API, so a user_metadata role of 'admin'
 * is IGNORED — otherwise any shopper could escalate to admin. Non-admin roles
 * (shopper/boutique/driver) may come from user_metadata for legacy accounts.
 *
 * Always use this — never read req.user.user_metadata.role directly — when
 * deciding what a request is allowed to do.
 *
 * @returns {'shopper'|'boutique'|'driver'|'admin'|null}
 */
function resolveRole(req) {
  const appRole = req.user?.app_metadata?.role;
  if (appRole) return appRole; // app_metadata authoritative (incl. admin)
  const umRole = req.user?.user_metadata?.role;
  if (umRole === 'admin') return null; // forgeable admin — never trusted
  return umRole || null;
}

module.exports = { authenticate, requireRole, resolveRole };
