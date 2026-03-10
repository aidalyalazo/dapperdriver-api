const { validationResult } = require('express-validator');

/**
 * Runs after express-validator chains.
 * Returns 422 with the first validation error if any.
 */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg, details: errors.array() });
  }
  next();
}

module.exports = { validate };
