const { db, now, parseJson } = require('../db');
const { id } = require('../utils/ids');
const { httpError } = require('../middleware/error');
const { defaultStageSettings } = require('./mappers');
const {
  finishMatchRecord,
  assertRevision,
  rebuildTournamentProjections,
} = require('./matchService');
const { reconcileStageOutputs } = require('./drawService');
const suspension = require('./suspensionService');

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

function getProjectedScore(matchId) {
  projectMatchScore(matchId);
  const match = db.prepare(
    `SELECT home_score, away_score, extra_time_home, extra_time_away,
            penalties_home, penalties_away
     FROM matches WHERE id = ?`
  ).get(matchId);
  return {
    home: Number(match?.home_score || 0),
    away: Number(match?.away_score || 0),
    extraHome: Number(match?.extra_time_home || 0),
    extraAway: Number(match?.extra_time_away || 0),
    penaltiesHome: Number(match?.penalties_home || 0),
    penaltiesAway: Number(match?.penalties_away || 0),
  };
}

function eventPermission(match, refereeId, adminOverride, reason, moderatorOverride = false) {
  if (!adminOverride && !moderatorOverride && match.referee_id !== refereeId) throw httpError(403, 'Only the assigned referee can operate this match');
  if (!adminOverride && !moderatorOverride && match.status !== 'live') {
    throw httpError(403, 'Assigned referees can only change events while the match is live');
  }
  if ((adminOverride || moderatorOverride) && match.status === 'finished' && !reason?.trim()) {
    throw httpError(400, 'A reason is required for finished-match event corrections');
  }
  if (!adminOverride && !moderatorOverride && !['live', 'paused'].includes(match.status)) throw httpError(409, 'Match is not active');
}

function eventRowsForEligibility(matchId, excludedEventId = null) {
  const rows = db.prepare('SELECT * FROM match_events WHERE match_id = ?').all(matchId);
  return excludedEventId ? rows.filter((event) => event.id !== excludedEventId) : rows;
}

function isAutomaticSecondYellow(event) {
  return event?.type === 'card' && event.card === 'red'
    && parseJson(event.payload, {}).automaticSecondYellow === true;
}

function reconcileAutomaticSecondYellowCards({ matchId, tournamentId }) {
  const events = db.prepare(
    `SELECT * FROM match_events
     WHERE match_id = ? AND type = 'card'
     ORDER BY datetime(created_at), id`
  ).all(matchId);
  const yellowByPlayer = new Map();
  for (const event of events) {
    if (event.card !== 'yellow' || !event.player_id) continue;
    const list = yellowByPlayer.get(event.player_id) || [];
    list.push(event);
    yellowByPlayer.set(event.player_id, list);
  }

  const automaticRedEvents = events.filter(isAutomaticSecondYellow);
  for (const event of automaticRedEvents) {
    const yellows = yellowByPlayer.get(event.player_id) || [];
    const sourceYellow = yellows.find((yellow) =>
      parseJson(event.payload, {}).sourceEventId === yellow.id
    ) || yellows[1];
    const hasManualRed = events.some((candidate) =>
      candidate.player_id === event.player_id && candidate.card === 'red' && !isAutomaticSecondYellow(candidate)
    );
    if (yellows.length < 2 || hasManualRed) {
      db.prepare('DELETE FROM match_events WHERE id = ?').run(event.id);
    } else if (sourceYellow) {
      db.prepare(
        `UPDATE match_events
         SET created_at = datetime(?, '+1 second'), minute = ?
         WHERE id = ?`
      ).run(sourceYellow.created_at, sourceYellow.minute, event.id);
    }
  }

  for (const [playerId, yellows] of yellowByPlayer) {
    const hasRed = events.some((event) => event.player_id === playerId && event.card === 'red');
    const hasAutomaticRed = automaticRedEvents.some((event) => event.player_id === playerId)
      && yellows.length >= 2;
    if (yellows.length < 2 || hasRed || hasAutomaticRed) continue;
    const secondYellow = yellows[1];
    const payload = {
      automaticSecondYellow: true,
      sourceEventId: secondYellow.id,
      playerId,
      teamId: secondYellow.team_id,
    };
    db.prepare(
      `INSERT INTO match_events
       (id, match_id, tournament_id, type, phase, team_id, player_id, card, minute, payload, created_at)
       VALUES (?, ?, ?, 'card', ?, ?, ?, 'red', ?, ?, datetime(?, '+1 second'))`
    ).run(
      id(),
      matchId,
      tournamentId,
      secondYellow.phase,
      secondYellow.team_id,
      playerId,
      secondYellow.minute,
      JSON.stringify(payload),
      secondYellow.created_at
    );
  }
}

