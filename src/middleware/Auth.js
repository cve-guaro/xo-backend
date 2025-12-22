// auth.js
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_PUBLIC_KEY || process.env.JWT_SECRET;

const pubKey = JWT_SECRET || 'test'; // or HS256 secret
if (!pubKey) {
  console.warn('JWT_PUBLIC_KEY not set — auth middleware will accept x-user-id for local testing.');
}

function auth(req, res, next) {
  try {
    // Prefer JWT in Authorization: Bearer
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : hdr;
    if (token && pubKey) {
      const payload = jwt.verify(token, pubKey);
      req.user = { id: payload.sub || payload.userId || payload.id, phone_number: payload.number };
      return next();
    }

    // Dev fallback: x-user-id header
    const fake = req.headers['x-user-id'];
    if (fake) {
      req.user = { id: fake };
      return next();
    }

    return res.status(401).json({ error: 'Unauthorized' });
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

module.exports = { auth };
