const jwt = require('jsonwebtoken');
const { db } = require('../db');
const config = require('../config');
const { httpError } = require('./error');
const { getRole } = require('../services/tournamentRolesService');

function isAdministrator(user) {
  return Boolean(user && String(user.role).toLowerCase() === 'admin');
}

function requireTournamentRole(...roles) {
  return (req, _, next) => {
    
    if (!req.user) return next(httpError(401, 'Authentication required'));

    
    const tournamentId = req.params.tournamentId || null;
    if (!tournamentId)
      return next(httpError(400, 'Bad Request'));

    const tournamentRoles = req.user.tournamentRoles || {};
    let role = tournamentRoles[tournamentId] || null;

    if (!role)
      role = getRole(tournamentId, req.user.id);
    
    if (!roles.includes(role))
      return next(httpError(403, 'forbidden access'));
    req.user.tournamentRoles = tournamentRoles;
    req.user.tournamentRoles[tournamentId] = role;
    return next();
  };
}

function requireTournamentModerator(req, _, next) {
  if (!req.user) return next(httpError(401, 'Authentication required'));
  if (isAdministrator(req.user)) return next();
  return requireTournamentRole('moderator')(req, _, next);
}

function requireTournamentReferee(req, _, next) {
  if (!req.user) return next(httpError(401, 'Authentication required'));
  if (isAdministrator(req.user)) return next();
  const tournamentId = req.params.tournamentId || null;
  if (!tournamentId) return next(httpError(400, 'Bad Request'));
  const role = getRole(tournamentId, req.user.id);
  if (role !== 'referee') return next(httpError(403, 'Assigned tournament referee access required'));
  req.user.tournamentRoles = req.user.tournamentRoles || {};
  req.user.tournamentRoles[tournamentId] = role;
  return next();
}

function requireTournamentSupervisor(req, _, next) {
  if (!req.user) return next(httpError(401, 'Authentication required'));
  if (isAdministrator(req.user)) return next();
  return requireTournamentRole('moderator')(req, _, next);
}

function requireOwner(req, _, next) {
  
  if (!req.user) return next(httpError(401, 'Authentication required'));

  const tournamentId = req.params.tournamentId || null;
  if (!tournamentId)
    return next(httpError(400, 'Bad Request'));

  const creator = db.prepare('SELECT created_by FROM tournaments WHERE id = ?').get(tournamentId);
  if (!creator) return next(httpError(404, 'Tournament not found'));
  return creator.created_by !== req.user.id ? next(httpError(403, 'Forbidden Access')) : next();
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

module.exports = {
  authOptional,
  requireOwner,
  requireAuth,
  requireRole,
  requireTournamentRole,
  requireTournamentModerator,
  requireTournamentReferee,
  requireTournamentSupervisor,
  isAdministrator,
};
