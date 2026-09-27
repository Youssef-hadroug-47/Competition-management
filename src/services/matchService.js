const { db, now, parseJson } = require('../db');
const map = require('./mappers');
const { httpError } = require('../middleware/error');
const { finalizeStageIfComplete } = require('./drawService');
const { id } = require('../utils/ids');

// Valid match-lifecycle transitions for the moderator monitoring menu.
// Keeping this in one place means start/pause/resume/abandon/finish all
// reject the same way instead of each route inventing its own rules.
const TRANSITIONS = {
  start: { from: ['scheduled', 'postponed'], to: 'live' },
  pause: { from: ['live'], to: 'paused' },
  resume: { from: ['paused'], to: 'live' },
  abandon: { from: ['live', 'paused'], to: 'scheduled' },
  update: { from: ['live', 'paused'], to: null },
  finish: { from: ['live', 'paused'], to: 'finished' },
};

function assertTransition(currentStatus, action) {
  const rule = TRANSITIONS[action];
  if (!rule || !rule.from.includes(currentStatus)) {
    throw httpError(409, `Cannot ${action} a match with status "${currentStatus}".`);
  }
}

function assertAdministratorMutationAllowed(status) {
  if (['live', 'paused'].includes(status)) {
    throw httpError(409, 'Administrator changes are disabled while the match is active. The assigned referee has control.');
  }
}

function assertRevision(match, expectedRevision) {
  if (expectedRevision == null) return;
  const expected = Number(expectedRevision);
  if (!Number.isInteger(expected) || expected < 0 || expected !== Number(match.revision || 0)) {
    throw httpError(409, 'Match changed since it was loaded. Refresh before making another change.');
  }
}

