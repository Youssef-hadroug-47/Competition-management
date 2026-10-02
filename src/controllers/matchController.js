const { query, now } = require('../db');
const { asyncHandler } = require('../utils/asyncHandler');
const { httpError } = require('../middleware/error');
const map = require('../services/mappers');
const access = require('../services/access');
const { runDraw, resetStage } = require('../services/drawService');
const {
  finishMatchRecord,
  correctFinishedMatchRecord,
  assertTransition,
  assertRevision,
  assertAdministratorMutationAllowed,
  pauseMatchRecord,
  resumeMatchRecord,
  abandonMatchRecord,
  cancelMatchRecord,
  getMatchDetail: getMatchDetailRecord,
} = require('../services/matchService');
const suspension = require('../services/suspensionService');
const { getAllFollowedTournaments } = require('../services/followService');
const { isAdministrator } = require('../middleware/auth');

async function getMatchForTournamentOrThrow(matchId, tournamentId) {
  const row = (await query('SELECT * FROM matches WHERE id = $1 AND tournament_id = $2', [matchId, tournamentId])).rows[0];
  if (!row) throw httpError(404, 'Match not found');
  return row;
}

function scoreValue(value, field, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw httpError(400, `${field} is required`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw httpError(400, `${field} must be a non-negative integer`);
  }
  return parsed;
}

const draw = asyncHandler(async (req, res) => {
  const tournamentId = req.body?.tournamentId || req.params.tournamentId;
  if (!tournamentId) throw httpError(400, 'tournamentId is required');
  await access.getTournamentOrThrow(tournamentId);
  const result = await runDraw({ tournamentId, stageId: req.body?.stageId });
  res.status(201).json({ draw: result });
});

const resetStageHandler = asyncHandler(async (req, res) => {
  const tournamentId = req.params.tournamentId;
  await access.getTournamentOrThrow(tournamentId);
  const result = await resetStage({ tournamentId, stageId: req.params.id });
  res.json({ reset: result });
});

const listMatches = asyncHandler(async (req, res) => {
  const tournament = await access.getTournamentOrThrow(req.params.tournamentId);
  await access.requireTournamentInspect(tournament, req.user);
  const rows = (await query('SELECT * FROM matches WHERE tournament_id = $1 ORDER BY matchday, created_at', [tournament.id])).rows;
  res.json({ matches: rows.map(map.match) });
});

const getMatch = asyncHandler(async (req, res) => {
  const tournament = await access.getTournamentOrThrow(req.params.tournamentId);
  const row = await getMatchForTournamentOrThrow(req.params.id, tournament.id);
  await access.requireTournamentInspect(tournament, req.user);
  res.json({ match: map.match(row) });
});

const getMatchDetailHandler = asyncHandler(async (req, res) => {
  const tournament = await access.getTournamentOrThrow(req.params.tournamentId);
  const row = await getMatchForTournamentOrThrow(req.params.id, tournament.id);
  await access.requireTournamentInspect(tournament, req.user);
  res.json({ matchDetail: await getMatchDetailRecord(row.id) });
});

const startMatch = asyncHandler(async (req, res) => {
  const row = await getMatchForTournamentOrThrow(req.params.id, req.params.tournamentId);
  assertTransition(row.status, 'start');
  await suspension.assertCanStart(row.id, row.tournament_id);
  await query(`UPDATE matches SET status='live',phase='regulation',referee_id=$1,started_at=$2,
    phase_started_at=$3,phase_elapsed_seconds=0,venue=COALESCE($4,venue) WHERE id=$5`,
  [req.user.id, now(), now(), req.body?.venue || null, row.id]);
  await query('UPDATE tournaments SET status=$1,updated_at=$2 WHERE id=$3', ['in_progress', now(), row.tournament_id]);
  await suspension.consumeForStart(row.id, row.tournament_id);
  res.json({ match: map.match((await query('SELECT * FROM matches WHERE id=$1', [row.id])).rows[0]) });
});

const decideSuspension = asyncHandler(async (req, res) => {
  const row = await getMatchForTournamentOrThrow(req.params.id, req.params.tournamentId);
  const include = req.body?.decision === 'include';
  const suspensions = await suspension.decide({
    matchId: row.id,
    tournamentId: row.tournament_id,
    suspensionId: req.params.suspensionId,
    include,
    actorId: req.user.id,
  });
  res.json({ suspensions });
});

const updateMatch = asyncHandler(async (req, res) => {
  const row = await getMatchForTournamentOrThrow(req.params.id, req.params.tournamentId);
  const body = req.body || {};
  if (['homeScore', 'awayScore', 'extraTimeHome', 'extraTimeAway', 'penaltiesHome', 'penaltiesAway']
    .some((field) => body[field] !== undefined)) {
    throw httpError(410, 'Manual score updates have been removed. Change the match events instead.');
  }
  assertAdministratorMutationAllowed(row.status);
  if (!isAdministrator(req.user)) assertTransition(row.status, 'update');
  assertRevision(row, body.revision);
  const result = await query(`UPDATE matches SET venue=$1,scheduled_at=$2,revision=revision+1
     WHERE id=$3 AND revision=$4`,
  [
    body.venue ?? row.venue,
    body.scheduledAt ?? row.scheduled_at,
    row.id,
    Number(row.revision || 0)
  ]);
  if (!result.rowCount) throw httpError(409, 'Match changed while the update was being saved. Refresh and retry.');
  res.json({ match: map.match((await query('SELECT * FROM matches WHERE id=$1', [row.id])).rows[0]) });
});

