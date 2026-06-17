/**
 * Central Express error handler.
 * Catches anything passed to next(err).
 */
function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';

  // Don't leak stack traces to the CLIENT in production, but DO log them
  // server-side — a one-line message with no stack is undebuggable in prod.
  const payload = { error: message };
  if (process.env.NODE_ENV !== 'production' && err.stack) {
    payload.stack = err.stack;
  }

  // Correlation id so the access log and this error can be tied together.
  const reqId = req.id || req.headers['x-request-id'] || '-';
  const logLine = `[ERROR] req=${reqId} ${req.method} ${req.originalUrl} → ${status}: ${message}`;
  if (status >= 500) {
    // Server faults: always log the full stack (server-side only), even in prod.
    console.error(logLine + (err.stack ? `\n${err.stack}` : ''));
  } else {
    console.warn(logLine);
  }
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
