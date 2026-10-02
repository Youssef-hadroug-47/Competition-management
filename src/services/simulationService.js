const { query, parseJson, now } = require('../db');
const { httpError } = require('../middleware/error');
const map = require('./mappers');
const { runDraw } = require('./drawService');
const { finishMatchRecord, rebuildTournamentProjections } = require('./matchService');
const { getProjectedScore } = require('./refereeService');
const { id } = require('../utils/ids');

// --- Random-weighted result generation --------------------------------
//
// Every participant's "strength" is derived from its tournament seed
// (seed 1 = strongest). Teams without a seed are treated as perfectly
// average, so an unseeded tournament just gets a mild home-advantage bump
// and otherwise plays out as a fair coin flip. Scorelines are sampled from
// a Poisson distribution around a league-average total-goals figure, split
// between the two sides according to their relative strength.

const AVERAGE_TOTAL_GOALS = 2.6; // roughly a real-world top-flight average
const HOME_ADVANTAGE = 0.08; // shifts goal-share toward the home side
const MAX_GOALS = 9; // sanity cap so a freak Poisson draw doesn't look silly

function poissonSample(lambda) {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= Math.random();
  } while (p > limit);
  return Math.min(k - 1, MAX_GOALS);
}

function strengthOf(seed) {
  if (seed == null || seed <= 0) return 50; // neutral baseline
  return Math.max(10, 110 - seed * 5); // seed 1 -> 105 ... seed 20 -> 10
}

function randomScoreline(homeSeed, awaySeed) {
  const homeStrength = strengthOf(homeSeed);
  const awayStrength = strengthOf(awaySeed);
  const total = homeStrength + awayStrength;
  let homeShare = homeStrength / total;
  homeShare = homeShare + HOME_ADVANTAGE * (1 - homeShare);
  homeShare = Math.min(0.85, Math.max(0.15, homeShare));
  const awayShare = 1 - homeShare;
  return {
    homeScore: poissonSample(AVERAGE_TOTAL_GOALS * homeShare),
    awayScore: poissonSample(AVERAGE_TOTAL_GOALS * awayShare),
  };
}

// Penalty shootouts are always decisive, unlike normal/extra time.
function randomPenalties() {
  let home = 3 + Math.floor(Math.random() * 3); // 3-5
  let away = 3 + Math.floor(Math.random() * 3);
  if (home === away) {
    if (Math.random() < 0.5) home += 1;
    else away += 1;
  }
  return { home, away };
}

async function getParticipant(participantTeamId) {
  const result = await query('SELECT * FROM participant_teams WHERE id = $1', [participantTeamId]);
  return result.rows[0] || null;
}

async function rosterForTeam(teamId) {
  const result = await query(
    `SELECT pp.id, pp.player_id
     FROM participant_players pp
     WHERE pp.participant_team_id = $1
       AND pp.status NOT IN ('ineligible', 'suspended')`
    , [teamId]);
  return result.rows;
}

function randomRosterPlayer(roster, excludedId = null) {
  if (!roster.length) return null;
  const candidates = roster.filter((player) => player.id !== excludedId);
  const source = candidates.length ? candidates : roster;
  return source[Math.floor(Math.random() * source.length)];
}

function distributedMinute(phase, index, total) {
  const start = phase === 'extra_time' ? 91 : 1;
  const end = phase === 'extra_time' ? 120 : 90;
  const span = end - start + 1;
  const bucket = Math.floor((index / Math.max(1, total)) * span);
  return Math.min(end, start + bucket + Math.floor(Math.random() * Math.max(1, Math.ceil(span / Math.max(1, total)))));
}

