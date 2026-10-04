/**
 * classifyChapaInitError.js
 *
 * Classifies the error from Chapa's initChapaPayout call:
 *   - 'definitive'  → Chapa explicitly rejected the transfer (it was never created).
 *                      Safe to refund immediately.
 *   - 'ambiguous'   → Transfer may or may not have been created.
 *                      Must leave PENDING for the cron to verify.
 *
 * DEFAULT: ambiguous. Only HTTP 400/422 responses matching an explicit allow-list
 * are classified as definitive. Everything else (timeouts, 5xx, network errors,
 * unknown error bodies) is ambiguous.
 *
 * Auth errors (401/403) are ambiguous + CHAPA_AUTH alert: they affect every payout,
 * not just this one.
 */

// Allow-list of definitive Chapa rejection patterns.
// SHIPPED EMPTY on purpose: every entry here is a GUESS until we capture real
// Chapa sandbox/production rejection responses as fixtures. A wrong guess means
// refunding a transfer that was actually delivered = double payout.
// Ambiguous-by-default costs a 6-minute cron wait; a wrong "definitive" costs money.
// When fixtures exist, re-populate this list ONLY with captured response bodies.
const DEFINITIVE_PATTERNS = [];

/**
 * @param {Error} err - The error from initChapaPayout
 * @returns {{ classification: 'definitive'|'ambiguous', alert?: string, reason: string }}
 */
function classifyChapaInitError(err) {
  const httpStatus = err?.status || err?.response?.status || err?.statusCode || 0;
  const body = String(
    err?.response?.message ||
    err?.response?.data?.message ||
    err?.response?.data?.error ||
    err?.message ||
    ''
  ).toLowerCase();

  // Auth errors: ambiguous (affects all payouts) + system alert
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      classification: 'ambiguous',
      alert: 'CHAPA_AUTH',
      reason: `Chapa returned ${httpStatus}: ${body.slice(0, 100)}`
    };
  }

  // "Reference already used" means the transfer EXISTS → ambiguous
  if (body.includes('already') && (body.includes('used') || body.includes('exist'))) {
    return {
      classification: 'ambiguous',
      reason: `Chapa says reference already used — transfer may exist: ${body.slice(0, 100)}`
    };
  }

  // Only trust HTTP 400/422 with a known rejection message as definitive
  if (httpStatus === 400 || httpStatus === 422) {
    for (const pattern of DEFINITIVE_PATTERNS) {
      if (body.includes(pattern)) {
        return {
          classification: 'definitive',
          reason: `Chapa rejected (${httpStatus}): ${body.slice(0, 100)}`
        };
      }
    }
    // 400/422 but unknown message → still ambiguous (new error format?)
    return {
      classification: 'ambiguous',
      reason: `Chapa returned ${httpStatus} with unknown body: ${body.slice(0, 100)}`
    };
  }

  // Everything else: timeouts, 5xx, network errors, ECONNRESET → ambiguous
  return {
    classification: 'ambiguous',
    reason: `Chapa error (status=${httpStatus}): ${(err?.code || '')} ${body.slice(0, 100)}`
  };
}

module.exports = { classifyChapaInitError, DEFINITIVE_PATTERNS };
