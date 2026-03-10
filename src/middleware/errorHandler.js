/**
 * Central Express error handler.
 * Catches anything passed to next(err).
 */
function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';

  // Don't leak stack traces in production
  const payload = { error: message };
  if (process.env.NODE_ENV !== 'production' && err.stack) {
    payload.stack = err.stack;
  }

  console.error(`[ERROR] ${req.method} ${req.originalUrl} → ${status}: ${message}`);
  res.status(status).json(payload);
}

/**
 * Wraps async route handlers to forward errors to next().
 * Avoids try/catch boilerplate in every controller.
 *
 * Usage:  router.get('/path', asyncHandler(myAsyncFn))
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { errorHandler, asyncHandler };