function writeAudit({ matchBefore, matchAfter, userId, action, reason }) {
  db.prepare(
    `INSERT INTO match_audit
      (id, match_id, tournament_id, user_id, action, reason, before_state, after_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id(),
    matchBefore.id,
    matchBefore.tournament_id,
    userId || null,
    action,
    reason || null,
    JSON.stringify(matchBefore),
    JSON.stringify(matchAfter)
  );
}

function rebuildTournamentProjections(tournamentId) {
  const teams = db.prepare('SELECT id FROM participant_teams WHERE tournament_id = ?').all(tournamentId);
  const players = db.prepare(
    `SELECT pp.id FROM participant_players pp
     JOIN participant_teams pt ON pt.id = pp.participant_team_id
     WHERE pt.tournament_id = ?`
  ).all(tournamentId);
  db.exec('BEGIN');
  try {
    teams.forEach(({ id: teamId }) => db.prepare(
      `UPDATE participant_teams SET played = 0, won = 0, drawn = 0, lost = 0,
       goals_for = 0, goals_against = 0, points = 0, winner = false
       WHERE id = ?`
    ).run(teamId));
    players.forEach(({ id: playerId }) => db.prepare(
      `UPDATE participant_players SET yellow_cards = 0, red_cards = 0, goals = 0, assists = 0
       WHERE id = ?`
    ).run(playerId));

    const matches = db.prepare(
      `SELECT m.*, s.type, s.settings FROM matches m
       JOIN stages s ON s.id = m.stage_id
       WHERE m.tournament_id = ? AND m.status = 'finished'`
    ).all(tournamentId);
    for (const match of matches) {
      const events = db.prepare('SELECT * FROM match_events WHERE match_id = ?').all(match.id);
      const stats = { home: 0, away: 0, extraHome: 0, extraAway: 0, penaltiesHome: 0, penaltiesAway: 0 };
      for (const event of events) {
        const payload = parseJson(event.payload, {});
        if (event.type === 'goal') {
          const home = payload.ownGoal
            ? event.team_id !== match.home_participant_team_id
            : event.team_id === match.home_participant_team_id;
          if (event.phase === 'extra_time') stats[home ? 'extraHome' : 'extraAway'] += 1;
          else if (event.phase !== 'shootout') stats[home ? 'home' : 'away'] += 1;
        } else if (event.type === 'shootout_attempt' && payload.scored) {
          stats[event.team_id === match.home_participant_team_id ? 'penaltiesHome' : 'penaltiesAway'] += 1;
        }
        if (event.player_id) {
          if (event.type === 'goal' && !payload.ownGoal) db.prepare('UPDATE participant_players SET goals = goals + 1 WHERE id = ?').run(event.player_id);
          if (event.type === 'assist' && !payload.skipped) db.prepare('UPDATE participant_players SET assists = assists + 1 WHERE id = ?').run(event.player_id);
          if (event.type === 'card') db.prepare(`UPDATE participant_players SET ${event.card === 'red' ? 'red_cards' : 'yellow_cards'} = ${event.card === 'red' ? 'red_cards' : 'yellow_cards'} + 1 WHERE id = ?`).run(event.player_id);
        }
      }
      const updateMatch = db.prepare(
        `UPDATE matches SET home_score = ?, away_score = ?, extra_time_home = ?,
         extra_time_away = ?, penalties_home = ?, penalties_away = ?
         WHERE id = ?`
      );
      updateMatch.run(stats.home, stats.away, stats.extraHome, stats.extraAway, stats.penaltiesHome, stats.penaltiesAway, match.id);
      if (match.type !== 'league') continue;
      const settings = parseJson(match.settings, map.defaultStageSettings('league'));
      const points = settings.points || { win: 3, draw: 1, loss: 0 };
      const homeWin = stats.home > stats.away;
      const draw = stats.home === stats.away;
      const apply = (teamId, scored, conceded, win, loss) => db.prepare(
        `UPDATE participant_teams SET played = played + 1, won = won + ?, drawn = drawn + ?,
         lost = lost + ?, goals_for = goals_for + ?, goals_against = goals_against + ?,
         points = points + ?, status = 'active' WHERE id = ?`
      ).run(win, draw ? 1 : 0, loss, scored, conceded, win ? points.win : draw ? points.draw : points.loss, teamId);
      apply(match.home_participant_team_id, stats.home, stats.away, homeWin ? 1 : 0, homeWin || draw ? 0 : 1);
      apply(match.away_participant_team_id, stats.away, stats.home, homeWin ? 0 : draw ? 0 : 1, homeWin ? 1 : 0);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Applies a finished match's score to both teams' league-table stats.
// Shared by the manual "finish match" flow and the simulator so both
// update standings identically.
function applyResultToTableInternal(match, homeScore, awayScore, pointsSettings) {
  const pts = pointsSettings || { win: 3, draw: 1, loss: 0 };
  const home = db.prepare('SELECT * FROM participant_teams WHERE id = ?').get(match.home_participant_team_id);
  const away = db.prepare('SELECT * FROM participant_teams WHERE id = ?').get(match.away_participant_team_id);
  if (!home || !away) return;

  const homeWin = homeScore > awayScore;
  const draw = homeScore === awayScore;

  try {
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
  } catch (err) {
    throw err;
  }
}

function applyResultToTable(match, homeScore, awayScore, pointsSettings) {
  db.exec('BEGIN');
  try {
    applyResultToTableInternal(match, homeScore, awayScore, pointsSettings);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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
  userId = refereeId,
  action = 'finish',
  expectedRevision,
}) {
  assertRevision(matchRow, expectedRevision);
  const update = db.prepare(
    `UPDATE matches SET status = 'finished', home_score = ?, away_score = ?,
      extra_time_home = ?, extra_time_away = ?, penalties_home = ?, penalties_away = ?,
      finished_at = ?, referee_id = COALESCE(referee_id, ?), revision = revision + 1
     WHERE id = ? AND revision = ?`
  ).run(
    homeScore,
    awayScore,
    extraTimeHome,
    extraTimeAway,
    penaltiesHome,
    penaltiesAway,
    now(),
    refereeId || null,
    matchRow.id,
    Number(matchRow.revision || 0)
  );

  const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(matchRow.stage_id);
  const settings = parseJson(stage?.settings, map.defaultStageSettings(stage?.type));
  if (stage?.type === 'league') {
    applyResultToTable(matchRow, Number(homeScore), Number(awayScore), settings.points);
  }

  // Knockout stages advance themselves: once every match in the current
  // round is finished, the next round is generated automatically (or the
  // champion is crowned if this was the final round).
  const advance = finalizeStageIfComplete(stage.id); 

  if (!update.changes) throw httpError(409, 'Match changed while it was being finished. Refresh and retry.');
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchRow.id);
  writeAudit({ matchBefore: matchRow, matchAfter: match, userId, action });
  return { match, advance, stage };
}

function correctFinishedMatchRecord({
  matchRow,
  homeScore,
  awayScore,
  extraTimeHome = null,
  extraTimeAway = null,
  penaltiesHome = null,
  penaltiesAway = null,
  userId,
  expectedRevision,
  reason,
}) {
  assertRevision(matchRow, expectedRevision);
  const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(matchRow.stage_id);
  if (!stage || stage.type !== 'league') {
    throw httpError(409, 'Finished knockout matches cannot be corrected directly. Reset and redraw the stage to recalculate its bracket safely.');
  }
  const oldHome = Number(matchRow.home_score || 0);
  const oldAway = Number(matchRow.away_score || 0);
  const settings = parseJson(stage.settings, map.defaultStageSettings(stage.type));
  db.exec('BEGIN');
  try {
    reverseResultFromTable(matchRow, oldHome, oldAway, settings.points);
    const result = db.prepare(
      `UPDATE matches SET home_score = ?, away_score = ?, extra_time_home = ?,
        extra_time_away = ?, penalties_home = ?, penalties_away = ?, revision = revision + 1
       WHERE id = ? AND revision = ?`
    ).run(
      homeScore,
      awayScore,
      extraTimeHome,
      extraTimeAway,
      penaltiesHome,
      penaltiesAway,
      matchRow.id,
      Number(matchRow.revision || 0)
    );
    if (!result.changes) throw httpError(409, 'Match changed while the correction was being saved. Refresh and retry.');
    applyResultToTableInternal(
      { ...matchRow, home_participant_team_id: matchRow.home_participant_team_id, away_participant_team_id: matchRow.away_participant_team_id },
      Number(homeScore),
      Number(awayScore),
      settings.points
    );
    const updated = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchRow.id);
    writeAudit({ matchBefore: matchRow, matchAfter: updated, userId, action: 'correct_finished_result', reason });
    db.exec('COMMIT');
    return { match: updated, advance: null, stage };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function reverseResultFromTable(match, homeScore, awayScore, pointsSettings) {
  const pts = pointsSettings || { win: 3, draw: 1, loss: 0 };
  const home = db.prepare('SELECT * FROM participant_teams WHERE id = ?').get(match.home_participant_team_id);
  const away = db.prepare('SELECT * FROM participant_teams WHERE id = ?').get(match.away_participant_team_id);
  if (!home || !away) return;
  const homeWin = homeScore > awayScore;
  const draw = homeScore === awayScore;
  const reverse = (team, wins, draws, losses, goalsFor, goalsAgainst, points) => db.prepare(
    `UPDATE participant_teams SET played = MAX(0, played - 1),
      won = MAX(0, won - ?), drawn = MAX(0, drawn - ?), lost = MAX(0, lost - ?),
      goals_for = MAX(0, goals_for - ?), goals_against = MAX(0, goals_against - ?),
      points = MAX(0, points - ?) WHERE id = ?`
  ).run(wins, draws, losses, goalsFor, goalsAgainst, points, team.id);
  reverse(home, homeWin ? 1 : 0, draw ? 1 : 0, homeWin ? 0 : 1, homeScore, awayScore, homeWin ? pts.win : draw ? pts.draw : pts.loss);
  reverse(away, homeWin ? 0 : 1, draw ? 1 : 0, homeWin ? 1 : 0, awayScore, homeScore, homeWin ? pts.loss : draw ? pts.draw : pts.win);
}

// Moves a match from 'live' to 'paused'. Purely a status flip — no score
// or timing fields change, so resuming later picks up exactly where the
// match left off.
function pauseMatchRecord(matchRow, adminOverride = false, expectedRevision) {
  assertRevision(matchRow, expectedRevision);
  if (adminOverride) {
    const result = db.prepare(`UPDATE matches SET status = 'paused', revision = revision + 1 WHERE id = ? AND revision = ?`)
      .run(matchRow.id, Number(matchRow.revision || 0));
    if (!result.changes) throw httpError(409, 'Match changed while it was being paused. Refresh and retry.');
    return db.prepare('SELECT * FROM matches WHERE id = ?').get(matchRow.id);
  }
  assertTransition(matchRow.status, 'pause');
  const result = db.prepare(`UPDATE matches SET status = 'paused', revision = revision + 1 WHERE id = ? AND revision = ?`)
    .run(matchRow.id, Number(matchRow.revision || 0));
  if (!result.changes) throw httpError(409, 'Match changed while it was being paused. Refresh and retry.');
  return db.prepare('SELECT * FROM matches WHERE id = ?').get(matchRow.id);
}

// Moves a match from 'paused' back to 'live'.
function resumeMatchRecord(matchRow, adminOverride = false, expectedRevision) {
  assertRevision(matchRow, expectedRevision);
  if (adminOverride) {
    const result = db.prepare(`UPDATE matches SET status = 'live', revision = revision + 1 WHERE id = ? AND revision = ?`)
      .run(matchRow.id, Number(matchRow.revision || 0));
    if (!result.changes) throw httpError(409, 'Match changed while it was being resumed. Refresh and retry.');
    return db.prepare('SELECT * FROM matches WHERE id = ?').get(matchRow.id);
  }
  assertTransition(matchRow.status, 'resume');
  const result = db.prepare(`UPDATE matches SET status = 'live', revision = revision + 1 WHERE id = ? AND revision = ?`)
    .run(matchRow.id, Number(matchRow.revision || 0));
  if (!result.changes) throw httpError(409, 'Match changed while it was being resumed. Refresh and retry.');
  return db.prepare('SELECT * FROM matches WHERE id = ?').get(matchRow.id);
}

// Resets a live/paused match: clears every result field and returns the
// match to 'scheduled' so it can be started and played out again. This
// never touches standings or knockout advancement — those are only ever
// updated by finishMatchRecord() — so an abandoned match simply behaves
// as if it had not been played yet. The reason is required for the
// moderator-facing UI/audit trail but, since no schema migration is in
// scope for this feature, is not persisted; callers should surface it to
// the moderator in the response instead.
function abandonMatchRecord(matchRow, reason, adminOverride = false) {
  if (adminOverride) {
    if (!reason || !String(reason).trim()) {
      throw httpError(400, 'A reason is required to abandon a match.');
    }
    db.prepare(
      `UPDATE matches SET status = 'scheduled', phase = 'abandoned', home_score = NULL, away_score = NULL,
        extra_time_home = NULL, extra_time_away = NULL, penalties_home = NULL, penalties_away = NULL,
        started_at = NULL, finished_at = NULL, phase_started_at = NULL, phase_elapsed_seconds = 0
       WHERE id = ?`
    ).run(matchRow.id);
    return db.prepare('SELECT * FROM matches WHERE id = ?').get(matchRow.id);
  }
  assertTransition(matchRow.status, 'abandon');
  if (!reason || !String(reason).trim()) {
    throw httpError(400, 'A reason is required to abandon a match.');
  }
  db.prepare(
    `UPDATE matches SET status = 'scheduled', home_score = NULL, away_score = NULL,
      extra_time_home = NULL, extra_time_away = NULL, penalties_home = NULL, penalties_away = NULL,
      started_at = NULL, finished_at = NULL
     WHERE id = ?`
  ).run(matchRow.id);
  return db.prepare('SELECT * FROM matches WHERE id = ?').get(matchRow.id);
}

function cancelMatchRecord(matchRow) {
  db.prepare(
    `UPDATE matches SET status = 'cancelled', phase = 'abandoned',
      home_score = NULL, away_score = NULL, extra_time_home = NULL, extra_time_away = NULL,
      penalties_home = NULL, penalties_away = NULL, started_at = NULL, finished_at = NULL,
      phase_started_at = NULL, phase_elapsed_seconds = 0
     WHERE id = ?`
  ).run(matchRow.id);
  return db.prepare('SELECT * FROM matches WHERE id = ?').get(matchRow.id);
}

function participantTeamWithTeam(participantTeamId) {
  if (!participantTeamId) return null;
  return db.prepare(
    `SELECT pt.*, t.name AS team_name, t.slug AS team_slug, t.primary_color, t.secondary_color
     FROM participant_teams pt JOIN teams t ON t.id = pt.team_id
     WHERE pt.id = ?`
  ).get(participantTeamId);
}

function squadFor(participantTeamId) {
  if (!participantTeamId) return [];
  return db.prepare(
    `SELECT pp.*, p.name AS player_name, p.slug AS player_slug, p.position AS player_position
     FROM participant_players pp JOIN players p ON p.id = pp.player_id
     WHERE pp.participant_team_id = ?
     ORDER BY pp.shirt_number`
  ).all(participantTeamId);
}

// A single response that joins the match with its stage/group-or-round
// context, both participant teams, and both full squads (with their
// cumulative stat totals) — so the match menu can render everything it
// needs without the browser fanning out across several endpoints.
function getMatchDetail(matchId) {
  const row = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!row) return null;

  const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(row.stage_id);

  let group = null;
  let round = null;
  if (row.group_id) {
    const groupRow = db.prepare('SELECT id, name FROM groups WHERE id = ?').get(row.group_id);
    if (groupRow) {
      group = { id: groupRow.id, name: groupRow.name };
    } else {
      const roundRow = db.prepare('SELECT id, name FROM rounds WHERE id = ?').get(row.group_id);
      if (roundRow) round = { id: roundRow.id, name: roundRow.name };
    }
  }

  const homeTeam = participantTeamWithTeam(row.home_participant_team_id);
  const awayTeam = participantTeamWithTeam(row.away_participant_team_id);

  return {
    match: map.match(row),
    stage: stage ? map.stage(stage) : null,
    group,
    round,
    homeTeam: homeTeam ? map.participantTeam(homeTeam) : null,
    awayTeam: awayTeam ? map.participantTeam(awayTeam) : null,
    homeSquad: squadFor(row.home_participant_team_id).map(map.participantPlayer),
    awaySquad: squadFor(row.away_participant_team_id).map(map.participantPlayer),
  };
}

module.exports = {
  applyResultToTable,
  correctFinishedMatchRecord,
  finishMatchRecord,
  assertTransition,
  assertRevision,
  assertAdministratorMutationAllowed,
  rebuildTournamentProjections,
  pauseMatchRecord,
  resumeMatchRecord,
  abandonMatchRecord,
  cancelMatchRecord,
  getMatchDetail,
};
