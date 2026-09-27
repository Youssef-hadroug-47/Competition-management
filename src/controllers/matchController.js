const { db, now } = require('../db');
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
const { getAllFollowedTournaments } = require('../services/followService');
const { isAdministrator } = require('../middleware/auth');

function getMatchForTournamentOrThrow(matchId, tournamentId) {
  const row = db.prepare('SELECT * FROM matches WHERE id = ? AND tournament_id = ?').get(matchId, tournamentId);
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

const draw = asyncHandler((req, res) => {
  const tournamentId = req.body?.tournamentId || req.params.tournamentId;
  if (!tournamentId) throw httpError(400, 'tournamentId is required');
  access.getTournamentOrThrow(tournamentId);
  const result = runDraw({ tournamentId, stageId: req.body?.stageId });
  res.status(201).json({ draw: result });
});

const resetStageHandler = asyncHandler((req, res) => {
  const tournamentId = req.params.tournamentId;
  access.getTournamentOrThrow(tournamentId);
  const result = resetStage({ tournamentId, stageId: req.params.id });
  res.json({ reset: result });
});

const listMatches = asyncHandler((req, res) => {
  const tournament = access.getTournamentOrThrow(req.params.tournamentId);
  access.requireTournamentInspect(tournament, req.user);
  const rows = db
    .prepare('SELECT * FROM matches WHERE tournament_id = ? ORDER BY matchday, created_at')
    .all(tournament.id);
  res.json({ matches: rows.map(map.match) });
});

const getMatch = asyncHandler((req, res) => {
  const tournament = access.getTournamentOrThrow(req.params.tournamentId);
  const row = getMatchForTournamentOrThrow(req.params.id, tournament.id);
  access.requireTournamentInspect(tournament, req.user);
  res.json({ match: map.match(row) });
});

const getMatchDetailHandler = asyncHandler((req, res) => {
  const tournament = access.getTournamentOrThrow(req.params.tournamentId);
  const row = getMatchForTournamentOrThrow(req.params.id, tournament.id);
  access.requireTournamentInspect(tournament, req.user);
  res.json({ matchDetail: getMatchDetailRecord(row.id) });
});

const startMatch = asyncHandler((req, res) => {
  const row = getMatchForTournamentOrThrow(req.params.id, req.params.tournamentId);
  assertTransition(row.status, 'start');
  const result = db.prepare(
    `UPDATE matches SET status = 'live', phase = 'regulation', referee_id = ?, started_at = ?,
      phase_started_at = ?, phase_elapsed_seconds = 0, venue = COALESCE(?, venue) WHERE id = ?`
  ).run(req.user.id, now(), now(), req.body?.venue || null, row.id);
  db.prepare(`UPDATE tournaments SET status = 'in_progress', updated_at = ? WHERE id = ?`).run(
    now(),
    row.tournament_id
  );
  res.json({ match: map.match(db.prepare('SELECT * FROM matches WHERE id = ?').get(row.id)) });
});

const updateMatch = asyncHandler((req, res) => {
  const row = getMatchForTournamentOrThrow(req.params.id, req.params.tournamentId);
  const body = req.body || {};
  if (['homeScore', 'awayScore', 'extraTimeHome', 'extraTimeAway', 'penaltiesHome', 'penaltiesAway']
    .some((field) => body[field] !== undefined)) {
    throw httpError(410, 'Manual score updates have been removed. Change the match events instead.');
  }
  assertAdministratorMutationAllowed(row.status);
  if (!isAdministrator(req.user)) assertTransition(row.status, 'update');
  assertRevision(row, body.revision);
  const result = db.prepare(
    `UPDATE matches SET
      venue = ?, scheduled_at = ?, revision = revision + 1
     WHERE id = ? AND revision = ?`
  ).run(
    body.venue ?? row.venue,
    body.scheduledAt ?? row.scheduled_at,
    row.id,
    Number(row.revision || 0)
  );
  if (!result.changes) throw httpError(409, 'Match changed while the update was being saved. Refresh and retry.');
  res.json({ match: map.match(db.prepare('SELECT * FROM matches WHERE id = ?').get(row.id)) });
});

const pauseMatch = asyncHandler((req, res) => {
  const row = getMatchForTournamentOrThrow(req.params.id, req.params.tournamentId);
  const administrator = isAdministrator(req.user);
  const updated = pauseMatchRecord(row, administrator, req.body?.revision);
  res.json({ match: map.match(updated) });
});

const resumeMatch = asyncHandler((req, res) => {
  const row = getMatchForTournamentOrThrow(req.params.id, req.params.tournamentId);
  const administrator = isAdministrator(req.user);
  const updated = resumeMatchRecord(row, administrator, req.body?.revision);
  res.json({ match: map.match(updated) });
});

const abandonMatch = asyncHandler((req, res) => {
  const row = getMatchForTournamentOrThrow(req.params.id, req.params.tournamentId);
  const reason = req.body?.reason;
  const administrator = isAdministrator(req.user);
  const updated = abandonMatchRecord(row, reason, administrator);
  res.json({ match: map.match(updated), reason: String(reason).trim() });
});

const finishMatch = asyncHandler((req, res) => {
  throw httpError(410, 'Manual score finishing has been removed. Record or correct match events, then finish the phase from the referee controls.');
});

const cancelMatch = asyncHandler((req, res) => {
  const row = getMatchForTournamentOrThrow(req.params.id, req.params.tournamentId);
  assertAdministratorMutationAllowed(row.status);
  const updated = cancelMatchRecord(row);
  res.json({ match: map.match(updated), reason: String(req.body?.reason || 'Cancelled by administrator') });
});

const listFollowedTournaments = asyncHandler(( req, res, next) => {
  const userId = req.user.id || null;
  
  if (!userId)
    throw httpError(401, 'Authentication is required ');
  
  const tournaments = getAllFollowedTournaments(userId);

  res.status(200).json(tournaments);

});

const follow = asyncHandler((req, res) => {
  const tournament = access.getTournamentOrThrow(req.params.tournamentId);
  const existing = db
    .prepare('SELECT * FROM tournament_follows WHERE tournament_id = ? AND user_id = ?')
    .get(tournament.id, req.user.id);
  if (existing) return res.json({ follow: map.follow(existing) });

  const status = tournament.visibility === 'public' ? 'accepted' : 'pending';
  const followId = require('../utils/ids').id();
  db.prepare(
    `INSERT INTO tournament_follows (id, tournament_id, user_id, status) VALUES (?, ?, ?, ?)`
  ).run(followId, tournament.id, req.user.id, status);
  res.status(201).json({ follow: map.follow(db.prepare('SELECT * FROM tournament_follows WHERE id = ?').get(followId)) });
});

const unfollow = asyncHandler((req, res) => {
  db.prepare('DELETE FROM tournament_follows WHERE tournament_id = ? AND user_id = ?').run(
    req.params.tournamentId,
    req.user.id
  );
  res.status(204).end();
});

const listFollowers = asyncHandler((req, res) => {
  access.getTournamentOrThrow(req.params.tournamentId);
  const rows = db
    .prepare(
      `SELECT f.*, u.email, u.name, u.role
       FROM tournament_follows f JOIN users u ON u.id = f.user_id
       WHERE f.tournament_id = ? ORDER BY f.created_at DESC`
    )
    .all(req.params.tournamentId);
  res.json({
    followers: rows.map((r) => ({
      ...map.follow(r),
      user: { id: r.user_id, email: r.email, name: r.name, role: r.role },
    })),
  });
});

const moderateFollow = asyncHandler((req, res) => {
  const status = req.body?.status;
  if (!['accepted', 'rejected'].includes(status)) throw httpError(400, 'status must be accepted or rejected');
  const info = db
    .prepare('UPDATE tournament_follows SET status = ? WHERE tournament_id = ? AND user_id = ?')
    .run(status, req.params.tournamentId, req.params.userId);
  if (!info.changes) throw httpError(404, 'Follow request not found');
  const row = db
    .prepare('SELECT * FROM tournament_follows WHERE tournament_id = ? AND user_id = ?')
    .get(req.params.tournamentId, req.params.userId);
  res.json({ follow: map.follow(row) });
});

module.exports = {
  draw,
  resetStage: resetStageHandler,
  listMatches,
  getMatch,
  getMatchDetail: getMatchDetailHandler,
  startMatch,
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
