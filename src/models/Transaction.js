
// transaction.js
// Production-level Postgres utilities for deposits/withdrawals + webhooks.
//
// ENV expected:
//   DATABASE_URL
//   (Optionally) STATEMENT_TIMEOUT_MS (defaults 8000)
//
// NOTE: For webhook signature verification, we show HMAC-SHA256 as a common pattern.
// Replace "computeHmac" and the signature extraction mapping according to your provider.

const { pool } = require("../db/index");
const crypto = require("crypto");
const { z } = require("zod");


// -----------------------------
// Validation Schemas
// -----------------------------
const currencySchema = z.string().length(3);
const uuidSchema = z.string().uuid();
const providerCodeSchema = z.string().min(1).max(64);
const idempotencyKeySchema = z.string().min(1).max(200);
const positiveIntSchema = z.number().int().positive();
const statusSchema = z.enum([
  "pending",
  "authorized",
  "succeeded",
  "failed",
  "canceled",
  "refunded",
]);
const txTypeSchema = z.enum(["deposit", "withdrawal"]);

// Allowed status transitions (defense-in-depth)
const ALLOWED_TRANSITIONS = {
  pending: new Set(["authorized", "succeeded", "failed", "canceled"]),
  authorized: new Set(["succeeded", "failed", "canceled"]),
  succeeded: new Set(["refunded"]), // deposit only
  failed: new Set([]),
  canceled: new Set([]),
  refunded: new Set([]),
};

// -----------------------------
// Helpers
// -----------------------------

function toMinorUnits(amountFloat) {
  // Convert a decimal amount (e.g. 10.50) to minor units safely
  // You may adapt to provider precision if not 2 decimals.
  return Math.round(Number(amountFloat) * 100);
}

