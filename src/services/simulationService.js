const { db, parseJson, now } = require('../db');
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

function getParticipant(participantTeamId) {
  return db.prepare('SELECT * FROM participant_teams WHERE id = ?').get(participantTeamId);
}

function rosterForTeam(teamId) {
  return db.prepare(
    `SELECT pp.id, pp.player_id
     FROM participant_players pp
     WHERE pp.participant_team_id = ?
       AND pp.status NOT IN ('ineligible', 'suspended')`
  ).all(teamId);
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

function insertSimulatedEvent(match, {
  type, phase, teamId = null, playerId = null, assisterId = null,
  goalEventId = null, card = null, scored = null, minute = null, payload = {},
}) {
  const eventId = id();
  db.prepare(
    `INSERT INTO match_events
      (id, match_id, tournament_id, type, phase, goal_event_id, team_id,
       player_id, assister_id, card, scored, minute, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    eventId, match.id, match.tournament_id, type, phase, goalEventId, teamId,
    playerId, assisterId, card, scored == null ? null : (scored ? 1 : 0),
    minute, JSON.stringify(payload), now()
  );
  return eventId;
}

function applySimulatedEvents(match, home, away, homeGoals, awayGoals, phase = 'regulation') {
  const homeRoster = rosterForTeam(home?.id);
  const awayRoster = rosterForTeam(away?.id);
  let generated = 0;

  const assignGoals = (roster, count, teamId) => {
    for (let i = 0; i < count; i += 1) {
      const scorer = roster.length ? randomRosterPlayer(roster) : null;
      const assister = scorer && Math.random() < 0.75 ? randomRosterPlayer(roster, scorer.id) : null;
      const goalId = insertSimulatedEvent(match, {
        type: 'goal', phase, teamId, playerId: scorer?.id || null,
        minute: distributedMinute(phase, i, count),
        payload: { simulated: true },
      });
      generated += 1;
      if (assister) {
        insertSimulatedEvent(match, {
          type: 'assist', phase, teamId, playerId: assister.id,
          goalEventId: goalId, minute: distributedMinute(phase, i, count),
          payload: { simulated: true },
        });
        generated += 1;
      }
    }
  };

  const assignCards = (roster, teamId) => {
    if (!roster.length) return;
    const yellowCount = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < yellowCount; i += 1) {
      insertSimulatedEvent(match, {
        type: 'card', phase, teamId, playerId: randomRosterPlayer(roster).id,
        card: 'yellow', minute: distributedMinute(phase, i, yellowCount),
        payload: { simulated: true },
      });
      generated += 1;
    }
    if (Math.random() < 0.08) {
      insertSimulatedEvent(match, {
        type: 'card', phase, teamId, playerId: randomRosterPlayer(roster).id,
        card: 'red', minute: distributedMinute(phase, yellowCount, yellowCount + 1),
        payload: { simulated: true },
      });
      generated += 1;
    }
  };

  assignGoals(homeRoster, homeGoals, home.id);
  assignGoals(awayRoster, awayGoals, away.id);
  assignCards(homeRoster, home.id);
  assignCards(awayRoster, away.id);
  return generated;
}

function applySimulatedShootout(match, home, away, homeTotal, awayTotal) {
  const attempts = Math.max(5, homeTotal, awayTotal);
  let generated = 0;
  for (let index = 0; index < attempts; index += 1) {
    const homeScored = index < homeTotal || (index >= 5 && index < homeTotal);
    const awayScored = index < awayTotal || (index >= 5 && index < awayTotal);
    insertSimulatedEvent(match, {
      type: 'shootout_attempt', phase: 'shootout',
      teamId: home.id, scored: homeScored,
      minute: index + 1, payload: { simulated: true, scored: homeScored },
    });
    insertSimulatedEvent(match, {
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
function simulateMatch(matchId, { actorId } = {}) {
  const row = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!row) throw httpError(404, 'Match not found');
  if (row.status === 'finished') {
    return { match: map.match(row), advance: null, skipped: true };
  }

  const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(row.stage_id);
  const settings = parseJson(stage?.settings, map.defaultStageSettings(stage?.type));
  const home = getParticipant(row.home_participant_team_id);
  const away = getParticipant(row.away_participant_team_id);
  const { homeScore, awayScore } = randomScoreline(home?.seed, away?.seed);

  let generatedEvents = applySimulatedEvents(row, home, away, homeScore, awayScore);
  let projected = getProjectedScore(row.id);
  let extraTime = null;
  let penalties = null;

  if (stage?.type === 'knockout' && projected.home === projected.away && settings.extraTime) {
    extraTime = randomScoreline(home?.seed, away?.seed);
    generatedEvents += applySimulatedEvents(
      row, home, away, Math.min(2, extraTime.homeScore), Math.min(2, extraTime.awayScore), 'extra_time'
    );
    projected = getProjectedScore(row.id);
  }

  if (stage?.type === 'knockout'
      && projected.home + projected.extraHome === projected.away + projected.extraAway
      && settings.penalties) {
    penalties = randomPenalties();
    generatedEvents += applySimulatedShootout(row, home, away, penalties.home, penalties.away);
    projected = getProjectedScore(row.id);
  }

  rebuildTournamentProjections(row.tournament_id);
  const result = finishMatchRecord({
    matchRow: row,
    homeScore: projected.home,
    awayScore: projected.away,
    extraTimeHome: projected.extraHome || null,
    extraTimeAway: projected.extraAway || null,
    penaltiesHome: projected.penaltiesHome || null,
    penaltiesAway: projected.penaltiesAway || null,
    refereeId: actorId,
  });
  rebuildTournamentProjections(row.tournament_id);
  return {
    match: map.match(result.match),
    advance: result.advance,
    generatedEvents,
    extraTime: Boolean(extraTime),
    penalties: Boolean(penalties),
  };
}

function simulateMatchCollection(matchRows, { actorId, maxRounds = 40 } = {}) {
  let matchesSimulated = 0;
  let lastAdvance = null;
  for (let round = 0; round < maxRounds; round += 1) {
    const pending = matchRows()
      .filter((match) => match.status !== 'finished');
    if (!pending.length) break;
    pending.forEach((match) => {
      const result = simulateMatch(match.id, { actorId });
      if (!result.skipped) matchesSimulated += 1;
      if (result.advance) lastAdvance = result.advance;
    });
  }
  return { matchesSimulated, advance: lastAdvance };
}

function simulateGroup(groupId, { actorId } = {}) {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) throw httpError(404, 'Group not found');
  const result = simulateMatchCollection(
    () => db.prepare('SELECT * FROM matches WHERE group_id = ? ORDER BY matchday ASC, created_at ASC').all(group.id),
    { actorId }
  );
  return { groupId: group.id, ...result };
}

function simulateRound(roundId, { actorId } = {}) {
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(roundId);
  if (!round) throw httpError(404, 'Round not found');
  const result = simulateMatchCollection(
    () => db.prepare('SELECT * FROM matches WHERE group_id = ? ORDER BY matchday ASC, created_at ASC').all(round.id),
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
function simulateStage(stageId, { actorId, maxRounds = 40 } = {}) {
  const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(stageId);
  if (!stage) throw httpError(404, 'Stage not found');

  const existing = db.prepare('SELECT COUNT(*) AS c FROM matches WHERE stage_id = ?').get(stage.id);
  let drawResult = null;
  if (existing.c === 0) {
    drawResult = runDraw({ tournamentId: stage.tournament_id, stageId: stage.id });
  }

  const result = simulateMatchCollection(
    () => db.prepare(`SELECT * FROM matches WHERE stage_id = ? AND status != 'finished'
      ORDER BY matchday ASC, created_at ASC`).all(stage.id),
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
function simulateTournament(tournamentId, { actorId, maxStages = 20 } = {}) {
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId);
  if (!tournament) throw httpError(404, 'Tournament not found');

  const stages = db
    .prepare('SELECT * FROM stages WHERE tournament_id = ? ORDER BY sequence_order ASC')
    .all(tournamentId);
  if (!stages.length) throw httpError(400, 'Create at least one stage before simulating');

  const stageResults = [];
  for (const stage of stages.slice(0, maxStages)) {
    stageResults.push(simulateStage(stage.id, { actorId }));
  }

  const updatedTournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId);
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
