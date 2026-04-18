const { z } = require('zod');
const { logAnomaly } = require('./AnomalyMonitor');

/**
 * Higher-order middleware to strictly validate request bindings against a Zod schema.
 * Rejects invalid payloads immediately with a 400 Bad Request error.
 */
const validate = (schema, source = 'body') => {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req[source]);
      // Completely replace the request payload with the sanitized, validated version
      req[source] = parsed;
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        console.error(`[VALIDATION] Failed on ${req.originalUrl}:`, JSON.stringify(err.errors), 'Body:', JSON.stringify(req[source]));
        logAnomaly(req, `Schema Validation Failed on [${req.originalUrl}]`);
        return res.status(400).json({
          error: 'Validation failed. Invalid input format.',
          details: err.errors.map(e => ({ field: e.path.join('.'), message: e.message }))
        });
      }
      logAnomaly(req, `Malformed Payload on [${req.originalUrl}]`);
      return res.status(400).json({ error: 'Malformed request payload' });
    }
  };
};

/**
 * Military-Grade Schemas
 */

const schemas = {
  // Financial Operations
  deposit: z.object({
    amount: z.coerce.number().int('Amount must be an integer').min(10, 'Minimum deposit is 10 ETB').max(100000, 'Maximum single deposit limit is 100000 ETB')
  }).passthrough(),

  withdraw: z.object({
    amount: z.coerce.number().min(10, 'Minimum withdrawal is 10 ETB').max(100000, 'Maximum withdrawal is 100,000 ETB'),
    payoutMethod: z.string().optional(),
    payoutDestination: z.string().optional(),
  }).passthrough(),

  // Account Operations
  updateProfile: z.object({
    username: z.string().min(2).max(24).regex(/^[\p{L}\p{N}_\- ]+$/u, 'Username can only contain letters, numbers, spaces, underscores, and hyphens').optional(),
    display_name: z.string().min(2).max(40).optional(),
    avatar: z.string().url('Avatar must be a valid URL').max(1024).optional().nullable()
  })
};

module.exports = {
  validate,
  schemas
};
