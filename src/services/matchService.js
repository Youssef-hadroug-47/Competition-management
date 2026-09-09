const { db, now, parseJson } = require('../db');
const map = require('./mappers');
const { advanceKnockoutStage } = require('./drawService');

// Applies a finished match's score to both teams' league-table stats.
// Shared by the manual "finish match" flow and the simulator so both
// update standings identically.
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

// Marks a match finished, writes the score(s), updates the league table
// (league stages) and advances the bracket (knockout stages). Returns the
// refreshed match row (raw, not mapped) plus the knockout-advance result.
// Used both by the "finish match" HTTP route and by the simulator, so a
// simulated match behaves exactly like a manually-entered one.
function finishMatchRecord({
  matchRow,
  homeScore,
  awayScore,
  extraTimeHome = null,
  extraTimeAway = null,
  penaltiesHome = null,
  penaltiesAway = null,
  refereeId,
}) {
  db.prepare(
    `UPDATE matches SET status = 'finished', home_score = ?, away_score = ?,
      extra_time_home = ?, extra_time_away = ?, penalties_home = ?, penalties_away = ?,
      finished_at = ?, referee_id = COALESCE(referee_id, ?)
     WHERE id = ?`
  ).run(
    homeScore,
    awayScore,
    extraTimeHome,
    extraTimeAway,
    penaltiesHome,
    penaltiesAway,
    now(),
    refereeId || null,
    matchRow.id
  );

  const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(matchRow.stage_id);
  const settings = parseJson(stage?.settings, map.defaultStageSettings(stage?.type));
  if (stage?.type === 'league') {
    applyResultToTable(matchRow, Number(homeScore), Number(awayScore), settings.points);
  }

  // Knockout stages advance themselves: once every match in the current
  // round is finished, the next round is generated automatically (or the
  // champion is crowned if this was the final round).
  let advance = null;
  if (stage?.type === 'knockout') {
    advance = advanceKnockoutStage(stage.id);
  }

  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchRow.id);
  return { match, advance, stage };
}

module.exports = { applyResultToTable, finishMatchRecord };
