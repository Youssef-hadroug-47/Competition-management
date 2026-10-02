const { query, withTransaction, now, parseJson } = require('../db');

const run = (sql, values = [], client) => (client || { query }).query(sql.replace(/\?/g, (_, offset, text) => `$${(text.slice(0, offset).match(/\?/g) || []).length + 1}`), values);
const one = async (sql, values = [], client) => (await run(sql, values, client)).rows[0] || null;
const many = async (sql, values = [], client) => (await run(sql, values, client)).rows;
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

async function getMatch(matchId, tournamentId) {
  const match = await one('SELECT * FROM matches WHERE id = ? AND tournament_id = ?', [matchId, tournamentId]);
  if (!match) throw httpError(404, 'Match not found');
  return match;
}

async function getStageSettings(match) {
  const stage = await one('SELECT * FROM stages WHERE id = ?', [match.stage_id]);
  return { stage, settings: parseJson(stage?.settings, defaultStageSettings(stage?.type)) };
}

async function snapshot(matchId, tournamentId) {
  const match = await getMatch(matchId, tournamentId);
  const events = await many(
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
  , [matchId]);
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

async function recordPhase(matchId, tournamentId, phase, action) {
  await run(
    `INSERT INTO match_events (id, match_id, tournament_id, type, phase, payload)
     VALUES (?, ?, ?, 'phase', ?, ?)`
  , [id(), matchId, tournamentId, phase, JSON.stringify({ action })]);
}

async function projectMatchScore(matchId) {
  const match = await one('SELECT * FROM matches WHERE id = ?', [matchId]);
  const events = await many('SELECT * FROM match_events WHERE match_id = ?', [matchId]);
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
  await run(
    `UPDATE matches SET home_score = ?, away_score = ?, extra_time_home = ?,
     extra_time_away = ?, penalties_home = ?, penalties_away = ?
     WHERE id = ?`
  , [score.home, score.away, score.extraHome, score.extraAway, score.penaltiesHome, score.penaltiesAway, matchId]);
}

async function getProjectedScore(matchId) {
  await projectMatchScore(matchId);
  const match = await one(
    `SELECT home_score, away_score, extra_time_home, extra_time_away,
            penalties_home, penalties_away
     FROM matches WHERE id = ?`
  , [matchId]);
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

async function eventRowsForEligibility(matchId, excludedEventId = null) {
  const rows = await many('SELECT * FROM match_events WHERE match_id = ?', [matchId]);
  return excludedEventId ? rows.filter((event) => event.id !== excludedEventId) : rows;
}

function isAutomaticSecondYellow(event) {
  return event?.type === 'card' && event.card === 'red'
    && parseJson(event.payload, {}).automaticSecondYellow === true;
}

async function reconcileAutomaticSecondYellowCards({ matchId, tournamentId }) {
  const events = await many(
    `SELECT * FROM match_events
     WHERE match_id = ? AND type = 'card'
     ORDER BY created_at, id`
  , [matchId]);
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
      await run('DELETE FROM match_events WHERE id = ?', [event.id]);
    } else if (sourceYellow) {
      await run(
        `UPDATE match_events
         SET created_at = (?::timestamptz + interval '1 second'), minute = ?
         WHERE id = ?`
      , [sourceYellow.created_at, sourceYellow.minute, event.id]);
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
    await run(
      `INSERT INTO match_events
       (id, match_id, tournament_id, type, phase, team_id, player_id, card, minute, payload, created_at)
       VALUES (?, ?, ?, 'card', ?, ?, ?, 'red', ?, ?, (?::timestamptz + interval '1 second'))`
    , [id(),
      matchId,
      tournamentId,
      secondYellow.phase,
      secondYellow.team_id,
      playerId,
      secondYellow.minute,
      JSON.stringify(payload),
      secondYellow.created_at]);
  }
}

async function validateEventEligibility({ matchId, eventId = null, type, teamId, playerId, goalEventId, phase, card, scored }) {
  if (!playerId || !['goal', 'assist', 'card', 'shootout_attempt'].includes(type)) return;
  const participant = await one(
    'SELECT id FROM participant_players WHERE id = ? AND participant_team_id = ?'
  , [playerId, teamId]);
  if (!participant) throw httpError(400, 'Player does not belong to the selected team');
  const events = eventRowsForEligibility(matchId, eventId);
  const playerCards = events.filter((event) => event.player_id === playerId && event.type === 'card');
  const yellowCards = playerCards.filter((event) => event.card === 'yellow').length;
  const redCard = playerCards.some((event) => event.card === 'red');
  if (redCard || yellowCards >= 2) {
    throw httpError(409, 'This player is suspended for the remainder of the match.');
  }
  if (type === 'assist' && goalEventId) {
    const goal = await one(
      'SELECT player_id FROM match_events WHERE id = ? AND match_id = ? AND type = \'goal\''
    , [goalEventId, matchId]);
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

async function validateGoalLink({ matchId, teamId, phase, goalEventId }) {
  if (!goalEventId) return;
  const goal = await one(
    `SELECT id, match_id, type, phase, team_id
     FROM match_events WHERE id = ? AND match_id = ?`
  , [goalEventId, matchId]);
  if (!goal || goal.type !== 'goal' || goal.phase !== phase || goal.team_id !== teamId) {
    throw httpError(400, 'Assist must reference a goal from the same team, phase, and match');
  }
}

async function findLegacyAssistForGoal(goal) {
  const candidates = await many(
    `SELECT * FROM match_events
     WHERE match_id = ? AND type = 'assist' AND goal_event_id IS NULL
       AND team_id = ? AND phase = ?
       AND created_at >= ?::timestamptz
     ORDER BY created_at, id`
  , [goal.match_id, goal.team_id, goal.phase, goal.created_at]);
  return candidates.length === 1 ? candidates[0] : null;
}

async function updateEvent({ matchId, tournamentId, eventId, refereeId, adminOverride = false, moderatorOverride = false, changes = {}, expectedRevision, reason }) {
  const match = await getMatch(matchId, tournamentId);
  const event = await one('SELECT * FROM match_events WHERE id = ? AND match_id = ?', [eventId, matchId]);
  if (!event) throw httpError(404, 'Event not found');
  if (isAutomaticSecondYellow(event)) throw httpError(400, 'Automatic second-yellow red cards cannot be edited; edit the yellow-card events instead.');
  eventPermission(match, refereeId, adminOverride, reason, moderatorOverride);
  assertRevision(match, expectedRevision);
  const minute = changes.minute == null ? event.minute : Number(changes.minute);
  if (!Number.isFinite(minute) || minute < 0) throw httpError(400, 'minute must be a non-negative number');
  const payload = { ...parseJson(event.payload, {}), ...(changes.payload || {}) };
  const goalEventId = changes.goalEventId ?? event.goal_event_id;
  if (event.type === 'assist') await validateGoalLink({
    matchId,
    teamId: changes.teamId ?? event.team_id,
    phase: changes.phase ?? event.phase,
    goalEventId,
  });
  await validateEventEligibility({
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
  await run(
    `UPDATE match_events SET phase = ?, goal_event_id = ?, team_id = ?, player_id = ?, assister_id = ?,
      card = ?, scored = ?, minute = ?, payload = ? WHERE id = ?`
  , [changes.phase ?? event.phase,
    goalEventId,
    changes.teamId ?? event.team_id,
    changes.playerId ?? event.player_id,
    changes.assisterId ?? event.assister_id,
    changes.card ?? event.card,
    changes.scored == null ? event.scored : (changes.scored ? 1 : 0),
    minute,
    JSON.stringify(payload),
    eventId]);
  await reconcileAutomaticSecondYellowCards({ matchId, tournamentId });
  const revision = await run('UPDATE matches SET revision = revision + 1 WHERE id = ? AND revision = ?', [matchId, Number(match.revision || 0)]);
  if (!revision.rowCount) throw httpError(409, 'Match changed while the event was being updated. Refresh and retry.');
  await projectMatchScore(matchId);
  await rebuildTournamentProjections(tournamentId);
  const impact = match.status === 'finished' ? await reconcileStageOutputs(match.stage_id) : null;
  await run(
    `INSERT INTO match_audit (id, match_id, tournament_id, user_id, action, reason, before_state, after_state)
     VALUES (?, ?, ?, ?, 'event_update', ?, ?, ?)`
  , [id(), matchId, tournamentId, refereeId, reason || null, JSON.stringify(event),
    JSON.stringify(await one('SELECT * FROM match_events WHERE id = ?', [eventId]))]);
  return { ...(await snapshot(matchId, tournamentId)), impact };
}

async function deleteEvent({ matchId, tournamentId, eventId, refereeId, adminOverride = false, moderatorOverride = false, expectedRevision, reason }) {
  const match = await getMatch(matchId, tournamentId);
  const event = await one('SELECT * FROM match_events WHERE id = ? AND match_id = ?', [eventId, matchId]);
  if (!event) throw httpError(404, 'Event not found');
  if (isAutomaticSecondYellow(event)) throw httpError(400, 'Automatic second-yellow red cards cannot be deleted; delete a yellow-card event instead.');
  eventPermission(match, refereeId, adminOverride, reason, moderatorOverride);
  assertRevision(match, expectedRevision);
  if (event.type === 'goal') {
    const linkedAssist = await one(
      `SELECT id FROM match_events WHERE goal_event_id = ? AND type = 'assist'`
    , [eventId]);
    const legacyAssist = linkedAssist ? null : await findLegacyAssistForGoal(event);
    if (linkedAssist) await run('DELETE FROM match_events WHERE id = ?', [linkedAssist.id]);
    else if (legacyAssist) await run('DELETE FROM match_events WHERE id = ?', [legacyAssist.id]);
  }
  await run('DELETE FROM match_events WHERE id = ?', [eventId]);
  await reconcileAutomaticSecondYellowCards({ matchId, tournamentId });
  const revision = await run('UPDATE matches SET revision = revision + 1 WHERE id = ? AND revision = ?', [matchId, Number(match.revision || 0)]);
  if (!revision.rowCount) throw httpError(409, 'Match changed while the event was being deleted. Refresh and retry.');
  await projectMatchScore(matchId);
  await rebuildTournamentProjections(tournamentId);
  const impact = match.status === 'finished' ? await reconcileStageOutputs(match.stage_id) : null;
  await run(
    `INSERT INTO match_audit (id, match_id, tournament_id, user_id, action, reason, before_state, after_state)
     VALUES (?, ?, ?, ?, 'event_delete', ?, ?, '{}')`
  , [id(), matchId, tournamentId, refereeId, reason || null, JSON.stringify(event)]);
  return { ...(await snapshot(matchId, tournamentId)), impact };
}

async function addEvent({ matchId, tournamentId, refereeId, adminOverride = false, moderatorOverride = false, type, phase, payload = {}, clientEventId = null, expectedRevision }) {
  const match = await getMatch(matchId, tournamentId);
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
    const assister = await one(
      'SELECT id FROM participant_players WHERE id = ? AND participant_team_id = ?'
    , [payload.playerId, payload.teamId]);
    if (!assister) throw httpError(400, 'Assister does not belong to the selected team');
  }
  if (type === 'assist') {
    await validateGoalLink({
      matchId,
      teamId: payload.teamId,
      phase,
      goalEventId: payload.goalEventId,
    });
  }
  await validateEventEligibility({
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
    const offender = await one(
      'SELECT id FROM participant_players WHERE id = ? AND participant_team_id = ?'
    , [payload.playerId, payload.teamId]);
    if (!offender) throw httpError(400, 'Own-goal player must belong to the selected team');
  }

  const eventId = id();
  try {
    await run(
      `INSERT INTO match_events
       (id, match_id, tournament_id, type, phase, goal_event_id, team_id, player_id, assister_id, card, scored, minute, payload, client_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    , [eventId,
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
      clientEventId]);
  } catch (error) {
    if (clientEventId && (error.code === '23505' || String(error.message).includes('UNIQUE constraint failed'))) {
      const existing = await one(
        'SELECT id FROM match_events WHERE match_id = ? AND client_event_id = ?'
      , [matchId, clientEventId]);
      return { ...(await snapshot(matchId, tournamentId)), eventId: existing?.id || null };
    }
    throw error;
  }

  await reconcileAutomaticSecondYellowCards({ matchId, tournamentId });
  const revisionUpdate = await run('UPDATE matches SET revision = revision + 1 WHERE id = ? AND revision = ?', [matchId, Number(match.revision || 0)]);
  if (!revisionUpdate.rowCount) throw httpError(409, 'Match changed while the event was being saved. Refresh and retry.');
  await projectMatchScore(matchId);
  await rebuildTournamentProjections(tournamentId);
  const impact = match.status === 'finished' ? await reconcileStageOutputs(match.stage_id) : null;
  await run(
    `INSERT INTO match_audit (id, match_id, tournament_id, user_id, action, reason, before_state, after_state)
     VALUES (?, ?, ?, ?, 'event_create', ?, ?, ?)`
  , [id(), matchId, tournamentId, refereeId, payload.reason || null, '{}', JSON.stringify({ eventId })]);
  return { ...(await snapshot(matchId, tournamentId)), eventId, impact };
}

async function start({ matchId, tournamentId, refereeId, adminOverride = false, durationMinutes }) {
  const match = await getMatch(matchId, tournamentId);
  if (!adminOverride && match.referee_id && match.referee_id !== refereeId) throw httpError(403, 'This match is assigned to another referee');
  if (!['scheduled', 'postponed'].includes(match.status)) throw httpError(409, `Cannot start a match with status "${match.status}".`);
  await suspension.assertCanStart(matchId, tournamentId);
  if (!Number.isInteger(Number(durationMinutes)) || Number(durationMinutes) <= 0) {
    throw httpError(400, 'durationMinutes must be a positive integer');
  }
  const timestamp = now();
  await run(
    `UPDATE matches SET status = 'live', referee_id = ?, duration_minutes = ?, phase = 'regulation',
      phase_started_at = ?, phase_elapsed_seconds = 0, started_at = COALESCE(started_at, ?) WHERE id = ?`
  , [refereeId, Number(durationMinutes), timestamp, timestamp, matchId]);
  await recordPhase(matchId, tournamentId, 'regulation', 'start');
  await suspension.consumeForStart(matchId, tournamentId);
  return await snapshot(matchId, tournamentId);
}

async function continueFinished({ matchId, tournamentId, refereeId, adminOverride = false, moderatorOverride = false, expectedRevision }) {
  const match = await getMatch(matchId, tournamentId);
  assertRevision(match, expectedRevision);
  if (!adminOverride && !moderatorOverride) {
    throw httpError(403, 'Only a tournament moderator can continue a finished match');
  }
  if (match.status !== 'finished') throw httpError(409, 'Only finished matches can be continued');
  const previousPhase = (await one(
    `SELECT phase FROM match_events
     WHERE match_id = ? AND type = 'phase'
       AND (payload::jsonb ->> 'action') IN ('start', 'pause', 'resume', 'continue')
     ORDER BY created_at DESC, id DESC LIMIT 1`
  , [matchId]))?.phase || 'regulation';
  const timestamp = now();
  const result = await run(
    `UPDATE matches SET status = 'live', phase = ?, phase_started_at = ?,
      revision = revision + 1 WHERE id = ? AND revision = ?`
  , [previousPhase, timestamp, matchId, Number(match.revision || 0)]);
  if (!result.rowCount) throw httpError(409, 'Match changed while it was being continued. Refresh and retry.');
  await recordPhase(matchId, tournamentId, previousPhase, 'continue');
  return await snapshot(matchId, tournamentId);
}

async function transition({ matchId, tournamentId, refereeId, adminOverride = false, moderatorOverride = false, action, expectedRevision }) {
  const match = await getMatch(matchId, tournamentId);
  assertRevision(match, expectedRevision);
  if (!adminOverride && !moderatorOverride && match.referee_id !== refereeId) throw httpError(403, 'Only the assigned referee can operate this match');
  if (adminOverride && !['pause', 'resume'].includes(action)) throw httpError(400, 'Invalid transition action');
  if (adminOverride && action === 'pause' && !['paused', 'cancelled'].includes(match.status)) {
    await run(`UPDATE matches SET status = 'paused', revision = revision + 1 WHERE id = ?`, [matchId]);
    return await snapshot(matchId, tournamentId);
  }
  if (adminOverride && action === 'resume' && match.status !== 'live') {
    await run(`UPDATE matches SET status = 'live', phase = CASE WHEN phase = 'finished' OR phase = 'abandoned' THEN 'regulation' ELSE phase END, revision = revision + 1 WHERE id = ?`, [matchId]);
    return await snapshot(matchId, tournamentId);
  }
  if (action === 'pause' && match.status === 'live') {
    const phaseStarted = timestampMilliseconds(match.phase_started_at);
    const elapsed = Number.isFinite(phaseStarted)
      ? Math.max(0, Math.floor((Date.now() - phaseStarted) / 1000))
      : 0;
    await run(`UPDATE matches SET status = 'paused', phase_elapsed_seconds = COALESCE(phase_elapsed_seconds, 0) + ?, revision = revision + 1 WHERE id = ?`, [elapsed, matchId]);
    await recordPhase(matchId, tournamentId, match.phase === 'scheduled' ? 'regulation' : match.phase, 'pause');
  } else if (action === 'resume' && match.status === 'paused') {
    await run(`UPDATE matches SET status = 'live', phase_started_at = ?, revision = revision + 1 WHERE id = ?`, [now(), matchId]);
    await recordPhase(matchId, tournamentId, match.phase, 'resume');
  } else {
    throw httpError(409, `Cannot ${action} a match with status "${match.status}".`);
  }
  return await snapshot(matchId, tournamentId);
}

async function finishPhase({ matchId, tournamentId, refereeId, adminOverride = false, moderatorOverride = false, phase, expectedRevision }) {
  const match = await getMatch(matchId, tournamentId);
  assertRevision(match, expectedRevision);
  if (match.status === 'finished') throw httpError(409, 'This match is already finished. Use correction controls instead.');
  if (!adminOverride && !moderatorOverride && match.referee_id !== refereeId) throw httpError(403, 'Only the assigned referee can operate this match');
  const phaseStarted = timestampMilliseconds(match.phase_started_at);
  const elapsed = Number(match.phase_elapsed_seconds || 0) + (
    match.status === 'live' && Number.isFinite(phaseStarted)
      ? Math.max(0, Math.floor((Date.now() - phaseStarted) / 1000))
      : 0
  );
  await run('UPDATE matches SET phase_elapsed_seconds = ?, phase_started_at = NULL WHERE id = ?', [elapsed, matchId]);
  const { settings } = await getStageSettings(match);
  const home = Number(match.home_score || 0) + Number(match.extra_time_home || 0);
  const away = Number(match.away_score || 0) + Number(match.extra_time_away || 0);
  if (phase === 'regulation' && settings.extraTime && home === away) {
    await run(`UPDATE matches SET phase = 'extra_time', phase_started_at = ?, phase_elapsed_seconds = 0 WHERE id = ?`, [now(), matchId]);
    await recordPhase(matchId, tournamentId, 'extra_time', 'start');
    return await snapshot(matchId, tournamentId);
  }
  if ((phase === 'regulation' || phase === 'extra_time') && settings.penalties && home === away) {
    await run(
      `UPDATE matches SET phase = 'shootout', phase_started_at = ?, phase_elapsed_seconds = 0,
        penalties_home = COALESCE(penalties_home, 0), penalties_away = COALESCE(penalties_away, 0)
       WHERE id = ?`
    , [now(), matchId]);
    await recordPhase(matchId, tournamentId, 'shootout', 'start');
    return await snapshot(matchId, tournamentId);
  }
  const result = await finishMatchRecord({
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
  await run(`UPDATE matches SET phase = 'finished' WHERE id = ?`, [matchId]);
  await recordPhase(matchId, tournamentId, phase, 'finish');
  await rebuildTournamentProjections(tournamentId);
  return { ...(await snapshot(matchId, tournamentId)), advance: result.advance };
}

async function abandon({ matchId, tournamentId, refereeId, adminOverride = false, moderatorOverride = false, reason }) {
  const match = await getMatch(matchId, tournamentId);
  if (!adminOverride && !moderatorOverride && match.referee_id !== refereeId) throw httpError(403, 'Only the assigned referee can operate this match');
  if (!reason?.trim()) throw httpError(400, 'A reason is required to abandon a match');
  await run(
    `UPDATE matches SET status = 'scheduled', phase = 'abandoned', home_score = NULL, away_score = NULL,
      extra_time_home = NULL, extra_time_away = NULL, penalties_home = NULL, penalties_away = NULL,
      started_at = NULL, phase_started_at = NULL, phase_elapsed_seconds = 0 WHERE id = ?`
  , [matchId]);
  await suspension.resetDecisionsForAbandonedMatch(matchId);
  await recordPhase(matchId, tournamentId, 'regulation', 'abandon');
  return await snapshot(matchId, tournamentId);
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
