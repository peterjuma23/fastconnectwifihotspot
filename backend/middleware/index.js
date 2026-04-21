// middleware/index.js — Reusable middleware for FastConnect API

const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const { createClient } = require('redis');

// ── Validation Error Handler ────────────────────────────────────
function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array().map(e => ({ field: e.path, msg: e.msg })),
    });
  }
  next();
}

// ── JWT Auth (RS256) ────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header required' });
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_PUBLIC_KEY?.replace(/\\n/g, '\n'), { algorithms: ['RS256'] });
    // Session binding
    if (payload.ip !== req.ip || payload.ua !== req.get('User-Agent')) {
      return res.status(401).json({ error: 'Session binding mismatch' });
    }
    // Check revocation list
    const redis = req.app.get('redis');
    const revoked = await redis.get(`revoked:${token}`);
    if (revoked) return res.status(401).json({ error: 'Token has been revoked' });
    req.user = payload;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Admin Role Guard ────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ── Staff or Admin ──────────────────────────────────────────────
function requireStaff(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!['admin','staff'].includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  next();
}

// ── Request Logging ─────────────────────────────────────────────
function requestLogger(logger) {
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info('HTTP Request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
        ip: req.ip,
        ua: req.get('User-Agent')?.slice(0, 80),
      });
    });
    next();
  };
}

// ── Production Error Handler ────────────────────────────────────
function errorHandler(logger) {
  return (err, req, res, next) => {
    logger.error('Unhandled error', {
      message: err.message,
      stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
      path: req.path,
      method: req.method,
    });
    // Never leak internal errors to client
    res.status(err.status || 500).json({
      error: process.env.NODE_ENV === 'production'
        ? 'An internal error occurred'
        : err.message,
    });
  };
}

// ── Not Found Handler ───────────────────────────────────────────
function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Resource not found', path: req.path });
}

module.exports = {
  handleValidationErrors,
  requireAuth,
  requireAdmin,
  requireStaff,
  requestLogger,
  errorHandler,
  notFoundHandler,
};
