const jwt = require('jsonwebtoken');
const { db } = require('../db');
const config = require('../config');
const { httpError } = require('./error');
const { getRole } = require('../services/tournamentRolesService');

function requireTournamentRole(...roles) {
  return (req, _, next) => {
    
    if (!req.user) return next(httpError(401, 'Authentication required'));

    
    const tournamentId = req.params.tournamentId || null;
    if (!tournamentId)
      return next(httpError(400, 'Bad Request'));

    let role = req.user.tournamentRoles[tournamentId] || null;

    if (!role)
      role = getRole(tournamentId, req.user.id);
    
    if (!roles.includes(role))
      return next(httpError(403, 'forbidden access'));
    req.user.tournamentRoles[tournamentId] = role; 
  }

}


function requireOwner(req, _, next) {
  
  if (!req.user) return next(httpError(401, 'Authentication required'));

  const tournamentId = req.params.tournamentId || null;
  if (!tournamentId)
    return next(httpError(400, 'Bad Request'));

  const creator = db.prepare('SELECT created_by FROM tournaments t WHERE id = ?').get(tournamentId);
  return (creator != req.user.id) ? next(httpError(403, 'Forbidden Access')) : next();
}

function authOptional(req, _, next) {
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

module.exports = { authOptional, requireOwner, requireAuth, requireRole, requireTournamentRole};
