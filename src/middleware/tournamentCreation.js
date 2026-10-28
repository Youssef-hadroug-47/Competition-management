const config = require('../config');
const { canCreateTournament } = require('../services/accessPolicy');
const { httpError } = require('./error');

function requireTournamentCreation(req, res, next) {
  if (!req.user) {
    return next(httpError(401, 'Authentication required', { code: 'AUTH_REQUIRED' }));
  }
  if (!['admin', '*'].includes(config.tournamentCreation)) {
    return next(httpError(
      503,
      'Tournament creation is temporarily unavailable.',
      { code: 'TOURNAMENT_CREATION_MISCONFIGURED' },
    ));
  }
  if (!canCreateTournament(req.user)) {
    return next(httpError(
      403,
      'You are not allowed to create tournaments.',
      { code: 'TOURNAMENT_CREATION_FORBIDDEN' },
    ));
  }
  return next();
}

module.exports = { requireTournamentCreation };