const pauseMatch = asyncHandler(async (req, res) => {
  const row = await getMatchForTournamentOrThrow(req.params.id, req.params.tournamentId);
  const administrator = isAdministrator(req.user);
  const updated = await pauseMatchRecord(row, administrator, req.body?.revision);
  res.json({ match: map.match(updated) });
});

const resumeMatch = asyncHandler(async (req, res) => {
  const row = await getMatchForTournamentOrThrow(req.params.id, req.params.tournamentId);
  const administrator = isAdministrator(req.user);
  const updated = await resumeMatchRecord(row, administrator, req.body?.revision);
  res.json({ match: map.match(updated) });
});

const abandonMatch = asyncHandler(async (req, res) => {
  const row = await getMatchForTournamentOrThrow(req.params.id, req.params.tournamentId);
  const reason = req.body?.reason;
  const administrator = isAdministrator(req.user);
  const updated = await abandonMatchRecord(row, reason, administrator);
  res.json({ match: map.match(updated), reason: String(reason).trim() });
});

const finishMatch = asyncHandler(async (req, res) => {
  throw httpError(410, 'Manual score finishing has been removed. Record or correct match events, then finish the phase from the referee controls.');
});

const cancelMatch = asyncHandler(async (req, res) => {
  const row = await getMatchForTournamentOrThrow(req.params.id, req.params.tournamentId);
  assertAdministratorMutationAllowed(row.status);
  const updated = await cancelMatchRecord(row);
  res.json({ match: map.match(updated), reason: String(req.body?.reason || 'Cancelled by administrator') });
});

const listFollowedTournaments = asyncHandler(async ( req, res, next) => {
  const userId = req.user.id || null;
  
  if (!userId)
    throw httpError(401, 'Authentication is required ');
  
  const tournaments = await getAllFollowedTournaments(userId);

  res.status(200).json(tournaments);

});

const follow = asyncHandler(async (req, res) => {
  const tournament = await access.getTournamentOrThrow(req.params.tournamentId);
  const existing = (await query('SELECT * FROM tournament_follows WHERE tournament_id=$1 AND user_id=$2', [tournament.id, req.user.id])).rows[0];
  if (existing) return res.json({ follow: map.follow(existing) });

  const status = tournament.visibility === 'public' ? 'accepted' : 'pending';
  const followId = require('../utils/ids').id();
  await query('INSERT INTO tournament_follows (id,tournament_id,user_id,status) VALUES ($1,$2,$3,$4)', [followId, tournament.id, req.user.id, status]);
  res.status(201).json({ follow: map.follow((await query('SELECT * FROM tournament_follows WHERE id=$1', [followId])).rows[0]) });
});

const unfollow = asyncHandler(async (req, res) => {
  await query('DELETE FROM tournament_follows WHERE tournament_id=$1 AND user_id=$2', [req.params.tournamentId, req.user.id]);
  res.status(204).end();
});

const listFollowers = asyncHandler(async (req, res) => {
  await access.getTournamentOrThrow(req.params.tournamentId);
  const rows = (await query(
      `SELECT f.*, u.email, u.name, u.role
       FROM tournament_follows f JOIN users u ON u.id = f.user_id
       WHERE f.tournament_id = $1 ORDER BY f.created_at DESC`, [req.params.tournamentId])).rows;
  res.json({
    followers: rows.map((r) => ({
      ...map.follow(r),
      user: { id: r.user_id, email: r.email, name: r.name, role: r.role },
    })),
  });
});

const moderateFollow = asyncHandler(async (req, res) => {
  const status = req.body?.status;
  if (!['accepted', 'rejected'].includes(status)) throw httpError(400, 'status must be accepted or rejected');
  const info = await query('UPDATE tournament_follows SET status=$1 WHERE tournament_id=$2 AND user_id=$3', [status, req.params.tournamentId, req.params.userId]);
  if (!info.rowCount) throw httpError(404, 'Follow request not found');
  const row = (await query('SELECT * FROM tournament_follows WHERE tournament_id=$1 AND user_id=$2', [req.params.tournamentId, req.params.userId])).rows[0];
  res.json({ follow: map.follow(row) });
});

module.exports = {
  draw,
  resetStage: resetStageHandler,
  listMatches,
  getMatch,
  getMatchDetail: getMatchDetailHandler,
  startMatch,
  decideSuspension,
  pauseMatch,
  resumeMatch,
  abandonMatch,
  updateMatch,
  finishMatch,
  cancelMatch,
  follow,
  unfollow,
  listFollowers,
  listFollowedTournaments,
  moderateFollow,
};
