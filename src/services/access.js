const { db } = require('../db');
const { httpError } = require('../middleware/error');
const { getRole } = require('./tournamentRolesService');

function getFollow(tournamentId, userId) {
  if (!userId) return null;
  return db
    .prepare('SELECT * FROM tournament_follows WHERE tournament_id = ? AND user_id = ?')
    .get(tournamentId, userId);
}

function canInspectTournament(tournament, user) {
  if (!tournament) return false;
  if (tournament.visibility === 'public') return true;
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.id === tournament.created_by) return true;
  if (getRole(tournament.id, user.id) === 'moderator') return true;
  const follow = getFollow(tournament.id, user.id);
  return Boolean(follow && follow.status === 'accepted');
}

function requireTournamentInspect(tournament, user) {
  if (!canInspectTournament(tournament, user)) {
    throw httpError(403, 'This tournament is private. Follow and wait for approval to inspect it.');
  }
}

function requireAdmin(user) {
  if (!user || user.role !== 'admin') throw httpError(403, 'Admin access required');
}

function requireRefereeOrAdmin(user) {
  if (!user || !['admin', 'referee'].includes(user.role)) {
    throw httpError(403, 'Referee or admin access required');
  }
}

function getTournamentOrThrow(id) {
  const row = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id);
  if (!row) throw httpError(404, 'Tournament not found');
  return row;
}

module.exports = {
  getFollow,
  canInspectTournament,
  requireTournamentInspect,
  requireAdmin,
  requireRefereeOrAdmin,
  getTournamentOrThrow,
};
