const { query, now, parseJson, withTransaction } = require('../db');
const { id } = require('../utils/ids');
const { httpError } = require('../middleware/error');
const { defaultTournamentSettings } = require('./mappers');

const one = async (sql, values = [], client) => (await (client || { query }).query(sql, values)).rows[0] || null;
const many = async (sql, values = [], client) => (await (client || { query }).query(sql, values)).rows;

async function settingsFor(tournamentId) {
  const row = await one('SELECT settings FROM tournaments WHERE id=$1', [tournamentId]);
  const defaults = defaultTournamentSettings();
  const settings = parseJson(row?.settings, defaults);
  return { ...defaults, ...settings, suspensionSystem: { ...defaults.suspensionSystem, ...(settings.suspensionSystem || {}) } };
}
async function matchOrder(matchId) {
  return one(`SELECT m.id,m.tournament_id,m.created_at,m.scheduled_at,m.started_at,m.finished_at,m.status,m.matchday,s.sequence_order
    FROM matches m JOIN stages s ON s.id=m.stage_id WHERE m.id=$1`, [matchId]);
}
function isBefore(source, target) {
  if (source.sequence_order !== target.sequence_order) return source.sequence_order < target.sequence_order;
  if (source.matchday != null && target.matchday != null && source.matchday !== target.matchday) return source.matchday < target.matchday;
  if (source.finished_at && target.status !== 'finished') return true;
  return String(source.finished_at || source.started_at || source.created_at) < String(target.started_at || target.scheduled_at || target.created_at);
}
async function priorMatchesForPlayer(playerId, target) {
  const rows = await many(`SELECT m.*,s.sequence_order FROM matches m JOIN stages s ON s.id=m.stage_id
    JOIN participant_players pp
      ON pp.participant_team_id = m.home_participant_team_id
      OR pp.participant_team_id = m.away_participant_team_id
    WHERE pp.id=$1 AND m.tournament_id=$2 AND m.status='finished'
    ORDER BY s.sequence_order,m.matchday,COALESCE(m.finished_at,m.created_at),m.id`,
  [playerId, target.tournament_id]);
  return rows.filter((match) => isBefore(match, target));
}
async function ensureDecision({ tournamentId, targetMatchId, playerId, kind, sourceMatchId, sourceEventId }, client) {
  const inserted = await (client || { query }).query(`INSERT INTO player_match_suspensions
    (id,tournament_id,participant_player_id,target_match_id,source_match_id,source_event_id,kind)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (participant_player_id,target_match_id,kind) DO NOTHING
    RETURNING *`, [id(), tournamentId, playerId, targetMatchId, sourceMatchId, sourceEventId, kind]);
  if (inserted.rows[0]) return inserted.rows[0];
  return one(`SELECT * FROM player_match_suspensions WHERE participant_player_id=$1 AND target_match_id=$2 AND kind=$3`,
    [playerId, targetMatchId, kind], client);
}
async function syncPlayerForMatch(playerId, target, system) {
  if (!system.enabled) return [];
  const prior = await priorMatchesForPlayer(playerId, target);
  const priorById = new Map(prior.map((match) => [match.id, match]));
  const cardEvents = prior.length
    ? (await many(
      `SELECT * FROM match_events
       WHERE match_id = ANY($1::text[]) AND player_id = $2 AND type = 'card'
       ORDER BY created_at, id`,
      [prior.map((match) => match.id), playerId],
    )).map((event) => ({ ...event, sourceMatchId: priorById.get(event.match_id)?.id }))
    : [];
  const results = [];
  const redEvents = cardEvents.filter((event) => event.card === 'red');
  if (redEvents.length) {
    const source = redEvents[redEvents.length - 1];
    const included = await one(`SELECT 1 FROM player_match_suspensions WHERE participant_player_id=$1 AND kind='red_card' AND source_event_id=$2 AND status='included' LIMIT 1`, [playerId, source.id]);
    if (!included) results.push(await ensureDecision({ tournamentId: target.tournament_id, targetMatchId: target.id, playerId, kind: 'red_card', sourceMatchId: source.sourceMatchId, sourceEventId: source.id }));
  }
  const priorYellow = await one(`SELECT * FROM player_match_suspensions WHERE participant_player_id=$1 AND tournament_id=$2 AND kind='yellow_threshold' AND target_match_id<>$3 ORDER BY created_at DESC LIMIT 1`, [playerId, target.tournament_id, target.id]);
  let yellowEvents = cardEvents.filter((event) => event.card === 'yellow');
  if (priorYellow) {
    const source = await one('SELECT created_at FROM match_events WHERE id=$1', [priorYellow.source_event_id]);
    yellowEvents = yellowEvents.filter((event) => String(event.created_at) > String(source?.created_at));
  }
  const threshold = Math.max(1, Number(system.yellowCardsForSuspension) || 2);
  const redFromSecondYellow = redEvents.some((event) => parseJson(event.payload, {}).automaticSecondYellow === true);
  if (!redFromSecondYellow && yellowEvents.length >= threshold) {
    const source = yellowEvents[threshold - 1];
    results.push(await ensureDecision({ tournamentId: target.tournament_id, targetMatchId: target.id, playerId, kind: 'yellow_threshold', sourceMatchId: source.sourceMatchId, sourceEventId: source.id }));
  }
  return results;
}
async function getForMatch(matchId, tournamentId) {
  const [target, settings] = await Promise.all([
    matchOrder(matchId),
    settingsFor(tournamentId),
  ]);
  if (!target || target.tournament_id !== tournamentId) throw httpError(404, 'Match not found');
  const system = settings.suspensionSystem;
  if (!system.enabled) return [];
  const players = await many(`SELECT pp.id FROM participant_players pp JOIN matches m ON m.home_participant_team_id=pp.participant_team_id OR m.away_participant_team_id=pp.participant_team_id WHERE m.id=$1`, [matchId]);
  for (let index = 0; index < players.length; index += 8) {
    await Promise.all(players.slice(index, index + 8).map((player) => (
      syncPlayerForMatch(player.id, target, system)
    )));
  }
  const rows = await many(`SELECT pms.*,pp.name AS player_name FROM player_match_suspensions pms
    JOIN participant_players pp ON pp.id=pms.participant_player_id
    WHERE pms.target_match_id=$1 ORDER BY pp.name,pms.kind`, [matchId]);
  return rows.map((row) => ({ id: row.id, participantPlayerId: row.participant_player_id, playerName: row.player_name,
    sourceMatchId: row.source_match_id, sourceEventId: row.source_event_id, kind: row.kind, status: row.status,
    pendingDecision: row.kind === 'red_card' && row.status === 'pending' }));
}
async function resetDecisionsForAbandonedMatch(matchId) {
  await query(`UPDATE player_match_suspensions SET status='pending',decided_by=NULL,decided_at=NULL
    WHERE target_match_id=$1 AND kind='red_card' AND status IN ('included','excluded')`, [matchId]);
}
async function assertCanStart(matchId, tournamentId) {
  const suspensions = await getForMatch(matchId, tournamentId);
  const pending = suspensions.find((row) => row.kind === 'red_card' && row.status === 'pending');
  if (pending) throw httpError(409, `Choose Include or Exclude for ${pending.playerName} before kickoff.`);
}
async function consumeForStart(matchId) {
  return query(`UPDATE player_match_suspensions SET status='consumed',decided_at=COALESCE(decided_at,$1)
    WHERE target_match_id=$2 AND kind='yellow_threshold' AND status='pending'`, [now(), matchId]);
}
async function decide({ matchId, tournamentId, suspensionId, include, actorId }) {
  const [row, match] = await Promise.all([
    one(
      'SELECT * FROM player_match_suspensions WHERE id=$1 AND target_match_id=$2 AND tournament_id=$3',
      [suspensionId, matchId, tournamentId],
    ),
    one('SELECT status FROM matches WHERE id=$1', [matchId]),
  ]);
  if (!row) throw httpError(404, 'Suspension decision not found');
  if (!['scheduled', 'postponed'].includes(match?.status)) throw httpError(409, 'Suspension decisions are available only before kickoff.');
  if (row.kind !== 'red_card') throw httpError(400, 'Yellow-card suspensions do not have an Include/Exclude decision.');
  await query(`UPDATE player_match_suspensions SET status=$1,decided_by=$2,decided_at=$3
    WHERE source_event_id=$4 AND kind='red_card' AND status='pending'`, [include ? 'included' : 'excluded', actorId, now(), row.source_event_id]);
  return getForMatch(matchId, tournamentId);
}
module.exports = { getForMatch, assertCanStart, consumeForStart, decide, resetDecisionsForAbandonedMatch };
