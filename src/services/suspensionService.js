const { db, now, parseJson } = require('../db');
const { id } = require('../utils/ids');
const { httpError } = require('../middleware/error');
const { defaultTournamentSettings } = require('./mappers');

function settingsFor(tournamentId) {
  const row = db.prepare('SELECT settings FROM tournaments WHERE id = ?').get(tournamentId);
  const defaults = defaultTournamentSettings();
  const settings = parseJson(row?.settings, defaults);
  return {
    ...defaults,
    ...settings,
    suspensionSystem: {
      ...defaults.suspensionSystem,
      ...(settings.suspensionSystem || {}),
    },
  };
}

function matchOrder(matchId) {
  return db.prepare(
    `SELECT m.id, m.tournament_id, m.created_at, m.scheduled_at, m.started_at,
            m.finished_at, m.status, m.matchday, s.sequence_order
     FROM matches m JOIN stages s ON s.id = m.stage_id WHERE m.id = ?`
  ).get(matchId);
}

function isBefore(source, target) {
  if (source.sequence_order !== target.sequence_order) {
    return source.sequence_order < target.sequence_order;
  }
  if (source.matchday != null && target.matchday != null
      && source.matchday !== target.matchday) {
    return source.matchday < target.matchday;
  }
  if (source.finished_at && target.status !== 'finished') return true;
  const sourceTime = source.finished_at || source.started_at || source.created_at;
  const targetTime = target.started_at || target.scheduled_at || target.created_at;
  return String(sourceTime) < String(targetTime);
}

function priorMatchesForPlayer(playerId, target) {
  const participant = db.prepare('SELECT participant_team_id FROM participant_players WHERE id = ?').get(playerId);
  if (!participant) return [];
  return db.prepare(
    `SELECT m.*, s.sequence_order
     FROM matches m JOIN stages s ON s.id = m.stage_id
     WHERE m.tournament_id = ? AND m.status = 'finished'
       AND (m.home_participant_team_id = ? OR m.away_participant_team_id = ?)
     ORDER BY s.sequence_order, m.matchday, datetime(COALESCE(m.finished_at, m.created_at)), m.id`
  ).all(target.tournament_id, participant.participant_team_id, participant.participant_team_id)
    .filter((match) => isBefore(match, target));
}

