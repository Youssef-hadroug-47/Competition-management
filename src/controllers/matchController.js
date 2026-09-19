const { db, now } = require('../db');
const { asyncHandler } = require('../utils/asyncHandler');
const { httpError } = require('../middleware/error');
const map = require('../services/mappers');
const access = require('../services/access');
const { runDraw } = require('../services/drawService');
const { finishMatchRecord } = require('../services/matchService');
const { getAllFollowedTournaments } = require('../services/followService');

const draw = asyncHandler((req, res) => {
  const tournamentId = req.body?.tournamentId || req.params.tournamentId;
  if (!tournamentId) throw httpError(400, 'tournamentId is required');
  access.getTournamentOrThrow(tournamentId);
  const result = runDraw({ tournamentId, stageId: req.body?.stageId });
  res.status(201).json({ draw: result });
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
  const row = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Match not found');
  const tournament = access.getTournamentOrThrow(row.tournament_id);
  access.requireTournamentInspect(tournament, req.user);
  res.json({ match: map.match(row) });
});

const startMatch = asyncHandler((req, res) => {
  const row = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Match not found');
  if (row.status === 'finished') throw httpError(400, 'Match already finished');
  db.prepare(
    `UPDATE matches SET status = 'live', referee_id = ?, started_at = ?, venue = COALESCE(?, venue) WHERE id = ?`
  ).run(req.user.id, now(), req.body?.venue || null, row.id);
  db.prepare(`UPDATE tournaments SET status = 'in_progress', updated_at = ? WHERE id = ?`).run(
    now(),
    row.tournament_id
  );
  res.json({ match: map.match(db.prepare('SELECT * FROM matches WHERE id = ?').get(row.id)) });
});

const updateMatch = asyncHandler((req, res) => {
  const row = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Match not found');
  const body = req.body || {};
  db.prepare(
    `UPDATE matches SET
      home_score = ?, away_score = ?, extra_time_home = ?, extra_time_away = ?,
      penalties_home = ?, penalties_away = ?, venue = ?, scheduled_at = ?
     WHERE id = ?`
  ).run(
    body.homeScore ?? row.home_score,
    body.awayScore ?? row.away_score,
    body.extraTimeHome ?? row.extra_time_home,
    body.extraTimeAway ?? row.extra_time_away,
    body.penaltiesHome ?? row.penalties_home,
    body.penaltiesAway ?? row.penalties_away,
    body.venue ?? row.venue,
    body.scheduledAt ?? row.scheduled_at,
    row.id
  );
  res.json({ match: map.match(db.prepare('SELECT * FROM matches WHERE id = ?').get(row.id)) });
});

const finishMatch = asyncHandler((req, res) => {
  const row = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Match not found');
  if (row.status === 'finished') throw httpError(400, 'Match already finished');
  const homeScore = req.body?.homeScore ?? row.home_score;
  const awayScore = req.body?.awayScore ?? row.away_score;
  if (homeScore == null || awayScore == null) throw httpError(400, 'homeScore and awayScore are required');

  const { match: updated, advance } = finishMatchRecord({
    matchRow: row,
    homeScore: Number(homeScore),
    awayScore: Number(awayScore),
    extraTimeHome: req.body?.extraTimeHome ?? row.extra_time_home,
    extraTimeAway: req.body?.extraTimeAway ?? row.extra_time_away,
    penaltiesHome: req.body?.penaltiesHome ?? row.penalties_home,
    penaltiesAway: req.body?.penaltiesAway ?? row.penalties_away,
    refereeId: req.user.id,
  });

  res.json({ match: map.match(updated), advance });
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
  listMatches,
  getMatch,
  startMatch,
  updateMatch,
  finishMatch,
  follow,
  unfollow,
  listFollowers,
  listFollowedTournaments,
  moderateFollow,
};