function computeHmac(secret, rawBody) {
  return crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function getProviderByCode(client, code) {
  const { rows } = await client.query(
    `SELECT id, code FROM payment_providers WHERE code = $1`,
    [code]
  );
  if (!rows.length) {
    throw new Error(`Unknown provider code: ${code}`);
  }
  return rows[0];
}

async function getActiveWebhookSecrets(client, providerId) {
  const { rows } = await client.query(
    `SELECT secret FROM webhook_endpoints WHERE provider_id = $1 AND active = TRUE`,
    [providerId]
  );
  return rows.map(r => r.secret);
}

function ensureTransitionAllowed(previous, next) {
  if (!ALLOWED_TRANSITIONS[previous]?.has(next)) {
    throw new Error(`Illegal status transition: ${previous} => ${next}`);
  }
}

// -----------------------------
// Public API
// -----------------------------

/**
 * Create a deposit intent (pending) with idempotency.
 * Returns the created or existing (by idempotency) transaction row.
 */
async function createDepositIntent({
  userId,
  providerCode,
  amount,        // decimal number (e.g., 10.50)
  currency,      // e.g. 'ETB'
  description = "",
  metadata = {},
  idempotencyKey,
}) {
  uuidSchema.parse(userId);
  providerCodeSchema.parse(providerCode);
  currencySchema.parse(currency);
  idempotencyKeySchema.parse(idempotencyKey);
  const amountMinor = toMinorUnits(amount);
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    throw new Error("Invalid amount");
  }

  return withTx(async (client) => {
    const provider = await getProviderByCode(client, providerCode);

    // If idempotency key already exists, return the same row
    const existing = await client.query(
      `SELECT * FROM transactions WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    if (existing.rows.length) return existing.rows[0];

    const { rows } = await client.query(
      `INSERT INTO transactions
       (user_id, type, provider_id, amount_minor, currency, status, description, metadata, idempotency_key)
       VALUES ($1, 'deposit', $2, $3, $4, 'pending', $5, $6, $7)
       RETURNING *`,
      [userId, provider.id, amountMinor, currency, description, metadata, idempotencyKey]
    );
    return rows[0];
  });
}

/**
 * Create a withdrawal request (pending). You should enforce balance checks upstream.
 */
async function createWithdrawalRequest({
  userId,
  providerCode,
  amount,     // decimal
  currency,
  description = "",
  metadata = {},
  idempotencyKey,
}) {
  uuidSchema.parse(userId);
  providerCodeSchema.parse(providerCode);
  currencySchema.parse(currency);
  idempotencyKeySchema.parse(idempotencyKey);
  const amountMinor = toMinorUnits(amount);
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    throw new Error("Invalid amount");
  }

  return withTx(async (client) => {
    const provider = await getProviderByCode(client, providerCode);

    const existing = await client.query(
      `SELECT * FROM transactions WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    if (existing.rows.length) return existing.rows[0];

    const { rows } = await client.query(
      `INSERT INTO transactions
       (user_id, type, provider_id, amount_minor, currency, status, description, metadata, idempotency_key)
       VALUES ($1, 'withdrawal', $2, $3, $4, 'pending', $5, $6, $7)
       RETURNING *`,
      [userId, provider.id, amountMinor, currency, description, metadata, idempotencyKey]
    );
    return rows[0];
  });
}

/**
 * Attach provider's external id after creating an intent (e.g., checkout/session id).
 */
async function attachProviderExternalId({ transactionId, providerExtId }) {
  uuidSchema.parse(transactionId);
  if (!providerExtId || providerExtId.length > 200) {
    throw new Error("Invalid providerExtId");
  }
  const { rows } = await pool.query(
    `UPDATE transactions
     SET provider_ext_id = $2, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [transactionId, providerExtId]
  );
  if (!rows.length) throw new Error("Transaction not found");
  return rows[0];
}

/**
 * Mark a transaction by (provider_code, provider_ext_id) with status, with allowed transitions.
 * Optionally merges metadata.
 */
async function markTransactionStatusByExternal({
  providerCode,
  providerExtId,
  newStatus,
  metadata = {},
}) {
  providerCodeSchema.parse(providerCode);
  if (!providerExtId) throw new Error("providerExtId required");
  statusSchema.parse(newStatus);

  return withTx(async (client) => {
    const provider = await getProviderByCode(client, providerCode);

    // NOTE: advisory_lock_for() was removed — pg_advisory_lock is incompatible with
    // PgBouncer in transaction mode (Supabase NANO). The FOR UPDATE on the SELECT
    // below already provides row-level serialization within this transaction.

    const { rows: found } = await client.query(
      `SELECT * FROM transactions WHERE provider_id = $1 AND provider_ext_id = $2 FOR UPDATE`,
      [provider.id, providerExtId]
    );
    if (!found.length) {
      throw new Error("Transaction not found for provider_ext_id");
    }
    const tx = found[0];

    ensureTransitionAllowed(tx.status, newStatus);

    const { rows } = await client.query(
      `UPDATE transactions
       SET status = $3,
           metadata = metadata || $4::jsonb,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [tx.id, provider.id, newStatus, metadata]
    );
    return rows[0];
  });
}

/**
 * Get paginated transactions of a user (cursor = ISO date + id)
 */