function ensureDecision({ targetMatchId, playerId, kind, sourceMatchId, sourceEventId }) {
  const existing = db.prepare(
    `SELECT * FROM player_match_suspensions
     WHERE participant_player_id = ? AND target_match_id = ? AND kind = ?`
  ).get(playerId, targetMatchId, kind);
  if (existing) return existing;
  db.prepare(
    `INSERT INTO player_match_suspensions
      (id, tournament_id, participant_player_id, target_match_id, source_match_id, source_event_id, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id(), matchOrder(targetMatchId).tournament_id, playerId, targetMatchId, sourceMatchId, sourceEventId, kind);
  return db.prepare(
    `SELECT * FROM player_match_suspensions
     WHERE participant_player_id = ? AND target_match_id = ? AND kind = ?`
  ).get(playerId, targetMatchId, kind);
}

function syncPlayerForMatch(playerId, target) {
  const system = settingsFor(target.tournament_id).suspensionSystem;
  if (!system.enabled) return [];
  const priorMatches = priorMatchesForPlayer(playerId, target);
  const cardEvents = priorMatches.flatMap((match) => db.prepare(
    `SELECT * FROM match_events
     WHERE match_id = ? AND player_id = ? AND type = 'card'
     ORDER BY datetime(created_at), id`
  ).all(match.id, playerId).map((event) => ({ ...event, sourceMatchId: match.id })));
  const results = [];
  const redEvents = cardEvents.filter((event) => event.card === 'red');
  if (redEvents.length) {
    const source = redEvents[redEvents.length - 1];
    const includedDecision = db.prepare(
      `SELECT 1 FROM player_match_suspensions
       WHERE participant_player_id = ? AND kind = 'red_card'
         AND source_event_id = ? AND status = 'included' LIMIT 1`
    ).get(playerId, source.id);
    if (!includedDecision) {
      results.push(ensureDecision({
        targetMatchId: target.id,
        playerId,
        kind: 'red_card',
        sourceMatchId: source.sourceMatchId,
        sourceEventId: source.id,
      }));
    }
  }

  const priorYellowDecision = db.prepare(
    `SELECT pms.* FROM player_match_suspensions pms
     WHERE pms.participant_player_id = ? AND pms.tournament_id = ? AND pms.kind = 'yellow_threshold'
       AND pms.target_match_id != ?
     ORDER BY datetime(created_at) DESC LIMIT 1`
  ).get(playerId, target.tournament_id, target.id);
  const yellowEvents = cardEvents.filter((event) => event.card === 'yellow'
    && (!priorYellowDecision || String(event.created_at) > String(
      db.prepare('SELECT created_at FROM match_events WHERE id = ?').get(priorYellowDecision.source_event_id)?.created_at
    )));
  const threshold = Math.max(1, Number(system.yellowCardsForSuspension) || 2);
  const redFromSecondYellow = redEvents.some((event) =>
    parseJson(event.payload, {}).automaticSecondYellow === true
  );
  if (!redFromSecondYellow && yellowEvents.length >= threshold) {
    const source = yellowEvents[threshold - 1];
    results.push(ensureDecision({
      targetMatchId: target.id,
      playerId,
      kind: 'yellow_threshold',
      sourceMatchId: source.sourceMatchId,
      sourceEventId: source.id,
    }));
  }
  return results;
}

function getForMatch(matchId, tournamentId) {
  const target = matchOrder(matchId);
  if (!target || target.tournament_id !== tournamentId) throw httpError(404, 'Match not found');
  if (!settingsFor(tournamentId).suspensionSystem.enabled) return [];
  const players = db.prepare(
    `SELECT pp.id FROM participant_players pp
     JOIN matches m ON m.home_participant_team_id = pp.participant_team_id
       OR m.away_participant_team_id = pp.participant_team_id
     WHERE m.id = ?`
  ).all(matchId);
  players.forEach(({ id: playerId }) => syncPlayerForMatch(playerId, target));
  const rows = db.prepare(
    `SELECT pms.*, p.name AS player_name
     FROM player_match_suspensions pms
     JOIN participant_players pp ON pp.id = pms.participant_player_id
     JOIN players p ON p.id = pp.player_id
     WHERE pms.target_match_id = ?
     ORDER BY p.name, pms.kind`
  ).all(matchId).map((row) => ({
    id: row.id,
    participantPlayerId: row.participant_player_id,
    playerName: row.player_name,
    sourceMatchId: row.source_match_id,
    sourceEventId: row.source_event_id,
    kind: row.kind,
    status: row.status,
    pendingDecision: row.kind === 'red_card' && row.status === 'pending',
  }));
  return rows;
}

function resetDecisionsForAbandonedMatch(matchId) {
  db.prepare(
    `UPDATE player_match_suspensions
     SET status = 'pending', decided_by = NULL, decided_at = NULL
     WHERE target_match_id = ? AND kind = 'red_card' AND status IN ('included', 'excluded')`
  ).run(matchId);
}

function assertCanStart(matchId, tournamentId) {
  const suspensions = getForMatch(matchId, tournamentId);
  const pendingRed = suspensions.find((row) => row.kind === 'red_card' && row.status === 'pending');
  if (pendingRed) {
    throw httpError(409, `Choose Include or Exclude for ${pendingRed.playerName} before kickoff.`);
  }
}

function consumeForStart(matchId, tournamentId) {
  db.prepare(
    `UPDATE player_match_suspensions
     SET status = 'consumed', decided_at = COALESCE(decided_at, ?)
     WHERE target_match_id = ? AND kind = 'yellow_threshold' AND status = 'pending'`
  ).run(now(), matchId);
  return getForMatch(matchId, tournamentId);
}

function decide({ matchId, tournamentId, suspensionId, include, actorId }) {
  const row = db.prepare(
    `SELECT * FROM player_match_suspensions
     WHERE id = ? AND target_match_id = ? AND tournament_id = ?`
  ).get(suspensionId, matchId, tournamentId);
  if (!row) throw httpError(404, 'Suspension decision not found');
  const match = db.prepare('SELECT status FROM matches WHERE id = ?').get(matchId);
  if (!['scheduled', 'postponed'].includes(match?.status)) {
    throw httpError(409, 'Suspension decisions are available only before kickoff.');
  }
  if (row.kind !== 'red_card') throw httpError(400, 'Yellow-card suspensions do not have an Include/Exclude decision.');
  const status = include ? 'included' : 'excluded';
  db.prepare(
    `UPDATE player_match_suspensions
     SET status = ?, decided_by = ?, decided_at = ?
     WHERE source_event_id = ? AND kind = 'red_card' AND status = 'pending'`
  ).run(status, actorId, now(), row.source_event_id);
  return getForMatch(matchId, tournamentId);
}

module.exports = {
  getForMatch,
  assertCanStart,
  consumeForStart,
  decide,
  resetDecisionsForAbandonedMatch,
};
