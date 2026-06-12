// routes/transactions.routes.js
const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const Z = require("zod");
const z = Z.z || Z; 

const {
  createDepositIntent,
  createWithdrawalWithBalanceCheck,
  attachProviderExternalId,
  getUserTransactions,
} = require("../models/Transaction");

const router = express.Router();

// ---- Security middleware

// Simple JWT auth: RS256 public key or HS256 secret (choose one).
const JWT_ALG = process.env.JWT_ALG || "RS256";
const JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY || ""; // for RS256
const JWT_SECRET = process.env.JWT_SECRET || "";         // for HS256 fallback

function auth(req, res, next) {
  try {
    const hdr = req.headers.authorization || "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: "missing_token" });

    const { userId, username } = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });

    // Expect UUID in sub (adjust if you use a different claim)
    if (!userId) return res.status(401).json({ ok: false, error: "bad_token" });
    req.user = { id: userId };
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "invalid_token" });
  }
}

// Basic rate limit per IP (tighten as you like)
const limiter = rateLimit({
  windowMs: 60_000,
  max: 60,
});

// Shared validators
const depositBody = z.object({
  amount: z.number().positive(),
  currency: z.string().length(3),
  providerCode: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  metadata: z.record(z.any()).optional(),
  providerExtId: z.string().max(200).optional(), // if you already have provider session id
});
const withdrawBody = z.object({
  amount: z.number().positive(),
  currency: z.string().length(3),
  providerCode: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  metadata: z.record(z.any()).optional(),
});

// Enforce Idempotency-Key header
function requireIdempotencyKey(req, res, next) {
  const key = req.get("Idempotency-Key");
  if (!key || key.length > 200) {
    return res.status(428).json({ ok: false, error: "missing_or_bad_idempotency_key" });
  }
  req.idempotencyKey = key;
  next();
}

// ---- Routes

// Create a deposit intent (no balance change yet; webhook will post after success)
router.post("/deposit-intent", limiter, auth, requireIdempotencyKey, async (req, res) => {
  try {
    const body = depositBody.parse(req.body);
    const tx = await createDepositIntent({
      userId: req.user.id,
      providerCode: body.providerCode,
      amount: body.amount,
      currency: body.currency.toUpperCase(),
      description: body.description,
      metadata: body.metadata || {},
      idempotencyKey: req.idempotencyKey,
    });

    // Optional: attach provider external/session id if caller has it now
    if (body.providerExtId) {
      await attachProviderExternalId({ transactionId: tx.id, providerExtId: body.providerExtId });
    }

    return res.status(201).json({ ok: true, transaction: tx });
  } catch (err) {
    const code =
      err?.message === "Invalid amount" ? 400 :
      err?.message?.includes("Unknown provider") ? 400 : 400;
    return res.status(code).json({ ok: false, error: err.message });
  }
});

// Create a withdrawal (atomic balance decrement to avoid races)
router.post("/withdraw", limiter, auth, requireIdempotencyKey, async (req, res) => {
  try {
    const body = withdrawBody.parse(req.body);

    const tx = await createWithdrawalWithBalanceCheck({
      userId: req.user.id,
      providerCode: body.providerCode,
      amount: body.amount,
      currency: body.currency.toUpperCase(),
      description: body.description,
      metadata: body.metadata || {},
      idempotencyKey: req.idempotencyKey,
    });

    // You might now kick off a payout with provider and later finish via webhook.
    return res.status(201).json({ ok: true, transaction: tx });
  } catch (err) {
    if (err.message === "INSUFFICIENT_FUNDS") {
      return res.status(409).json({ ok: false, error: "insufficient_funds" });
    }
    const code =
      err?.message === "Invalid amount" ? 400 :
      err?.message?.includes("Unknown provider") ? 400 : 400;
    return res.status(code).json({ ok: false, error: err.message });
  }
});

// List current user's transactions (cursor pagination)
router.get("/mine", limiter, auth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(1, Number(req.query.limit || 50)), 100);
    const cursor = req.query.cursor || undefined;
    const { items, nextCursor } = await getUserTransactions({
      userId: req.user.id,
      limit,
      cursor,
    });
    return res.status(200).json({ ok: true, items, nextCursor });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
