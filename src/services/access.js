const { query } = require('../db');
const { httpError } = require('../middleware/error');
const { getRole } = require('./tournamentRolesService');

async function getFollow(tournamentId, userId) {
  if (!userId) return null;
  const result = await query(
    'SELECT * FROM tournament_follows WHERE tournament_id = $1 AND user_id = $2',
    [tournamentId, userId],
  );
  return result.rows[0] || null;
}

async function canInspectTournament(tournament, user) {
  if (!tournament) return false;
  if (tournament.visibility === 'public') return true;
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.id === tournament.created_by) return true;
  if (['moderator', 'referee', 'team_leader'].includes(await getRole(tournament.id, user.id))) return true;
  const follow = await getFollow(tournament.id, user.id);
  return Boolean(follow && follow.status === 'accepted');
}

async function requireTournamentInspect(tournament, user) {
  if (!(await canInspectTournament(tournament, user))) {
    throw httpError(403, 'This tournament is private. Follow and wait for approval to inspect it.');
  }
}

async function requireTeamLeader(tournamentId, user) {
  if (!user || user.role !== 'admin') {
    const role = user ? await getRole(tournamentId, user.id) : null;
    if (role !== 'team_leader') throw httpError(403, 'Assigned tournament team leader access required');
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

async function getTournamentOrThrow(id) {
  const result = await query('SELECT * FROM tournaments WHERE id = $1', [id]);
  const row = result.rows[0];
  if (!row) throw httpError(404, 'Tournament not found');
  return row;
}

module.exports = {
  getFollow,
  canInspectTournament,
  requireTournamentInspect,
  requireTeamLeader,
  requireAdmin,
  requireRefereeOrAdmin,
  getTournamentOrThrow,
};