function validateEventEligibility({ matchId, eventId = null, type, teamId, playerId, goalEventId, phase, card, scored }) {
  if (!playerId || !['goal', 'assist', 'card', 'shootout_attempt'].includes(type)) return;
  const participant = db.prepare(
    'SELECT id FROM participant_players WHERE id = ? AND participant_team_id = ?'
  ).get(playerId, teamId);
  if (!participant) throw httpError(400, 'Player does not belong to the selected team');
  const events = eventRowsForEligibility(matchId, eventId);
  const playerCards = events.filter((event) => event.player_id === playerId && event.type === 'card');
  const yellowCards = playerCards.filter((event) => event.card === 'yellow').length;
  const redCard = playerCards.some((event) => event.card === 'red');
  if (redCard || yellowCards >= 2) {
    throw httpError(409, 'This player is suspended for the remainder of the match.');
  }
  if (type === 'assist' && goalEventId) {
    const goal = db.prepare(
      'SELECT player_id FROM match_events WHERE id = ? AND match_id = ? AND type = \'goal\''
    ).get(goalEventId, matchId);
    if (goal?.player_id === playerId) {
      throw httpError(400, 'A player cannot assist the same goal they scored.');
    }
  }
  if (type === 'shootout_attempt') {
    const previousAttempt = events.find((event) =>
      event.type === 'shootout_attempt' && event.player_id === playerId
    );
    if (previousAttempt) throw httpError(409, 'Each player can take only one shootout attempt.');
  }
  if (type === 'card' && card === 'red' && redCard) {
    throw httpError(409, 'This player has already received a red card.');
  }
  if (type === 'shootout_attempt' && phase !== 'shootout') {
    throw httpError(400, 'Shootout attempts require the shootout phase');
  }
  if (type === 'shootout_attempt' && scored == null) {
    throw httpError(400, 'Shootout attempts must be marked scored or missed');
  }
  if (teamId == null) throw httpError(400, 'Event team is required');
}

function validateGoalLink({ matchId, teamId, phase, goalEventId }) {
  if (!goalEventId) return;
  const goal = db.prepare(
    `SELECT id, match_id, type, phase, team_id
     FROM match_events WHERE id = ? AND match_id = ?`
  ).get(goalEventId, matchId);
  if (!goal || goal.type !== 'goal' || goal.phase !== phase || goal.team_id !== teamId) {
    throw httpError(400, 'Assist must reference a goal from the same team, phase, and match');
  }
}

function findLegacyAssistForGoal(goal) {
  const candidates = db.prepare(
    `SELECT * FROM match_events
     WHERE match_id = ? AND type = 'assist' AND goal_event_id IS NULL
       AND team_id = ? AND phase = ?
       AND datetime(created_at) >= datetime(?)
     ORDER BY datetime(created_at), id`
  ).all(goal.match_id, goal.team_id, goal.phase, goal.created_at);
  return candidates.length === 1 ? candidates[0] : null;
}