async function getUserTransactions({ userId, limit = 50, cursor }) {
  uuidSchema.parse(userId);
  limit = Math.min(Math.max(1, Number(limit)), 100);

  let params = [userId, limit + 1];
  let where = `user_id = $1`;
  if (cursor) {
    // cursor format: "<created_at_iso>|<uuid>"
    const [ts, id] = String(cursor).split("|");
    if (!ts || !id) throw new Error("Bad cursor");
    uuidSchema.parse(id);
    params.push(ts, id);
    where += ` AND (created_at, id) < ($3::timestamptz, $4::uuid)`;
  }

  const { rows } = await pool.query(
    `SELECT *
     FROM transactions
     WHERE ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    params
  );

  let nextCursor = null;
  if (rows.length > limit) {
    const tail = rows[limit - 1];
    nextCursor = `${tail.created_at.toISOString()}|${tail.id}`;
    rows.length = limit;
  }
  return { items: rows, nextCursor };
}

async function createWithdrawalWithBalanceCheck({
  userId,
  providerCode,
  amount,   // decimal
  currency,
  description = "",
  metadata = {},
  idempotencyKey,
}) {
  uuidSchema.parse(userId);
  providerCodeSchema.parse(providerCode);
  currencySchema.parse(currency);
  idempotencyKeySchema.parse(idempotencyKey);

  const amountMinor = toMinorUnits(amount);
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    throw new Error("Invalid amount");
  }

  return withTx(async (client) => {
    const provider = await getProviderByCode(client, providerCode);

    // Idempotency: if we’ve already created this logical withdrawal, return it
    {
      const { rows } = await client.query(
        `SELECT * FROM transactions WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      if (rows.length) return rows[0];
    }

    // Atomic balance decrement; fails if insufficient funds
    const dec = await client.query(
      `UPDATE users
         SET balance_minor = balance_minor - $2
       WHERE userid = $1
         AND balance_minor >= $2
       RETURNING userid, balance_minor`,
      [userId, amountMinor]
    );
    if (!dec.rows.length) {
      throw new Error("INSUFFICIENT_FUNDS");
    }

    // Create the withdrawal transaction (pending)
    const { rows } = await client.query(
      `INSERT INTO transactions
         (user_id, type, provider_id, amount_minor, currency, status, description, metadata, idempotency_key)
       VALUES ($1, 'withdrawal', $2, $3, $4, 'pending', $5, $6, $7)
       RETURNING *`,
      [userId, provider.id, amountMinor, currency, description, metadata, idempotencyKey]
    );

    return rows[0];
  });
}
/**
 * Record an incoming webhook event (append-only), verify signature (HMAC-SHA256 example),
 * and **optionally** process it to update a transaction.
 *
 * You typically call this in your Express/Koa route after reading the *raw* body.
 */
async function recordAndProcessWebhook({
  providerCode,
  rawBody,         // Buffer or string
  headers,         // request headers
  payload,         // parsed JSON payload
  mapPayload,      // function(payload) => { providerEventId, eventType, providerExtId, newStatus, metadata? }
  signatureHeaderName = "x-signature",
}) {
  providerCodeSchema.parse(providerCode);
  if (typeof mapPayload !== "function") throw new Error("mapPayload required");
  const raw = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");

  return withTx(async (client) => {
    const provider = await getProviderByCode(client, providerCode);

    // Verify signature with any active secret (supports rotation)
    const secrets = await getActiveWebhookSecrets(client, provider.id);
    if (!secrets.length) throw new Error("No active webhook secret for provider");

    const presentedSig = (headers?.[signatureHeaderName] || headers?.[signatureHeaderName.toLowerCase()] || "").toString().trim();
    const verified = secrets.some((s) => {
      const expected = computeHmac(s, raw);
      console.log("Computed HMAC:", expected);
      // Constant-time compare
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(presentedSig || "", "utf8"));
    });
    if (!verified) {
      // Still store the event for auditing, but mark as failed
      const { providerEventId, eventType } = safeMap(mapPayload, payload);
      await client.query(
        `INSERT INTO webhook_events (provider_id, provider_event_id, event_type, signature, payload, processing_error)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (provider_id, provider_event_id) DO NOTHING`,
        [provider.id, providerEventId || "(none)", eventType || "(unknown)", presentedSig || null, payload, "signature_verification_failed"]
      );
      throw new Error("Webhook signature verification failed");
    }

    // Parse/normalize provider payload
    const { providerEventId, eventType, providerExtId, newStatus, metadata } = mapPayload(payload);

    // Idempotent event log
    const { rows: evRows } = await client.query(
      `INSERT INTO webhook_events (provider_id, provider_event_id, event_type, signature, payload)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (provider_id, provider_event_id) DO UPDATE
         SET payload = EXCLUDED.payload
       RETURNING *`,
      [provider.id, providerEventId, eventType, presentedSig || null, payload]
    );
    const eventRow = evRows[0];

    // If the event references a specific provider_ext_id, update the transaction
    if (providerExtId && newStatus) {
      // NOTE: advisory_lock_for() was removed — pg_advisory_lock is incompatible with
      // PgBouncer in transaction mode (Supabase NANO). The FOR UPDATE on the SELECT
      // below already provides row-level serialization within this transaction.

      const { rows: txRows } = await client.query(
        `SELECT * FROM transactions WHERE provider_id = $1 AND provider_ext_id = $2 FOR UPDATE`,
        [provider.id, providerExtId]
      );

      if (txRows.length) {
        const tx = txRows[0];
        ensureTransitionAllowed(tx.status, newStatus);

        const { rows: updated } = await client.query(
          `UPDATE transactions
             SET status = $3,
                 metadata = metadata || $4::jsonb,
                 updated_at = now()
           WHERE id = $1
           RETURNING *`,
          [tx.id, newStatus, metadata || {}]
        );

        await client.query(
          `UPDATE webhook_events SET processed_at = now(), transaction_id = $1 WHERE id = $2`,
          [tx.id, eventRow.id]
        );

        return { event: eventRow, updatedTransaction: updated[0] };
      }

      // Optionally: Create the tx if your flow allows provider-first transactions
      // (commented out by default for safety)
      // throw new Error("Referenced transaction not found");
    }

    await client.query(`UPDATE webhook_events SET processed_at = now() WHERE id = $1`, [eventRow.id]);
    return { event: eventRow, updatedTransaction: null };
  });
}

