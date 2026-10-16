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
  const result = await query(
    `SELECT tr.role, tf.status AS follow_status
     FROM (SELECT $1::text AS tournament_id, $2::text AS user_id) viewer
     LEFT JOIN tournament_role tr
       ON tr.tournament_id = viewer.tournament_id AND tr.user_id = viewer.user_id
     LEFT JOIN tournament_follows tf
       ON tf.tournament_id = viewer.tournament_id AND tf.user_id = viewer.user_id`,
    [tournament.id, user.id],
  );
  const viewerAccess = result.rows[0];
  return ['moderator', 'referee', 'team_leader'].includes(viewerAccess?.role)
    || viewerAccess?.follow_status === 'accepted';
}

async function requireTournamentInspect(tournament, user) {
  if (!(await canInspectTournament(tournament, user))) {
    throw httpError(403, 'This tournament is private. Follow and wait for approval to inspect it.');
  }
}

async function requireTournamentManage(tournament, user) {
  if (!user) throw httpError(401, 'Authentication required');
  if (user.role === 'admin' || user.id === tournament.created_by) return;
  if (await getRole(tournament.id, user.id) === 'moderator') return;
  throw httpError(403, 'Tournament moderator access required');
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
  requireTournamentManage,
  requireTeamLeader,
  requireAdmin,
  requireRefereeOrAdmin,
  getTournamentOrThrow,
};
