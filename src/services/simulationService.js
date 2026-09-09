const { db, parseJson } = require('../db');
const { httpError } = require('../middleware/error');
const map = require('./mappers');
const { runDraw, advanceKnockoutStage } = require('./drawService');
const { finishMatchRecord } = require('./matchService');

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

  let { match, advance } = finishMatchRecord({
    matchRow: row,
    homeScore,
    awayScore,
    extraTimeHome: row.extra_time_home,
    extraTimeAway: row.extra_time_away,
    penaltiesHome: row.penalties_home,
    penaltiesAway: row.penalties_away,
    refereeId: actorId,
  });

  let et = null;
  
  if (stage?.type === 'knockout' && homeScore == awayScore && settings.extraTime) {
    et = randomScoreline(home?.seed, away?.seed);
    db.prepare('UPDATE matches SET extra_time_home = ?, extra_time_away = ? WHERE id = ?').run(
      Math.min(2, et.homeScore),
      Math.min(2, et.awayScore),
      match.id
    );
    advance = advanceKnockoutStage(stage.id);
    match = db.prepare('SELECT * FROM matches WHERE id = ?').get(match.id);
  }

  if (stage?.type === 'knockout' && ( (et && et.awayScore == et.homeScore) || (!et && homeScore == awayScore)) && settings.penalties) {
    const pens = randomPenalties();
    db.prepare('UPDATE matches SET penalties_home = ?, penalties_away = ? WHERE id = ?').run(
      pens.home,
      pens.away,
      match.id
    );
    advance = advanceKnockoutStage(stage.id);
    match = db.prepare('SELECT * FROM matches WHERE id = ?').get(match.id);
  }

  return { match: map.match(match), advance };
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

  let matchesSimulated = 0;
  let lastAdvance = null;
  for (let round = 0; round < maxRounds; round += 1) {
    const pending = db
      .prepare(`SELECT * FROM matches WHERE stage_id = ? AND status != 'finished' ORDER BY matchday ASC, created_at ASC`)
      .all(stage.id);
    if (!pending.length) break;
    for (const m of pending) {
      const result = simulateMatch(m.id, { actorId });
      if (!result.skipped) matchesSimulated += 1;
      if (result.advance) lastAdvance = result.advance;
    }
  }

  return {
    stageId: stage.id,
    stageType: stage.type,
    sequenceOrder: stage.sequence_order,
    drew: Boolean(drawResult),
    matchesSimulated,
    advance: lastAdvance,
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
  simulateStage,
  simulateTournament,
  randomScoreline,
};