function safeMap(mapper, payload) {
  try { return mapper(payload) || {}; } catch (_) { return {}; }
}

/**
 * Simple helper to add/register a provider (one-time ops/seed).
 */
async function upsertProvider({ code, name }) {
  providerCodeSchema.parse(code);
  if (!name) throw new Error("name required");
  const { rows } = await pool.query(
    `INSERT INTO payment_providers (code, name)
     VALUES ($1,$2)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [code, name]
  );
  return rows[0];
}

/**
 * Rotate/add a webhook secret for a provider.
 */
async function addWebhookSecret({ providerCode, secret, description }) {
  providerCodeSchema.parse(providerCode);
  if (!secret) throw new Error("secret required");
  return withTx(async (client) => {
    const provider = await getProviderByCode(client, providerCode);
    const { rows } = await client.query(
      `INSERT INTO webhook_endpoints (provider_id, description, secret, active)
       VALUES ($1,$2,$3, TRUE)
       RETURNING *`,
      [provider.id, description || null, secret]
    );
    return rows[0];
  });
}

/**
 * Deactivate an old secret (rotation).
 */
async function deactivateWebhookSecret({ endpointId }) {
  uuidSchema.parse(endpointId);
  const { rows } = await pool.query(
    `UPDATE webhook_endpoints SET active = FALSE WHERE id = $1 RETURNING *`,
    [endpointId]
  );
  if (!rows.length) throw new Error("endpoint not found");
  return rows[0];
}

/**
 * Get a single transaction by id (server/admin use).
 */
async function getTransactionById({ id }) {
  uuidSchema.parse(id);
  const { rows } = await pool.query(`SELECT * FROM transactions WHERE id = $1`, [id]);
  if (!rows.length) throw new Error("not found");
  return rows[0];
}

// -----------------------------
// Exported
// -----------------------------
module.exports = {
  // intents
  createDepositIntent,
  createWithdrawalRequest,
  attachProviderExternalId,

  // status update
  markTransactionStatusByExternal,

  // queries
  getUserTransactions,
  getTransactionById,

  // webhook utilities
  recordAndProcessWebhook,
  upsertProvider,
  addWebhookSecret,
  deactivateWebhookSecret,
  createWithdrawalWithBalanceCheck,
};