function updateEvent({ matchId, tournamentId, eventId, refereeId, adminOverride = false, moderatorOverride = false, changes = {}, expectedRevision, reason }) {
  const match = getMatch(matchId, tournamentId);
  const event = db.prepare('SELECT * FROM match_events WHERE id = ? AND match_id = ?').get(eventId, matchId);
  if (!event) throw httpError(404, 'Event not found');
  if (isAutomaticSecondYellow(event)) throw httpError(400, 'Automatic second-yellow red cards cannot be edited; edit the yellow-card events instead.');
  eventPermission(match, refereeId, adminOverride, reason, moderatorOverride);
  assertRevision(match, expectedRevision);
  const minute = changes.minute == null ? event.minute : Number(changes.minute);
  if (!Number.isFinite(minute) || minute < 0) throw httpError(400, 'minute must be a non-negative number');
  const payload = { ...parseJson(event.payload, {}), ...(changes.payload || {}) };
  const goalEventId = changes.goalEventId ?? event.goal_event_id;
  if (event.type === 'assist') validateGoalLink({
    matchId,
    teamId: changes.teamId ?? event.team_id,
    phase: changes.phase ?? event.phase,
    goalEventId,
  });
  validateEventEligibility({
    matchId,
    eventId,
    type: event.type,
    teamId: changes.teamId ?? event.team_id,
    playerId: changes.playerId ?? event.player_id,
    goalEventId,
    phase: changes.phase ?? event.phase,
    card: changes.card ?? event.card,
    scored: changes.scored == null ? event.scored : (changes.scored ? 1 : 0),
  });
  db.prepare(
    `UPDATE match_events SET phase = ?, goal_event_id = ?, team_id = ?, player_id = ?, assister_id = ?,
      card = ?, scored = ?, minute = ?, payload = ? WHERE id = ?`
  ).run(
    changes.phase ?? event.phase,
    goalEventId,
    changes.teamId ?? event.team_id,
    changes.playerId ?? event.player_id,
    changes.assisterId ?? event.assister_id,
    changes.card ?? event.card,
    changes.scored == null ? event.scored : (changes.scored ? 1 : 0),
    minute,
    JSON.stringify(payload),
    eventId
  );
  reconcileAutomaticSecondYellowCards({ matchId, tournamentId });
  const revision = db.prepare('UPDATE matches SET revision = revision + 1 WHERE id = ? AND revision = ?')
    .run(matchId, Number(match.revision || 0));
  if (!revision.changes) throw httpError(409, 'Match changed while the event was being updated. Refresh and retry.');
  projectMatchScore(matchId);
  rebuildTournamentProjections(tournamentId);
  const impact = match.status === 'finished' ? reconcileStageOutputs(match.stage_id) : null;
  db.prepare(
    `INSERT INTO match_audit (id, match_id, tournament_id, user_id, action, reason, before_state, after_state)
     VALUES (?, ?, ?, ?, 'event_update', ?, ?, ?)`
  ).run(id(), matchId, tournamentId, refereeId, reason || null, JSON.stringify(event),
    JSON.stringify(db.prepare('SELECT * FROM match_events WHERE id = ?').get(eventId)));
  return { ...snapshot(matchId, tournamentId), impact };
}

function deleteEvent({ matchId, tournamentId, eventId, refereeId, adminOverride = false, moderatorOverride = false, expectedRevision, reason }) {
  const match = getMatch(matchId, tournamentId);
  const event = db.prepare('SELECT * FROM match_events WHERE id = ? AND match_id = ?').get(eventId, matchId);
  if (!event) throw httpError(404, 'Event not found');
  if (isAutomaticSecondYellow(event)) throw httpError(400, 'Automatic second-yellow red cards cannot be deleted; delete a yellow-card event instead.');
  eventPermission(match, refereeId, adminOverride, reason, moderatorOverride);
  assertRevision(match, expectedRevision);
  if (event.type === 'goal') {
    const linkedAssist = db.prepare(
      `SELECT id FROM match_events WHERE goal_event_id = ? AND type = 'assist'`
    ).get(eventId);
    const legacyAssist = linkedAssist ? null : findLegacyAssistForGoal(event);
    if (linkedAssist) db.prepare('DELETE FROM match_events WHERE id = ?').run(linkedAssist.id);
    else if (legacyAssist) db.prepare('DELETE FROM match_events WHERE id = ?').run(legacyAssist.id);
  }
  db.prepare('DELETE FROM match_events WHERE id = ?').run(eventId);
  reconcileAutomaticSecondYellowCards({ matchId, tournamentId });
  const revision = db.prepare('UPDATE matches SET revision = revision + 1 WHERE id = ? AND revision = ?')
    .run(matchId, Number(match.revision || 0));
  if (!revision.changes) throw httpError(409, 'Match changed while the event was being deleted. Refresh and retry.');
  projectMatchScore(matchId);
  rebuildTournamentProjections(tournamentId);
  const impact = match.status === 'finished' ? reconcileStageOutputs(match.stage_id) : null;
  db.prepare(
    `INSERT INTO match_audit (id, match_id, tournament_id, user_id, action, reason, before_state, after_state)
     VALUES (?, ?, ?, ?, 'event_delete', ?, ?, '{}')`
  ).run(id(), matchId, tournamentId, refereeId, reason || null, JSON.stringify(event));
  return { ...snapshot(matchId, tournamentId), impact };
}

