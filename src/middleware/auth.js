const jwt = require('jsonwebtoken');
const { db } = require('../db');
const config = require('../config');
const { httpError } = require('./error');

function authOptional(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(payload.sub);
    req.user = user || null;
  } catch {
    req.user = null;
  }
  next();
}

function requireAuth(req, res, next) {
  authOptional(req, res, () => {
    if (!req.user) return next(httpError(401, 'Authentication required'));
    next();
  });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(httpError(401, 'Authentication required'));
    if (!roles.includes(req.user.role)) {
      return next(httpError(403, `Requires role: ${roles.join(' or ')}`));
    }
    next();
  };
}

module.exports = { authOptional, requireAuth, requireRole };
