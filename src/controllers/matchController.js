const { db, now, parseJson } = require('../db');
const { asyncHandler } = require('../utils/asyncHandler');
const { httpError } = require('../middleware/error');
const map = require('../services/mappers');
const access = require('../services/access');
const { runDraw, advanceKnockoutStage } = require('../services/drawService');

const draw = asyncHandler((req, res) => {
  const tournamentId = req.body?.tournamentId || req.params.id;
  if (!tournamentId) throw httpError(400, 'tournamentId is required');
  access.getTournamentOrThrow(tournamentId);
  const result = runDraw({ tournamentId, stageId: req.body?.stageId });
  res.status(201).json({ draw: result });
});

const listMatches = asyncHandler((req, res) => {
  const tournament = access.getTournamentOrThrow(req.params.id);
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

function applyResultToTable(match, homeScore, awayScore, pointsSettings) {
  const pts = pointsSettings || { win: 3, draw: 1, loss: 0 };
  const home = db.prepare('SELECT * FROM participant_teams WHERE id = ?').get(match.home_participant_team_id);
  const away = db.prepare('SELECT * FROM participant_teams WHERE id = ?').get(match.away_participant_team_id);
  if (!home || !away) return;

  const homeWin = homeScore > awayScore;
  const draw = homeScore === awayScore;
  db.prepare(
    `UPDATE participant_teams SET
      played = played + 1,
      won = won + ?,
      drawn = drawn + ?,
      lost = lost + ?,
      goals_for = goals_for + ?,
      goals_against = goals_against + ?,
      points = points + ?,
      status = 'active'
     WHERE id = ?`
  ).run(
    homeWin ? 1 : 0,
    draw ? 1 : 0,
    homeWin ? 0 : draw ? 0 : 1,
    homeScore,
    awayScore,
    homeWin ? pts.win : draw ? pts.draw : pts.loss,
    home.id
  );
  db.prepare(
    `UPDATE participant_teams SET
      played = played + 1,
      won = won + ?,
      drawn = drawn + ?,
      lost = lost + ?,
      goals_for = goals_for + ?,
      goals_against = goals_against + ?,
      points = points + ?,
      status = 'active'
     WHERE id = ?`
  ).run(
    homeWin ? 0 : draw ? 0 : 1,
    draw ? 1 : 0,
    homeWin ? 1 : 0,
    awayScore,
    homeScore,
    homeWin ? pts.loss : draw ? pts.draw : pts.win,
    away.id
  );
}

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

  db.prepare(
    `UPDATE matches SET status = 'finished', home_score = ?, away_score = ?,
      extra_time_home = ?, extra_time_away = ?, penalties_home = ?, penalties_away = ?,
      finished_at = ?, referee_id = COALESCE(referee_id, ?)
     WHERE id = ?`
  ).run(
    homeScore,
    awayScore,
    req.body?.extraTimeHome ?? row.extra_time_home,
    req.body?.extraTimeAway ?? row.extra_time_away,
    req.body?.penaltiesHome ?? row.penalties_home,
    req.body?.penaltiesAway ?? row.penalties_away,
    now(),
    req.user.id,
    row.id
  );

  const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(row.stage_id);
  const settings = parseJson(stage?.settings, map.defaultStageSettings(stage?.type));
  if (stage?.type === 'league') {
    applyResultToTable(row, Number(homeScore), Number(awayScore), settings.points);
  }

  // Knockout stages advance themselves: once every match in the current
  // round is finished, the next round is generated automatically (or the
  // champion is crowned if this was the final round).
  let advance = null;
  if (stage?.type === 'knockout') {
    advance = advanceKnockoutStage(stage.id);
  }

  res.json({
    match: map.match(db.prepare('SELECT * FROM matches WHERE id = ?').get(row.id)),
    advance,
  });
});

const follow = asyncHandler((req, res) => {
  const tournament = access.getTournamentOrThrow(req.params.id);
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
    req.params.id,
    req.user.id
  );
  res.status(204).end();
});

const listFollowers = asyncHandler((req, res) => {
  access.getTournamentOrThrow(req.params.id);
  const rows = db
    .prepare(
      `SELECT f.*, u.email, u.name, u.role
       FROM tournament_follows f JOIN users u ON u.id = f.user_id
       WHERE f.tournament_id = ? ORDER BY f.created_at DESC`
    )
    .all(req.params.id);
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
    .run(status, req.params.id, req.params.userId);
  if (!info.changes) throw httpError(404, 'Follow request not found');
  const row = db
    .prepare('SELECT * FROM tournament_follows WHERE tournament_id = ? AND user_id = ?')
    .get(req.params.id, req.params.userId);
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
  moderateFollow,
};