function addEvent({ matchId, tournamentId, refereeId, adminOverride = false, moderatorOverride = false, type, phase, payload = {}, clientEventId = null, expectedRevision }) {
  const match = getMatch(matchId, tournamentId);
  assertRevision(match, expectedRevision);
  eventPermission(match, refereeId, adminOverride, payload.reason, moderatorOverride);
  if (!['regulation', 'extra_time', 'shootout'].includes(phase)) throw httpError(400, 'Invalid match phase');
  if (!adminOverride && type !== 'phase' && phase !== match.phase) {
    throw httpError(409, `Event phase must match the current phase (${match.phase}).`);
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
  if (type === 'assist') {
    validateGoalLink({
      matchId,
      teamId: payload.teamId,
      phase,
      goalEventId: payload.goalEventId,
    });
  }
  validateEventEligibility({
    matchId,
    type,
    teamId: payload.teamId,
    playerId: payload.playerId,
    goalEventId: payload.goalEventId,
    phase,
    card: payload.card,
    scored: payload.scored,
  });
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
       (id, match_id, tournament_id, type, phase, goal_event_id, team_id, player_id, assister_id, card, scored, minute, payload, client_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      eventId,
      matchId,
      tournamentId,
      type,
      phase,
      type === 'assist' ? payload.goalEventId || null : null,
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
      const existing = db.prepare(
        'SELECT id FROM match_events WHERE match_id = ? AND client_event_id = ?'
      ).get(matchId, clientEventId);
      return { ...snapshot(matchId, tournamentId), eventId: existing?.id || null };
    }
    throw error;
  }

  reconcileAutomaticSecondYellowCards({ matchId, tournamentId });
  const revisionUpdate = db.prepare('UPDATE matches SET revision = revision + 1 WHERE id = ? AND revision = ?')
    .run(matchId, Number(match.revision || 0));
  if (!revisionUpdate.changes) throw httpError(409, 'Match changed while the event was being saved. Refresh and retry.');
  projectMatchScore(matchId);
  rebuildTournamentProjections(tournamentId);
  const impact = match.status === 'finished' ? reconcileStageOutputs(match.stage_id) : null;
  db.prepare(
    `INSERT INTO match_audit (id, match_id, tournament_id, user_id, action, reason, before_state, after_state)
     VALUES (?, ?, ?, ?, 'event_create', ?, ?, ?)`
  ).run(id(), matchId, tournamentId, refereeId, payload.reason || null, '{}', JSON.stringify({ eventId }));
  return { ...snapshot(matchId, tournamentId), eventId, impact };
}

function start({ matchId, tournamentId, refereeId, adminOverride = false, durationMinutes }) {
  const match = getMatch(matchId, tournamentId);
  if (!adminOverride && match.referee_id && match.referee_id !== refereeId) throw httpError(403, 'This match is assigned to another referee');
  if (!['scheduled', 'postponed'].includes(match.status)) throw httpError(409, `Cannot start a match with status "${match.status}".`);
  suspension.assertCanStart(matchId, tournamentId);
  if (!Number.isInteger(Number(durationMinutes)) || Number(durationMinutes) <= 0) {
    throw httpError(400, 'durationMinutes must be a positive integer');
  }
  const timestamp = now();
  db.prepare(
    `UPDATE matches SET status = 'live', referee_id = ?, duration_minutes = ?, phase = 'regulation',
      phase_started_at = ?, phase_elapsed_seconds = 0, started_at = COALESCE(started_at, ?) WHERE id = ?`
  ).run(refereeId, Number(durationMinutes), timestamp, timestamp, matchId);
  recordPhase(matchId, tournamentId, 'regulation', 'start');
  suspension.consumeForStart(matchId, tournamentId);
  return snapshot(matchId, tournamentId);
}

