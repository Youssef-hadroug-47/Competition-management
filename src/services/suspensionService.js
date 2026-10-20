const { query, now, parseJson } = require('../db');
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
async function syncPlayersForMatch(players, target, system) {
  if (!system.enabled || !players.length) return;
  const playerIds = players.map((player) => player.id);

  // Every finished match that involves any of this match's players, in the
  // same order used to derive suspensions.
  const matchRows = await many(
    `SELECT pp.id AS player_id,m.*,s.sequence_order
     FROM participant_players pp
     JOIN matches m
       ON m.home_participant_team_id = pp.participant_team_id
       OR m.away_participant_team_id = pp.participant_team_id
     JOIN stages s ON s.id = m.stage_id
     WHERE pp.id = ANY($1::text[]) AND m.tournament_id=$2 AND m.status='finished'
     ORDER BY pp.id,s.sequence_order,m.matchday,COALESCE(m.finished_at,m.created_at),m.id`,
    [playerIds, target.tournament_id],
  );
  const priorMatchesByPlayer = new Map();
  const priorMatchIds = new Set();
  for (const row of matchRows) {
    const { player_id: playerId, ...match } = row;
    if (!isBefore(match, target)) continue;
    if (!priorMatchesByPlayer.has(playerId)) priorMatchesByPlayer.set(playerId, []);
    priorMatchesByPlayer.get(playerId).push(match);
    priorMatchIds.add(match.id);
  }
  const priorIdsByPlayer = new Map();
  for (const [playerId, matches] of priorMatchesByPlayer) {
    priorIdsByPlayer.set(playerId, new Set(matches.map((match) => match.id)));
  }

  // Card events for every prior match at once, grouped per player in memory.
  const cardRows = priorMatchIds.size
    ? await many(
      `SELECT * FROM match_events
       WHERE match_id = ANY($1::text[]) AND player_id = ANY($2::text[]) AND type='card'
       ORDER BY player_id,created_at,id`,
      [[...priorMatchIds], playerIds],
    )
    : [];
  const cardsByPlayer = new Map();
  for (const event of cardRows) {
    if (!priorIdsByPlayer.get(event.player_id)?.has(event.match_id)) continue;
    if (!cardsByPlayer.has(event.player_id)) cardsByPlayer.set(event.player_id, []);
    cardsByPlayer.get(event.player_id).push(event);
  }

  // Existing red-card decisions that already count as included.
  const includedRedRows = await many(
    `SELECT participant_player_id,source_event_id FROM player_match_suspensions
     WHERE participant_player_id = ANY($1::text[]) AND kind='red_card' AND status='included'`,
    [playerIds],
  );
  const includedReds = new Set(includedRedRows.map((row) => `${row.participant_player_id}\u0000${row.source_event_id}`));

  // Latest yellow-threshold decision per player that targets a different match.
  const priorYellowRows = await many(
    `SELECT DISTINCT ON (pms.participant_player_id)
            pms.participant_player_id,pms.source_event_id,me.created_at AS source_created_at
     FROM player_match_suspensions pms
     LEFT JOIN match_events me ON me.id = pms.source_event_id
     WHERE pms.participant_player_id = ANY($1::text[])
       AND pms.tournament_id=$2 AND pms.kind='yellow_threshold' AND pms.target_match_id<>$3
     ORDER BY pms.participant_player_id,pms.created_at DESC`,
    [playerIds, target.tournament_id, target.id],
  );
  const priorYellowByPlayer = new Map(priorYellowRows.map((row) => [row.participant_player_id, row]));

  const threshold = Math.max(1, Number(system.yellowCardsForSuspension) || 2);
  const decisions = [];
  for (const player of players) {
    const playerId = player.id;
    const cardEvents = cardsByPlayer.get(playerId) || [];
    const redEvents = cardEvents.filter((event) => event.card === 'red');
    if (redEvents.length) {
      const source = redEvents[redEvents.length - 1];
      if (!includedReds.has(`${playerId}\u0000${source.id}`)) {
        decisions.push({
          tournamentId: target.tournament_id,
          playerId,
          targetMatchId: target.id,
          sourceMatchId: source.match_id,
          sourceEventId: source.id,
          kind: 'red_card',
        });
      }
    }
    const priorYellow = priorYellowByPlayer.get(playerId);
    let yellowEvents = cardEvents.filter((event) => event.card === 'yellow');
    if (priorYellow) {
      yellowEvents = yellowEvents.filter(
        (event) => String(event.created_at) > String(priorYellow.source_created_at),
      );
    }
    const redFromSecondYellow = redEvents.some(
      (event) => parseJson(event.payload, {}).automaticSecondYellow === true,
    );
    if (!redFromSecondYellow && yellowEvents.length >= threshold) {
      const source = yellowEvents[threshold - 1];
      decisions.push({
        tournamentId: target.tournament_id,
        playerId,
        targetMatchId: target.id,
        sourceMatchId: source.match_id,
        sourceEventId: source.id,
        kind: 'yellow_threshold',
      });
    }
  }
  if (!decisions.length) return;
  await query(
    `INSERT INTO player_match_suspensions
       (id,tournament_id,participant_player_id,target_match_id,source_match_id,source_event_id,kind)
     SELECT v.id,v.tournament_id,v.player_id,v.target_match_id,v.source_match_id,v.source_event_id,v.kind
     FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::text[])
       AS v(id,tournament_id,player_id,target_match_id,source_match_id,source_event_id,kind)
     ON CONFLICT (participant_player_id,target_match_id,kind) DO NOTHING`,
    [
      decisions.map(() => id()),
      decisions.map((decision) => decision.tournamentId),
      decisions.map((decision) => decision.playerId),
      decisions.map((decision) => decision.targetMatchId),
      decisions.map((decision) => decision.sourceMatchId),
      decisions.map((decision) => decision.sourceEventId),
      decisions.map((decision) => decision.kind),
    ],
  );
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
  await syncPlayersForMatch(players, target, system);
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