async function insertSimulatedEvent(match, {
  type, phase, teamId = null, playerId = null, assisterId = null,
  goalEventId = null, card = null, scored = null, minute = null, payload = {},
}) {
  const eventId = id();
  await query(
    `INSERT INTO match_events
      (id, match_id, tournament_id, type, phase, goal_event_id, team_id,
       player_id, assister_id, card, scored, minute, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
    eventId, match.id, match.tournament_id, type, phase, goalEventId, teamId,
    playerId, assisterId, card, scored == null ? null : (scored ? 1 : 0),
    minute, JSON.stringify(payload), now()
    ]);
  return eventId;
}

async function applySimulatedEvents(match, home, away, homeGoals, awayGoals, phase = 'regulation') {
  const homeRoster = await rosterForTeam(home?.id);
  const awayRoster = await rosterForTeam(away?.id);
  let generated = 0;

  const assignGoals = async (roster, count, teamId) => {
    for (let i = 0; i < count; i += 1) {
      const scorer = roster.length ? randomRosterPlayer(roster) : null;
      const assister = scorer && Math.random() < 0.75 ? randomRosterPlayer(roster, scorer.id) : null;
      const goalId = await insertSimulatedEvent(match, {
        type: 'goal', phase, teamId, playerId: scorer?.id || null,
        minute: distributedMinute(phase, i, count),
        payload: { simulated: true },
      });
      generated += 1;
      if (assister) {
        await insertSimulatedEvent(match, {
          type: 'assist', phase, teamId, playerId: assister.id,
          goalEventId: goalId, minute: distributedMinute(phase, i, count),
          payload: { simulated: true },
        });
        generated += 1;
      }
    }
  };

  const assignCards = async (roster, teamId) => {
    if (!roster.length) return;
    const yellowCount = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < yellowCount; i += 1) {
      await insertSimulatedEvent(match, {
        type: 'card', phase, teamId, playerId: randomRosterPlayer(roster).id,
        card: 'yellow', minute: distributedMinute(phase, i, yellowCount),
        payload: { simulated: true },
      });
      generated += 1;
    }
    if (Math.random() < 0.08) {
      await insertSimulatedEvent(match, {
        type: 'card', phase, teamId, playerId: randomRosterPlayer(roster).id,
        card: 'red', minute: distributedMinute(phase, yellowCount, yellowCount + 1),
        payload: { simulated: true },
      });
      generated += 1;
    }
  };

  await assignGoals(homeRoster, homeGoals, home.id);
  await assignGoals(awayRoster, awayGoals, away.id);
  await assignCards(homeRoster, home.id);
  await assignCards(awayRoster, away.id);
  return generated;
}

async function applySimulatedShootout(match, home, away, homeTotal, awayTotal) {
  const attempts = Math.max(5, homeTotal, awayTotal);
  let generated = 0;
  for (let index = 0; index < attempts; index += 1) {
    const homeScored = index < homeTotal || (index >= 5 && index < homeTotal);
    const awayScored = index < awayTotal || (index >= 5 && index < awayTotal);
    await insertSimulatedEvent(match, {
      type: 'shootout_attempt', phase: 'shootout',
      teamId: home.id, scored: homeScored,
      minute: index + 1, payload: { simulated: true, scored: homeScored },
    });
    await insertSimulatedEvent(match, {
      type: 'shootout_attempt', phase: 'shootout',
      teamId: away.id, scored: awayScored,
      minute: index + 1, payload: { simulated: true, scored: awayScored },
    });
    generated += 2;
  }
  return generated;
}

// Simulates one match: generates a random-weighted score, finishes it the
// same way a referee would, and — for knockout ties still level after
// normal time — keeps resolving with extra time and then penalties
// (respecting the stage's own settings) until the tie has a winner.
async function simulateMatch(matchId, { actorId } = {}) {
  const rowResult = await query('SELECT * FROM matches WHERE id = $1', [matchId]);
  const row = rowResult.rows[0];
  if (!row) throw httpError(404, 'Match not found');
  if (row.status === 'finished') {
    return { match: map.match(row), advance: null, skipped: true };
  }

  const stageResult = await query('SELECT * FROM stages WHERE id = $1', [row.stage_id]);
  const stage = stageResult.rows[0];
  const settings = parseJson(stage?.settings, map.defaultStageSettings(stage?.type));
  const home = await getParticipant(row.home_participant_team_id);
  const away = await getParticipant(row.away_participant_team_id);
  const { homeScore, awayScore } = randomScoreline(home?.seed, away?.seed);

  let generatedEvents = await applySimulatedEvents(row, home, away, homeScore, awayScore);
  let projected = await getProjectedScore(row.id);
  let extraTime = null;
  let penalties = null;

  if (stage?.type === 'knockout' && projected.home === projected.away && settings.extraTime) {
    extraTime = randomScoreline(home?.seed, away?.seed);
    generatedEvents += await applySimulatedEvents(
      row, home, away, Math.min(2, extraTime.homeScore), Math.min(2, extraTime.awayScore), 'extra_time'
    );
    projected = await getProjectedScore(row.id);
  }

  if (stage?.type === 'knockout'
      && projected.home + projected.extraHome === projected.away + projected.extraAway
      && settings.penalties) {
    penalties = randomPenalties();
    generatedEvents += await applySimulatedShootout(row, home, away, penalties.home, penalties.away);
    projected = await getProjectedScore(row.id);
  }

  await rebuildTournamentProjections(row.tournament_id);
  const result = await finishMatchRecord({
    matchRow: row,
    homeScore: projected.home,
    awayScore: projected.away,
    extraTimeHome: projected.extraHome || null,
    extraTimeAway: projected.extraAway || null,
    penaltiesHome: projected.penaltiesHome || null,
    penaltiesAway: projected.penaltiesAway || null,
    refereeId: actorId,
  });
  await rebuildTournamentProjections(row.tournament_id);
  return {
    match: map.match(result.match),
    advance: result.advance,
    generatedEvents,
    extraTime: Boolean(extraTime),
    penalties: Boolean(penalties),
  };
}

async function simulateMatchCollection(matchRows, { actorId, maxRounds = 40 } = {}) {
  let matchesSimulated = 0;
  let lastAdvance = null;
  for (let round = 0; round < maxRounds; round += 1) {
    const pending = (await matchRows())
      .filter((match) => match.status !== 'finished');
    if (!pending.length) break;
    for (const match of pending) {
      const result = await simulateMatch(match.id, { actorId });
      if (!result.skipped) matchesSimulated += 1;
      if (result.advance) lastAdvance = result.advance;
    }
  }
  return { matchesSimulated, advance: lastAdvance };
}

async function simulateGroup(groupId, { actorId } = {}) {
  const groupResult = await query('SELECT * FROM groups WHERE id = $1', [groupId]);
  const group = groupResult.rows[0];
  if (!group) throw httpError(404, 'Group not found');
  const result = await simulateMatchCollection(
    async () => (await query('SELECT * FROM matches WHERE group_id = $1 ORDER BY matchday ASC, created_at ASC', [group.id])).rows,
    { actorId }
  );
  return { groupId: group.id, ...result };
}

async function simulateRound(roundId, { actorId } = {}) {
  const roundResult = await query('SELECT * FROM rounds WHERE id = $1', [roundId]);
  const round = roundResult.rows[0];
  if (!round) throw httpError(404, 'Round not found');
  const result = await simulateMatchCollection(
    async () => (await query('SELECT * FROM matches WHERE group_id = $1 ORDER BY matchday ASC, created_at ASC', [round.id])).rows,
    { actorId }
  );
  return { roundId: round.id, ...result };
}

// Simulates every remaining match in a stage. Draws the stage first if it
// hasn't been drawn yet (the same rule as a manual draw applies: an earlier
// stage must be finished before a later one can draw its promoted teams —
// simulateTournament respects that by simulating stages in order). For
// knockout stages this naturally cascades round by round, since finishing a
// round's last match auto-generates the next round's fixtures.
async function simulateStage(stageId, { actorId, maxRounds = 40 } = {}) {
  const stageResult = await query('SELECT * FROM stages WHERE id = $1', [stageId]);
  const stage = stageResult.rows[0];
  if (!stage) throw httpError(404, 'Stage not found');

  const existingResult = await query('SELECT COUNT(*) AS c FROM matches WHERE stage_id = $1', [stage.id]);
  const existing = existingResult.rows[0];
  let drawResult = null;
  if (existing.c === 0) {
    drawResult = await runDraw({ tournamentId: stage.tournament_id, stageId: stage.id });
  }

  const result = await simulateMatchCollection(
    async () => (await query(`SELECT * FROM matches WHERE stage_id = $1 AND status != 'finished'
      ORDER BY matchday ASC, created_at ASC`, [stage.id])).rows,
    { actorId, maxRounds }
  );

  return {
    stageId: stage.id,
    stageType: stage.type,
    sequenceOrder: stage.sequence_order,
    drew: Boolean(drawResult),
    matchesSimulated: result.matchesSimulated,
    advance: result.advance,
  };
}

// Simulates a tournament to completion: walks its stages in order, drawing
// and simulating each in turn so later stages always have their promoted
// teams ready by the time they're drawn.
async function simulateTournament(tournamentId, { actorId, maxStages = 20 } = {}) {
  const tournamentResult = await query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
  const tournament = tournamentResult.rows[0];
  if (!tournament) throw httpError(404, 'Tournament not found');

  const stagesResult = await query('SELECT * FROM stages WHERE tournament_id = $1 ORDER BY sequence_order ASC', [tournamentId]);
  const stages = stagesResult.rows;
  if (!stages.length) throw httpError(400, 'Create at least one stage before simulating');

  const stageResults = [];
  for (const stage of stages.slice(0, maxStages)) {
    stageResults.push(await simulateStage(stage.id, { actorId }));
  }

  const updatedTournamentResult = await query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
  const updatedTournament = updatedTournamentResult.rows[0];
  return {
    tournamentId,
    status: updatedTournament.status,
    stages: stageResults,
  };
}

module.exports = {
  simulateMatch,
  simulateGroup,
  simulateRound,
  simulateStage,
  simulateTournament,
  randomScoreline,
};
