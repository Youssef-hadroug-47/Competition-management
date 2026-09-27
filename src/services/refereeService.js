const { db, now, parseJson } = require('../db');
const { id } = require('../utils/ids');
const { httpError } = require('../middleware/error');
const { defaultStageSettings } = require('./mappers');
const {
  finishMatchRecord,
  assertAdministratorMutationAllowed,
  assertRevision,
  rebuildTournamentProjections,
} = require('./matchService');

function timestampMilliseconds(value) {
  if (!value) return NaN;
  const text = String(value);
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
}

function getMatch(matchId, tournamentId) {
  const match = db.prepare('SELECT * FROM matches WHERE id = ? AND tournament_id = ?').get(matchId, tournamentId);
  if (!match) throw httpError(404, 'Match not found');
  return match;
}

function getStageSettings(match) {
  const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(match.stage_id);
  return { stage, settings: parseJson(stage?.settings, defaultStageSettings(stage?.type)) };
}

function snapshot(matchId, tournamentId) {
  const match = getMatch(matchId, tournamentId);
  const events = db.prepare(
    `SELECT e.*,
            t.name AS team_name,
            p.name AS player_name,
            a.name AS assister_name
     FROM match_events e
     LEFT JOIN participant_teams pt ON pt.id = e.team_id
     LEFT JOIN teams t ON t.id = pt.team_id
     LEFT JOIN participant_players pp ON pp.id = e.player_id
     LEFT JOIN players p ON p.id = pp.player_id
     LEFT JOIN participant_players ap ON ap.id = e.assister_id
     LEFT JOIN players a ON a.id = ap.player_id
     WHERE e.match_id = ?
     ORDER BY e.created_at ASC, e.id ASC`
  ).all(matchId);
  return {
    match,
    events: events.map((event) => ({
      ...event,
      payload: parseJson(event.payload, {}),
      teamName: event.team_name || null,
      playerName: event.player_name || null,
      assisterName: event.assister_name || null,
    })),
  };
}

function recordPhase(matchId, tournamentId, phase, action) {
  db.prepare(
    `INSERT INTO match_events (id, match_id, tournament_id, type, phase, payload)
     VALUES (?, ?, ?, 'phase', ?, ?)`
  ).run(id(), matchId, tournamentId, phase, JSON.stringify({ action }));
}

function projectMatchScore(matchId) {
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  const events = db.prepare('SELECT * FROM match_events WHERE match_id = ?').all(matchId);
  const score = { home: 0, away: 0, extraHome: 0, extraAway: 0, penaltiesHome: 0, penaltiesAway: 0 };
  for (const event of events) {
    const payload = parseJson(event.payload, {});
    if (event.type === 'goal') {
      const home = payload.ownGoal
        ? event.team_id !== match.home_participant_team_id
        : event.team_id === match.home_participant_team_id;
      if (event.phase === 'extra_time') score[home ? 'extraHome' : 'extraAway'] += 1;
      else if (event.phase !== 'shootout') score[home ? 'home' : 'away'] += 1;
    } else if (event.type === 'shootout_attempt' && payload.scored) {
      score[event.team_id === match.home_participant_team_id ? 'penaltiesHome' : 'penaltiesAway'] += 1;
    }
  }
  db.prepare(
    `UPDATE matches SET home_score = ?, away_score = ?, extra_time_home = ?,
     extra_time_away = ?, penalties_home = ?, penalties_away = ?
     WHERE id = ?`
  ).run(score.home, score.away, score.extraHome, score.extraAway, score.penaltiesHome, score.penaltiesAway, matchId);
}

function eventPermission(match, refereeId, adminOverride, reason) {
  if (!adminOverride && match.referee_id !== refereeId) throw httpError(403, 'Only the assigned referee can operate this match');
  if (adminOverride && match.status === 'finished' && !reason?.trim()) {
    throw httpError(400, 'A reason is required for finished-match event corrections');
  }
  if (!adminOverride && !['live', 'paused'].includes(match.status)) throw httpError(409, 'Match is not active');
}