function continueFinished({ matchId, tournamentId, refereeId, adminOverride = false, moderatorOverride = false, expectedRevision }) {
  const match = getMatch(matchId, tournamentId);
  assertRevision(match, expectedRevision);
  if (!adminOverride && !moderatorOverride) {
    throw httpError(403, 'Only a tournament moderator can continue a finished match');
  }
  if (match.status !== 'finished') throw httpError(409, 'Only finished matches can be continued');
  const previousPhase = db.prepare(
    `SELECT phase FROM match_events
     WHERE match_id = ? AND type = 'phase'
       AND json_extract(payload, '$.action') IN ('start', 'pause', 'resume', 'continue')
     ORDER BY created_at DESC, id DESC LIMIT 1`
  ).get(matchId)?.phase || 'regulation';
  const timestamp = now();
  const result = db.prepare(
    `UPDATE matches SET status = 'live', phase = ?, phase_started_at = ?,
      revision = revision + 1 WHERE id = ? AND revision = ?`
  ).run(previousPhase, timestamp, matchId, Number(match.revision || 0));
  if (!result.changes) throw httpError(409, 'Match changed while it was being continued. Refresh and retry.');
  recordPhase(matchId, tournamentId, previousPhase, 'continue');
  return snapshot(matchId, tournamentId);
}

function transition({ matchId, tournamentId, refereeId, adminOverride = false, moderatorOverride = false, action, expectedRevision }) {
  const match = getMatch(matchId, tournamentId);
  assertRevision(match, expectedRevision);
  if (!adminOverride && !moderatorOverride && match.referee_id !== refereeId) throw httpError(403, 'Only the assigned referee can operate this match');
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

function finishPhase({ matchId, tournamentId, refereeId, adminOverride = false, moderatorOverride = false, phase, expectedRevision }) {
  const match = getMatch(matchId, tournamentId);
  assertRevision(match, expectedRevision);
  if (match.status === 'finished') throw httpError(409, 'This match is already finished. Use correction controls instead.');
  if (!adminOverride && !moderatorOverride && match.referee_id !== refereeId) throw httpError(403, 'Only the assigned referee can operate this match');
  const phaseStarted = timestampMilliseconds(match.phase_started_at);
  const elapsed = Number(match.phase_elapsed_seconds || 0) + (
    match.status === 'live' && Number.isFinite(phaseStarted)
      ? Math.max(0, Math.floor((Date.now() - phaseStarted) / 1000))
      : 0
  );
  db.prepare('UPDATE matches SET phase_elapsed_seconds = ?, phase_started_at = NULL WHERE id = ?')
    .run(elapsed, matchId);
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
  rebuildTournamentProjections(tournamentId);
  return { ...snapshot(matchId, tournamentId), advance: result.advance };
}

function abandon({ matchId, tournamentId, refereeId, adminOverride = false, moderatorOverride = false, reason }) {
  const match = getMatch(matchId, tournamentId);
  if (!adminOverride && !moderatorOverride && match.referee_id !== refereeId) throw httpError(403, 'Only the assigned referee can operate this match');
  if (!reason?.trim()) throw httpError(400, 'A reason is required to abandon a match');
  db.prepare(
    `UPDATE matches SET status = 'scheduled', phase = 'abandoned', home_score = NULL, away_score = NULL,
      extra_time_home = NULL, extra_time_away = NULL, penalties_home = NULL, penalties_away = NULL,
      started_at = NULL, phase_started_at = NULL, phase_elapsed_seconds = 0 WHERE id = ?`
  ).run(matchId);
  suspension.resetDecisionsForAbandonedMatch(matchId);
  recordPhase(matchId, tournamentId, 'regulation', 'abandon');
  return snapshot(matchId, tournamentId);
}

module.exports = {
  snapshot,
  addEvent,
  updateEvent,
  deleteEvent,
  projectMatchScore,
  getProjectedScore,
  start,
  continueFinished,
  transition,
  finishPhase,
  abandon,
};
