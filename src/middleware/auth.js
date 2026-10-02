const jwt = require('jsonwebtoken');
const { query } = require('../db');
const config = require('../config');
const { httpError } = require('./error');
const { getRole } = require('../services/tournamentRolesService');
const { asyncHandler } = require('../utils/asyncHandler');

function isAdministrator(user) {
  return Boolean(user && String(user.role).toLowerCase() === 'admin');
}

function requireTournamentRole(...roles) {
  return asyncHandler(async (req, _, next) => {
    if (!req.user) return next(httpError(401, 'Authentication required'));

    const tournamentId = req.params.tournamentId || null;
    if (!tournamentId) return next(httpError(400, 'Bad Request'));

    const tournamentRoles = req.user.tournamentRoles || {};
    let role = tournamentRoles[tournamentId] || null;

    if (!role) role = await getRole(tournamentId, req.user.id);

    if (!roles.includes(role))
      return next(httpError(403, 'forbidden access'));
    req.user.tournamentRoles = tournamentRoles;
    req.user.tournamentRoles[tournamentId] = role;
    return next();
  });
}

function requireTournamentModerator(req, _, next) {
  if (!req.user) return next(httpError(401, 'Authentication required'));
  if (isAdministrator(req.user)) return next();
  return requireTournamentRole('moderator')(req, _, next);
}

const requireTournamentReferee = asyncHandler(async (req, _, next) => {
  if (!req.user) return next(httpError(401, 'Authentication required'));
  if (isAdministrator(req.user)) return next();
  const tournamentId = req.params.tournamentId || null;
  if (!tournamentId) return next(httpError(400, 'Bad Request'));
  const role = await getRole(tournamentId, req.user.id);
  if (role !== 'referee') return next(httpError(403, 'Assigned tournament referee access required'));
  req.user.tournamentRoles = req.user.tournamentRoles || {};
  req.user.tournamentRoles[tournamentId] = role;
  return next();
});

const requireTournamentModeratorOrReferee = asyncHandler(async (req, _, next) => {
  if (!req.user) return next(httpError(401, 'Authentication required'));
  if (isAdministrator(req.user)) return next();
  const tournamentId = req.params.tournamentId || null;
  if (!tournamentId) return next(httpError(400, 'Bad Request'));
  const result = await query('SELECT created_by FROM tournaments WHERE id = $1', [tournamentId]);
  const tournament = result.rows[0];
  if (!tournament) return next(httpError(404, 'Tournament not found'));
  if (tournament.created_by === req.user.id) {
    req.user.tournamentRoles = req.user.tournamentRoles || {};
    req.user.tournamentRoles[tournamentId] = 'moderator';
    return next();
  }
  const role = await getRole(tournamentId, req.user.id);
  if (!['moderator', 'referee'].includes(role)) {
    return next(httpError(403, 'Tournament moderator or referee access required'));
  }
  req.user.tournamentRoles = req.user.tournamentRoles || {};
  req.user.tournamentRoles[tournamentId] = role;
  return next();
});

function requireTournamentSupervisor(req, _, next) {
  if (!req.user) return next(httpError(401, 'Authentication required'));
  if (isAdministrator(req.user)) return next();
  return requireTournamentRole('moderator')(req, _, next);
}

const requireOwner = asyncHandler(async (req, _, next) => {
  if (!req.user) return next(httpError(401, 'Authentication required'));

  const tournamentId = req.params.tournamentId || null;
  if (!tournamentId) return next(httpError(400, 'Bad Request'));

  const result = await query('SELECT created_by FROM tournaments WHERE id = $1', [tournamentId]);
  const creator = result.rows[0];
  if (!creator) return next(httpError(404, 'Tournament not found'));
  return creator.created_by !== req.user.id ? next(httpError(403, 'Forbidden Access')) : next();
});

async function authenticate(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    req.user = null;
    return;
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const result = await query(
      'SELECT id, email, name, role FROM users WHERE id = $1',
      [payload.sub],
    );
    req.user = result.rows[0] || null;
  } catch {
    req.user = null;
  }
}

const authOptional = asyncHandler(async (req, _, next) => {
  await authenticate(req);
  next();
});

const requireAuth = asyncHandler(async (req, _, next) => {
  await authenticate(req);
  if (!req.user) return next(httpError(401, 'Authentication required'));
  next();
});

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
  requireTournamentModeratorOrReferee,
  requireTournamentSupervisor,
  isAdministrator,
};