function addEvent({ matchId, tournamentId, refereeId, adminOverride = false, type, phase, payload = {}, clientEventId = null, expectedRevision }) {
  const match = getMatch(matchId, tournamentId);
  assertRevision(match, expectedRevision);
  eventPermission(match, refereeId, adminOverride, payload.reason);
  if (!['regulation', 'extra_time', 'shootout'].includes(phase)) throw httpError(400, 'Invalid match phase');
  if (!adminOverride && type !== 'phase' && phase !== match.phase) {
    throw httpError(409, `Event phase must match the current phase (${match.phase}).`);
  }

  function updateEvent({ matchId, tournamentId, eventId, refereeId, adminOverride = false, changes = {}, expectedRevision, reason }) {
    const match = getMatch(matchId, tournamentId);
    const event = db.prepare('SELECT * FROM match_events WHERE id = ? AND match_id = ?').get(eventId, matchId);
    if (!event) throw httpError(404, 'Event not found');
    eventPermission(match, refereeId, adminOverride, reason);
    assertRevision(match, expectedRevision);
    const payload = { ...parseJson(event.payload, {}), ...(changes.payload || {}) };
    const teamId = changes.teamId ?? event.team_id;
    const phase = changes.phase ?? event.phase;
    const minute = changes.minute == null ? event.minute : Number(changes.minute);
    db.prepare(
      `UPDATE match_events SET phase = ?, team_id = ?, player_id = ?, assister_id = ?,
       card = ?, scored = ?, minute = ?, payload = ? WHERE id = ?`
    ).run(
      phase,
      teamId,
      changes.playerId ?? event.player_id,
      changes.assisterId ?? event.assister_id,
      changes.card ?? event.card,
      changes.scored == null ? event.scored : (changes.scored ? 1 : 0),
      minute,
      JSON.stringify(payload),
      eventId
    );
    db.prepare('UPDATE matches SET revision = revision + 1 WHERE id = ? AND revision = ?')
      .run(matchId, Number(match.revision || 0));
    projectMatchScore(matchId);
    if (match.status === 'finished') rebuildTournamentProjections(tournamentId);
    db.prepare(
      `INSERT INTO match_audit (id, match_id, tournament_id, user_id, action, reason, before_state, after_state)
       VALUES (?, ?, ?, ?, 'event_update', ?, ?, ?)`
    ).run(id(), matchId, tournamentId, refereeId, reason || null, JSON.stringify(event), JSON.stringify({ eventId }));
    return snapshot(matchId, tournamentId);
  }

  function deleteEvent({ matchId, tournamentId, eventId, refereeId, adminOverride = false, expectedRevision, reason }) {
    const match = getMatch(matchId, tournamentId);
    const event = db.prepare('SELECT * FROM match_events WHERE id = ? AND match_id = ?').get(eventId, matchId);
    if (!event) throw httpError(404, 'Event not found');
    eventPermission(match, refereeId, adminOverride, reason);
    assertRevision(match, expectedRevision);
    db.prepare('DELETE FROM match_events WHERE id = ?').run(eventId);
    const revisionUpdate = db.prepare('UPDATE matches SET revision = revision + 1 WHERE id = ? AND revision = ?')
      .run(matchId, Number(match.revision || 0));
    if (!revisionUpdate.changes) throw httpError(409, 'Match changed while the event was being deleted. Refresh and retry.');
    projectMatchScore(matchId);
    if (match.status === 'finished') rebuildTournamentProjections(tournamentId);
    db.prepare(
      `INSERT INTO match_audit (id, match_id, tournament_id, user_id, action, reason, before_state, after_state)
       VALUES (?, ?, ?, ?, 'event_delete', ?, ?, '{}')`
    ).run(id(), matchId, tournamentId, refereeId, reason || null, JSON.stringify(event));
    return snapshot(matchId, tournamentId);
  }
  if (!['goal', 'assist', 'card', 'phase', 'shootout_attempt'].includes(type)) throw httpError(400, 'Invalid event type');
  if (type === 'goal' && phase === 'shootout') throw httpError(400, 'Shootout attempts are not match goals');
  if (type === 'shootout_attempt' && phase !== 'shootout') throw httpError(400, 'Shootout attempts require the shootout phase');
  if (type === 'card' && !['yellow', 'red'].includes(payload.card)) throw httpError(400, 'Card must be yellow or red');
  if (['goal', 'assist', 'card', 'shootout_attempt'].includes(type) &&
      ![match.home_participant_team_id, match.away_participant_team_id].includes(payload.teamId)) {
    throw httpError(400, 'Event team does not belong to this match');
  }
  const skippedAssist = type === 'assist' && payload.skipped === true;
  const phaseStarted = timestampMilliseconds(match.phase_started_at);
  const eventMinute = payload.minute == null && Number.isFinite(phaseStarted)
    ? Math.max(0, Math.floor((Date.now() - phaseStarted) / 60000) + 1)
    : payload.minute == null ? null : Number(payload.minute);
  if (type === 'assist' && !payload.playerId && !payload.skipped) {
    throw httpError(400, 'A player is required for this event');
  }
  if (type === 'goal' && payload.ownGoal && !payload.playerId) {
    throw httpError(400, 'A player is required for an own goal');
  }
  if (type === 'card' && !payload.playerId) throw httpError(400, 'A player is required for this event');
  if (type === 'assist' && phase === 'shootout') throw httpError(400, 'Shootouts do not have assists');
  if (type === 'assist' && !skippedAssist) {
    const assister = db.prepare(
      'SELECT id FROM participant_players WHERE id = ? AND participant_team_id = ?'
    ).get(payload.playerId, payload.teamId);
    if (!assister) throw httpError(400, 'Assister does not belong to the selected team');
  }
  if (type === 'goal' && payload.ownGoal) {
    const offender = db.prepare(
      'SELECT id FROM participant_players WHERE id = ? AND participant_team_id = ?'
    ).get(payload.playerId, payload.teamId);
    if (!offender) throw httpError(400, 'Own-goal player must belong to the selected team');
  }

  const eventId = id();
  try {
    db.prepare(
      `INSERT INTO match_events
       (id, match_id, tournament_id, type, phase, team_id, player_id, assister_id, card, scored, minute, payload, client_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      eventId,
      matchId,
      tournamentId,
      type,
      phase,
      payload.teamId || null,
      payload.playerId || null,
      payload.assisterId || null,
      payload.card || null,
      payload.scored == null ? null : (payload.scored ? 1 : 0),
      eventMinute,
      JSON.stringify(payload),
      clientEventId
    );
  } catch (error) {
    if (clientEventId && String(error.message).includes('UNIQUE constraint failed')) {
      return snapshot(matchId, tournamentId);
    }
    throw error;
  }

  const revisionUpdate = db.prepare('UPDATE matches SET revision = revision + 1 WHERE id = ? AND revision = ?')
    .run(matchId, Number(match.revision || 0));
  if (!revisionUpdate.changes) throw httpError(409, 'Match changed while the event was being saved. Refresh and retry.');
  projectMatchScore(matchId);
  if (match.status === 'finished') rebuildTournamentProjections(tournamentId);
  db.prepare(
    `INSERT INTO match_audit (id, match_id, tournament_id, user_id, action, reason, before_state, after_state)
     VALUES (?, ?, ?, ?, 'event_create', ?, ?, ?)`
  ).run(id(), matchId, tournamentId, refereeId, payload.reason || null, '{}', JSON.stringify({ eventId }));
  return snapshot(matchId, tournamentId);
}

function start({ matchId, tournamentId, refereeId, adminOverride = false, durationMinutes }) {
  const match = getMatch(matchId, tournamentId);
  if (!adminOverride && match.referee_id && match.referee_id !== refereeId) throw httpError(403, 'This match is assigned to another referee');
  if (!['scheduled', 'postponed'].includes(match.status)) throw httpError(409, `Cannot start a match with status "${match.status}".`);
  if (!Number.isInteger(Number(durationMinutes)) || Number(durationMinutes) <= 0) {
    throw httpError(400, 'durationMinutes must be a positive integer');
  }
  const timestamp = now();
  db.prepare(
    `UPDATE matches SET status = 'live', referee_id = ?, duration_minutes = ?, phase = 'regulation',
      phase_started_at = ?, phase_elapsed_seconds = 0, started_at = COALESCE(started_at, ?) WHERE id = ?`
  ).run(refereeId, Number(durationMinutes), timestamp, timestamp, matchId);
  recordPhase(matchId, tournamentId, 'regulation', 'start');
  return snapshot(matchId, tournamentId);
}

function transition({ matchId, tournamentId, refereeId, adminOverride = false, action, expectedRevision }) {
  const match = getMatch(matchId, tournamentId);
  assertRevision(match, expectedRevision);
  if (!adminOverride && match.referee_id !== refereeId) throw httpError(403, 'Only the assigned referee can operate this match');
  if (adminOverride && !['pause', 'resume'].includes(action)) throw httpError(400, 'Invalid transition action');
  if (adminOverride && action === 'pause' && !['paused', 'cancelled'].includes(match.status)) {
    db.prepare(`UPDATE matches SET status = 'paused', revision = revision + 1 WHERE id = ?`).run(matchId);
    return snapshot(matchId, tournamentId);
  }
  if (adminOverride && action === 'resume' && match.status !== 'live') {
    db.prepare(`UPDATE matches SET status = 'live', phase = CASE WHEN phase = 'finished' OR phase = 'abandoned' THEN 'regulation' ELSE phase END, revision = revision + 1 WHERE id = ?`).run(matchId);
    return snapshot(matchId, tournamentId);
  }
  if (action === 'pause' && match.status === 'live') {
    const phaseStarted = timestampMilliseconds(match.phase_started_at);
    const elapsed = Number.isFinite(phaseStarted)
      ? Math.max(0, Math.floor((Date.now() - phaseStarted) / 1000))
      : 0;
    db.prepare(`UPDATE matches SET status = 'paused', phase_elapsed_seconds = COALESCE(phase_elapsed_seconds, 0) + ?, revision = revision + 1 WHERE id = ?`).run(elapsed, matchId);
    recordPhase(matchId, tournamentId, match.phase === 'scheduled' ? 'regulation' : match.phase, 'pause');
  } else if (action === 'resume' && match.status === 'paused') {
    db.prepare(`UPDATE matches SET status = 'live', phase_started_at = ?, revision = revision + 1 WHERE id = ?`).run(now(), matchId);
    recordPhase(matchId, tournamentId, match.phase, 'resume');
  } else {
    throw httpError(409, `Cannot ${action} a match with status "${match.status}".`);
  }
  return snapshot(matchId, tournamentId);
}

function finishPhase({ matchId, tournamentId, refereeId, adminOverride = false, phase, expectedRevision }) {
  const match = getMatch(matchId, tournamentId);
  assertRevision(match, expectedRevision);
  if (match.status === 'finished') throw httpError(409, 'This match is already finished. Use correction controls instead.');
  if (!adminOverride && match.referee_id !== refereeId) throw httpError(403, 'Only the assigned referee can operate this match');
  const { settings } = getStageSettings(match);
  const home = Number(match.home_score || 0) + Number(match.extra_time_home || 0);
  const away = Number(match.away_score || 0) + Number(match.extra_time_away || 0);
  if (phase === 'regulation' && settings.extraTime && home === away) {
    db.prepare(`UPDATE matches SET phase = 'extra_time', phase_started_at = ?, phase_elapsed_seconds = 0 WHERE id = ?`).run(now(), matchId);
    recordPhase(matchId, tournamentId, 'extra_time', 'start');
    return snapshot(matchId, tournamentId);
  }
  if ((phase === 'regulation' || phase === 'extra_time') && settings.penalties && home === away) {
    db.prepare(
      `UPDATE matches SET phase = 'shootout', phase_started_at = ?, phase_elapsed_seconds = 0,
        penalties_home = COALESCE(penalties_home, 0), penalties_away = COALESCE(penalties_away, 0)
       WHERE id = ?`
    ).run(now(), matchId);
    recordPhase(matchId, tournamentId, 'shootout', 'start');
    return snapshot(matchId, tournamentId);
  }
  const result = finishMatchRecord({
    matchRow: match,
    homeScore: Number(match.home_score || 0),
    awayScore: Number(match.away_score || 0),
    extraTimeHome: match.extra_time_home,
    extraTimeAway: match.extra_time_away,
    penaltiesHome: match.penalties_home,
    penaltiesAway: match.penalties_away,
    refereeId,
    expectedRevision,
    userId: refereeId,
  });
  db.prepare(`UPDATE matches SET phase = 'finished' WHERE id = ?`).run(matchId);
  recordPhase(matchId, tournamentId, phase, 'finish');
  return { ...snapshot(matchId, tournamentId), advance: result.advance };
}

function abandon({ matchId, tournamentId, refereeId, adminOverride = false, reason }) {
  const match = getMatch(matchId, tournamentId);
  if (!adminOverride && match.referee_id !== refereeId) throw httpError(403, 'Only the assigned referee can operate this match');
  if (!reason?.trim()) throw httpError(400, 'A reason is required to abandon a match');
  db.prepare(
    `UPDATE matches SET status = 'scheduled', phase = 'abandoned', home_score = NULL, away_score = NULL,
      extra_time_home = NULL, extra_time_away = NULL, penalties_home = NULL, penalties_away = NULL,
      started_at = NULL, phase_started_at = NULL, phase_elapsed_seconds = 0 WHERE id = ?`
  ).run(matchId);
  recordPhase(matchId, tournamentId, 'regulation', 'abandon');
  return snapshot(matchId, tournamentId);
}

module.exports = { snapshot, addEvent, updateEvent, deleteEvent, start, transition, finishPhase, abandon };
