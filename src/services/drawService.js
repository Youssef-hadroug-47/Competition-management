const { query, withTransaction, now, parseJson } = require('../db');
const { AsyncLocalStorage } = require('async_hooks');

const transactionContext = new AsyncLocalStorage();
const run = (sql, values = [], client) => (client || transactionContext.getStore() || { query }).query(sql.replace(/\?/g, (_, offset, text) => `$${(text.slice(0, offset).match(/\?/g) || []).length + 1}`), values);
const one = async (sql, values = [], client) => (await run(sql, values, client)).rows[0] || null;
const many = async (sql, values = [], client) => (await run(sql, values, client)).rows;
const { id } = require('../utils/ids');
const { httpError } = require('../middleware/error');
const { defaultStageSettings } = require('./mappers');

function shuffle(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function roundRobinPairs(teamIds, legs = 1) {
  const teams = [...teamIds];
  if (teams.length < 2) return [];
  if (teams.length % 2 === 1) teams.push(null);

  const n = teams.length;
  const roundsPerLeg = n - 1;
  const half = n / 2;
  const fixtures = [];

  for (let leg = 0; leg < legs; leg += 1) {
    const rotation = [...teams];
    for (let round = 0; round < roundsPerLeg; round += 1) {
      const matchday = leg * roundsPerLeg + round + 1;
      for (let i = 0; i < half; i += 1) {
        const home = rotation[i];
        const away = rotation[n - 1 - i];
        if (!home || !away) continue;
        const swap = leg === 1;
        fixtures.push({
          matchday,
          home: swap ? away : home,
          away: swap ? home : away,
        });
      }
      const fixed = rotation[0];
      const rest = rotation.slice(1);
      rest.unshift(rest.pop());
      rotation.splice(0, rotation.length, fixed, ...rest);
    }
  }
  return fixtures;
}

function knockoutRounds(teamCount) {
  const size = 2 ** Math.ceil(Math.log2(Math.max(teamCount, 2)));
  const names = {
    2: ['Final'],
    4: ['Semi-finals', 'Final'],
    8: ['Quarter-finals', 'Semi-finals', 'Final'],
    16: ['Round of 16', 'Quarter-finals', 'Semi-finals', 'Final'],
    32: ['Round of 32', 'Round of 16', 'Quarter-finals', 'Semi-finals', 'Final'],
  };
  return names[size] || Array.from({ length: Math.log2(size) }, (_, i) => `Round ${i + 1}`);
}

async function insertMatch({ tournamentId, stageId, groupId, matchday, homeId, awayId }) {
  const matchId = id();
  await run(
    `INSERT INTO matches (
      id, tournament_id, stage_id, group_id, matchday,
      home_participant_team_id, away_participant_team_id, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`
  , [matchId, tournamentId, stageId, groupId, matchday, homeId, awayId, now()]);
  return matchId;
}

async function getPreviousStageOpponentPairs(stage, participantIds) {
  if (stage.sequence_order <= 1 || !participantIds.length) return new Set();

  const sourceStages = await many(
    `SELECT DISTINCT source_stage_id
     FROM stage_promotions
     WHERE target_stage_id = ?`
  , [stage.id]);
  if (!sourceStages.length) return new Set();

  const placeholders = sourceStages.map(() => '?').join(', ');
  const matches = await many(
    `SELECT home_participant_team_id, away_participant_team_id
     FROM matches
     WHERE stage_id IN (${placeholders})
       AND home_participant_team_id IS NOT NULL
       AND away_participant_team_id IS NOT NULL`
  , [...sourceStages.map((source) => source.source_stage_id)]);
  const participants = new Set(participantIds);
  const pairs = new Set();
  for (const match of matches) {
    if (!participants.has(match.home_participant_team_id) || !participants.has(match.away_participant_team_id)) {
      continue;
    }
    const pair = [match.home_participant_team_id, match.away_participant_team_id].sort().join(':');
    pairs.add(pair);
  }
  return pairs;
}

function pairKnockoutParticipants(participants, forbiddenPairs) {
  const shuffled = shuffle(participants);
  const pair = (remaining) => {
    if (!remaining.length) return [];
    const home = remaining[0];
    const candidates = shuffle(remaining.slice(1)).filter((away) => {
      const key = [home.id, away.id].sort().join(':');
      return !forbiddenPairs.has(key);
    });

    for (const away of candidates) {
      const rest = remaining.filter((participant) => participant !== home && participant !== away);
      const result = pair(rest);
      if (result) return [[home, away], ...result];
    }

    // An unpaired team can receive a bye when the draw has an odd number of
    // participants, but only after all valid pairings have been attempted.
    if (remaining.length % 2 === 1) {
      const result = pair(remaining.slice(1));
      if (result) return [[home], ...result];
    }
    return null;
  };

  return pair(shuffled);
}

/* ----------------------------------------------------------------------
 * Stage linking helpers — promotions are no longer computed on the fly at
 * draw time. A group's promotion_rules can send different rank ranges to
 * different, arbitrary target stages (not necessarily sequence_order + 1),
 * so the decision is made once, when the source stage finishes, and
 * persisted in stage_promotions (see finalizeLeagueStage / the knockout
 * final-round branch of advanceKnockoutStage). A stage's draw pool is
 * whatever stage_promotions currently says is targeting it.
 * -------------------------------------------------------------------- */

// Keep transaction-scoped queries in AsyncLocalStorage so nested draw helpers
// share the checked-out PostgreSQL client.
async function runInTransaction(fn) {
  return withTransaction(async (client) => transactionContext.run(client, () => fn(client)));
}

async function insertStagePromotion(insert, { tournamentId, sourceStageId, targetStageId, participantTeamId, viaRank, rankPosition }) {
  await run(
    `INSERT INTO stage_promotions
      (id, tournament_id, source_stage_id, target_stage_id, participant_team_id, via_rank, rank_position, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id(), tournamentId, sourceStageId, targetStageId, participantTeamId, viaRank ? 1 : 0, rankPosition ?? null, now()]
  );
}

// Everyone currently promoted INTO `stage`, regardless of which stage(s)
// fed them there.
async function getIncomingParticipants(stage) {
  return (await many(
      `SELECT DISTINCT pt.* FROM stage_promotions sp
       JOIN participant_teams pt ON pt.id = sp.participant_team_id
       WHERE sp.target_stage_id = ?`
    , [stage.id]));
}

// Which stages currently have promotions feeding `stage` — used for
// "finish stage X first" style error messages, since a stage can now be
// fed by more than one source.
async function getFeederStageSequenceOrders(stage) {
  return (await many(
      `SELECT DISTINCT s.sequence_order AS seq FROM stage_promotions sp
       JOIN stages s ON s.id = sp.source_stage_id
       WHERE sp.target_stage_id = ?
       ORDER BY seq ASC`
    , [stage.id])).map((r) => r.seq);
}

async function isStageComplete(stage) {
  const row = await one(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'finished' THEN 1 ELSE 0 END) AS done
       FROM matches WHERE stage_id = ?`
    , [stage.id]);
  return Number(row.total) > 0 && Number(row.total) === Number(row.done || 0);
}

function groupByMatchday(matches) {
  const map = new Map();
  for (const m of matches) {
    if (!map.has(m.matchday)) map.set(m.matchday, []);
    map.get(m.matchday).push(m);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

// Resolves the winner of a knockout tie (one match, or several legs sharing
// the same matchday). Aggregates regulation goals across every leg, then
// uses extra time and penalties only from the final ordered leg if the
// aggregate is level. This models extra time/penalties as a one-match
// decider rather than adding them from every leg.
function resolveTieWinner(tieMatches) {
  if (!tieMatches.length) return null;
  const teamX = tieMatches[0].home_participant_team_id;
  const teamIds = new Set();
  let scoreX = 0;
  let scoreY = 0;
  let etX = 0;
  let etY = 0;

  for (const m of tieMatches) {
    if (m.home_score == null || m.away_score == null) return null;
    teamIds.add(m.home_participant_team_id);
    teamIds.add(m.away_participant_team_id);
    if (teamIds.size > 2) return null;
    const homeIsX = m.home_participant_team_id === teamX;
    scoreX += homeIsX ? m.home_score : m.away_score;
    scoreY += homeIsX ? m.away_score : m.home_score;
  }

  if (teamIds.size !== 2) return null;
  const teamY = [...teamIds].find((teamId) => teamId !== teamX);

  if (scoreX !== scoreY) return scoreX > scoreY ? teamX : teamY;
  const decider = tieMatches[tieMatches.length - 1];
  const deciderHomeIsX = decider.home_participant_team_id === teamX;
  if (decider.extra_time_home != null && decider.extra_time_away != null) {
    etX = deciderHomeIsX ? decider.extra_time_home : decider.extra_time_away;
    etY = deciderHomeIsX ? decider.extra_time_away : decider.extra_time_home;
    if (etX !== etY) return etX > etY ? teamX : teamY;
  }
  let penalties = null;
  if (decider.penalties_home != null && decider.penalties_away != null) {
    penalties = {
      x: deciderHomeIsX ? decider.penalties_home : decider.penalties_away,
      y: deciderHomeIsX ? decider.penalties_away : decider.penalties_home,
    };
  }
  if (penalties && penalties.x !== penalties.y) {
    return penalties.x > penalties.y ? teamX : teamY;
  }
  return null;
}

// --- Tiebreakers for league stages -----------------------------------

// One query for every tied team's card totals, instead of one query per
// team per comparison. Returns raw rows; callers build a Map keyed by
// participant_team_id.
async function getCardsForTeams(teams) {
  if (!teams.length) return [];
  const teamIds = teams.map((t) => t.id);
  const placeholders = teamIds.map(() => '?').join(',');
  return await many(
      `SELECT participant_team_id, SUM(yellow_cards) yellows, SUM(red_cards) reds
       FROM participant_players
       WHERE participant_team_id IN (${placeholders})
       GROUP BY participant_team_id`
    , [...teamIds]);
}

// Builds a mini-league sub-table for a set of tied teams: finds all
// finished matches between them within the given group, and computes
// points/GF/GA from those matches only (their "mini-league"). Used to
// resolve head-to-head among 3+ teams tied on points, since pairwise
// comparison isn't guaranteed transitive (A > B > C > A is possible).
async function computeMiniLeagueStats(teams, groupId) {
  const teamIds = teams.map((t) => t.id);
  const stats = {};
  for (const t of teams) stats[t.id] = { pts: 0, gf: 0, ga: 0 };
  if (teamIds.length < 2) return stats;

  const placeholders = teamIds.map(() => '?').join(',');
  const matches = await many(
      `SELECT home_participant_team_id, away_participant_team_id, home_score, away_score
       FROM matches WHERE group_id = ? AND status = 'finished'
       AND home_participant_team_id IN (${placeholders})
       AND away_participant_team_id IN (${placeholders})`
    , [groupId, ...teamIds, ...teamIds]);

  for (const m of matches) {
    const hId = m.home_participant_team_id;
    const aId = m.away_participant_team_id;
    const hs = m.home_score || 0;
    const as = m.away_score || 0;
    if (stats[hId]) { stats[hId].gf += hs; stats[hId].ga += as; }
    if (stats[aId]) { stats[aId].gf += as; stats[aId].ga += hs; }
    if (hs > as && stats[hId]) stats[hId].pts += 3;
    else if (as > hs && stats[aId]) stats[aId].pts += 3;
    else {
      if (stats[hId]) stats[hId].pts += 1;
      if (stats[aId]) stats[aId].pts += 1;
    }
  }
  return stats;
}

// Sorts `teams` descending by a numeric composite key (array of numbers,
// compared lexicographically) and groups consecutive equal-key teams into
// buckets. This is the shared building block for every tiebreaker
// criterion below — sort first, THEN split, so teams tied on a value that
// aren't adjacent in the input still end up in the same bucket.
function bucketByComposite(teams, keyFn) {
  const sorted = [...teams].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    for (let i = 0; i < ka.length; i += 1) {
      if (kb[i] !== ka[i]) return kb[i] - ka[i];
    }
    return 0;
  });

  const sameKey = (x, y) => {
    const kx = keyFn(x);
    const ky = keyFn(y);
    return kx.every((v, i) => v === ky[i]);
  };

  const buckets = [];
  let current = [];
  for (const t of sorted) {
    if (!current.length || sameKey(t, current[0])) current.push(t);
    else { buckets.push(current); current = [t]; }
  }
  if (current.length) buckets.push(current);
  return buckets;
}

// Splits `teams` into tied buckets for one tiebreaker criterion. Each
// bucket is itself an array of teams; a bucket of length 1 is fully
// resolved, a bucket of length > 1 is still tied on this criterion and
// needs the next one in the chain.
async function splitIntoBuckets(teams, type, groupId) {
  switch (type) {
    case 'points':
      return bucketByComposite(teams, (t) => [t.points || 0]);

    case 'goal_difference':
      return bucketByComposite(teams, (t) => [t.goal_difference || 0]);

    case 'goals_for':
      return bucketByComposite(teams, (t) => [t.goals_for || 0]);

    case 'sportsmanlike':
      // Fewer cards is better, so negate to reuse the descending sort.
      return bucketByComposite(teams, (t) => [-(t.red_cards || 0), -(t.yellow_cards || 0)]);

    case 'head_to_head': {
      // Scoped to just the currently-tied bucket, and only matches these
      // teams played against each other — a fresh mini-league per bucket,
      // not the group's overall table.
      const stats = await computeMiniLeagueStats(teams, groupId);
      return bucketByComposite(teams, (t) => {
        const s = stats[t.id] || { pts: 0, gf: 0, ga: 0 };
        return [s.pts, s.gf - s.ga, s.gf];
      });
    }

    case 'draw': {
      // Deterministic, never leaves teams tied — every bucket is a
      // singleton, ordered by id.
      const sorted = [...teams].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return sorted.map((t) => [t]);
    }

    default:
      throw httpError(500, `Unknown tiebreaker type: ${type}`);
  }
}

// Resolves ties: applies each tiebreaker in priority order, only
// recursing into a tiebreaker's sub-buckets for teams still tied after
// it. If every configured tiebreaker is exhausted and teams are still
// tied, falls back to a deterministic id sort so the result is never
// ambiguous even if the caller forgot to configure a 'draw' tiebreaker.
async function sortTeamsWithTiebreakers(teams, sortedTiebreakers, idx, groupId) {
  if (teams.length <= 1) return teams;
  if (idx >= sortedTiebreakers.length) {
    return [...teams].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  const buckets = await splitIntoBuckets(teams, sortedTiebreakers[idx].type, groupId);
  const result = [];
  for (const bucket of buckets) {
    if (bucket.length === 1) result.push(...bucket);
    else result.push(...await sortTeamsWithTiebreakers(bucket, sortedTiebreakers, idx + 1, groupId));
  }
  return result;
}

// Ranks a single group's teams using the stage's tiebreaker chain. Rank 1
// (group winner) is index 0. Points/goals_for/goals_against are read from
// the stored participant_teams columns (not recomputed from matches) so
// any manual adjustment — deductions, forfeits, bonus points — is
// respected; only goal_difference is derived, and only cards/head-to-head
// pull from other tables.
async function rankGroupTeams(groupId, tiebreakers) {
  const sortedTbs = [...tiebreakers].sort((a, b) => a.priority - b.priority);
  const teams = await many(
    `SELECT DISTINCT pt.*
     FROM participant_teams pt
     LEFT JOIN matches m
       ON m.group_id = ?
      AND (m.home_participant_team_id = pt.id OR m.away_participant_team_id = pt.id)
     WHERE pt.group_id = ?
        OR m.id IS NOT NULL`
  , [groupId, groupId]);
  if (!teams.length) return teams;

  const cardRows = await getCardsForTeams(teams);
  const cards = new Map(
    cardRows.map((c) => [c.participant_team_id, { yellow_cards: c.yellows || 0, red_cards: c.reds || 0 }])
  );

  for (const team of teams) {
    const c = cards.get(team.id) || { yellow_cards: 0, red_cards: 0 };
    team.yellow_cards = c.yellow_cards;
    team.red_cards = c.red_cards;
    team.goal_difference = (team.goals_for || 0) - (team.goals_against || 0);
  }

  return await sortTeamsWithTiebreakers(teams, sortedTbs, 0, groupId);
}

async function setStageStatus(stageId, status) {
  if (!stageId || !status) return false;

  if (!["finished"].includes(status)) return false;
  
  await run("UPDATE STAGES SET status = ? WHERE id = ?", [status, stageId]);
  return true;
}

// Computes and persists promotions out of a finished league stage.
// Each group's promotion_rules is an array of {from, to, stage, rank}
// ranges over that group's own final standings (1-based, inclusive):
//   - rank falsy: every team in [from, to] is promoted straight to `stage`.
//   - rank true: teams in [from, to] become candidates for `stage` instead
//     of being auto-promoted — they're pooled with every other rank:true
//     candidate from every group in this stage (regardless of which target
//     stage they're bound for), sorted together, and only the top
//     settings.advancingTeamsFromRanking of that pool actually promote.
//     This matches the old "best third-placed teams" behaviour, just with
//     an explicit per-range target stage instead of an implicit next one.
// Returns null (and does nothing) if the stage isn't actually finished yet.
// Safe to call repeatedly/idempotently — it replaces this stage's rows in
// stage_promotions each time it successfully runs.
async function finalizeLeagueStage(stage) {
  if (!stage || stage.type !== 'league') return null;
  if (!await isStageComplete(stage)) return null;

  const settings = parseJson(stage.settings, defaultStageSettings('league'));
  const defaultTbs = defaultStageSettings('league').tiebreakers;
  const tiebreakers =
    settings.tiebreakers && settings.tiebreakers.length ? settings.tiebreakers : defaultTbs;
  const defaultAdvanceFromRanking = defaultStageSettings('league').advancingTeamsFromRanking;
  const nbrAdvanceFromRanking = settings.advancingTeamsFromRanking ?? defaultAdvanceFromRanking ?? 0;

  const groups = await many('SELECT * FROM groups WHERE stage_id = ? ORDER BY sequence_order ASC, name ASC', [stage.id]);
  if (!groups.length) {
    return { promoted: 0, direct: 0, viaRank: 0, note: 'Stage has no groups configured — nothing to promote.' };
  }

  const directPromotions = []; // { participantTeamId, targetStageId }
  const rankingCandidates = []; // { team, targetStageId }

  for (const grp of groups) {
    const ranked = await rankGroupTeams(grp.id, tiebreakers);
    const rules = parseJson(grp.promotion_rules, []);
    for (const rule of rules) {
      if (!rule || !rule.stage) continue;
      const from = Math.max(1, Number(rule.from) || 1);
      const to = Math.min(ranked.length, Number(rule.to) || 0);
      if (to < from) continue;
      const slice = ranked.slice(from - 1, to);
      if (rule.rank) {
        for (const team of slice) rankingCandidates.push({ team, targetStageId: rule.stage });
      } else {
        for (const team of slice) directPromotions.push({ participantTeamId: team.id, targetStageId: rule.stage });
      }
    }
  }

  // Rank-based candidates come from different groups, so they never
  // played each other — head_to_head can't apply across groups. Sort the
  // pool on points/GD/GF only, with a deterministic id fallback.
  const crossGroupTiebreakers = [
    { type: 'points', priority: 1 },
    { type: 'goal_difference', priority: 2 },
    { type: 'goals_for', priority: 3 },
    { type: 'draw', priority: 4 },
  ];
  const candidateTeams = rankingCandidates.map((c) => c.team);
  const sortedCandidateTeams = await sortTeamsWithTiebreakers(candidateTeams, crossGroupTiebreakers, 0, null);
  const orderIndex = new Map(sortedCandidateTeams.map((t, i) => [t.id, i]));
  rankingCandidates.sort((a, b) => orderIndex.get(a.team.id) - orderIndex.get(b.team.id));

  const rankedPromotions = rankingCandidates.slice(0, nbrAdvanceFromRanking).map((c, index) => ({
    participantTeamId: c.team.id,
    targetStageId: c.targetStageId,
    rankPosition: index + 1,
  }));

  await runInTransaction(async () => {
    await run('DELETE FROM stage_promotions WHERE source_stage_id = ?', [stage.id]);
    for (const p of directPromotions) {
      await insertStagePromotion(null, {
        tournamentId: stage.tournament_id,
        sourceStageId: stage.id,
        targetStageId: p.targetStageId,
        participantTeamId: p.participantTeamId,
        viaRank: false,
      });
    }
    for (const p of rankedPromotions) {
      await insertStagePromotion(null, {
        tournamentId: stage.tournament_id,
        sourceStageId: stage.id,
        targetStageId: p.targetStageId,
        participantTeamId: p.participantTeamId,
        viaRank: true,
        rankPosition: p.rankPosition,
      });
    }
    await setStageStatus(stage.id, "finished");
  });

  

  return {
    promoted: directPromotions.length + rankedPromotions.length,
    direct: directPromotions.length,
    viaRank: rankedPromotions.length,
  };
}

async function drawLeagueStage(tournament, stage, groups, participants) {
  if (!groups.length) throw httpError(400, 'Create groups for this league stage before drawing');
  const shuffled = shuffle(participants);
  const assignments = shuffled.map((pt, index) => ({
    ...pt,
    group_id: groups[index % groups.length].id,
  }));

  const settings = parseJson(stage.settings, defaultStageSettings('league'));
  const legs = Math.max(1, Number(settings.headToHeadMatches) || 1);

  const byGroup = new Map();
  for (const pt of assignments) {
    if (!byGroup.has(pt.group_id)) byGroup.set(pt.group_id, []);
    byGroup.get(pt.group_id).push(pt.id);
  }

  const created = [];
  await runInTransaction(async () => {
    for (const pt of assignments) await run(`UPDATE participant_teams SET group_id = ?, status = 'drawn' WHERE id = ?`, [pt.group_id, pt.id]);

    for (const group of groups) {
      const ids = byGroup.get(group.id) || [];
      const fixtures = roundRobinPairs(ids, legs);
      for (const fx of fixtures) {
        created.push(
          await insertMatch({
            tournamentId: tournament.id,
            stageId: stage.id,
            groupId: group.id,
            matchday: fx.matchday,
            homeId: fx.home,
            awayId: fx.away,
          })
        );
      }
    }
  });

  return { assigned: assignments.length, matchesCreated: created.length };
}

// Draws only the FIRST round of a knockout stage. Every round group for the
// bracket is created up front (so the shape of the bracket is known), but
// matches for rounds after the first are only generated once the round
// feeding them is complete — see advanceKnockoutStage().
async function drawKnockoutStage(tournament, stage, groups, participants) {
  const settings = parseJson(stage.settings, defaultStageSettings('knockout'));
  const legs = Math.max(1, Number(settings.headToHeadMatches) || 1);
  const forbiddenPairs = await getPreviousStageOpponentPairs(stage, participants.map((participant) => participant.id));
  const pairs = pairKnockoutParticipants(participants, forbiddenPairs);
  if (!pairs) {
    throw httpError(
      409,
      'Unable to draw this knockout stage without repeating a previous-stage matchup. Adjust the qualified teams or allow rematches.'
    );
  }

  let roundGroups = groups;
  let firstRound;
  const created = [];

  await runInTransaction(async () => {
    if (!roundGroups.length) {
      const names = knockoutRounds(participants.length);
      roundGroups = [];
      for (const [index, name] of names.entries()) {
        const gid = id();
        await run(`INSERT INTO rounds (id, stage_id, name, sequence_order) VALUES (?, ?, ?, ?)`, [gid, stage.id, name, index + 1]);
        roundGroups.push({ id: gid, name, sequence_order: index + 1 });
      }
    }

    firstRound = [...roundGroups].sort((a, b) => a.sequence_order - b.sequence_order)[0];
    for (const [index, pair] of pairs.entries()) {
      if (pair.length < 2) return;
      for (let leg = 0; leg < legs; leg += 1) {
        const home = leg === 0 ? pair[0] : pair[1];
        const away = leg === 0 ? pair[1] : pair[0];
        created.push(
          await insertMatch({
            tournamentId: tournament.id,
            stageId: stage.id,
            groupId: firstRound.id,
            matchday: index + 1,
            homeId: home.id,
            awayId: away.id,
          })
        );
      }
    }

    for (const pt of participants) await run(`UPDATE participant_teams SET status = 'drawn' WHERE id = ?`, [pt.id]);
  });

  return { assigned: participants.length, matchesCreated: created.length, firstRound: firstRound.name };
}

async function runDraw({ tournamentId, stageId }) {
  const tournament = await one('SELECT * FROM tournaments WHERE id = ?', [tournamentId]);
  if (!tournament) throw httpError(404, 'Tournament not found');

  let stage;
  if (stageId) {
    stage = await one('SELECT * FROM stages WHERE id = ? AND tournament_id = ?', [stageId, tournamentId]);
    if (!stage) throw httpError(404, 'Stage not found');
  } else {
    const stages = await many('SELECT * FROM stages WHERE tournament_id = ? ORDER BY sequence_order ASC', [tournamentId]);
    if (!stages.length) throw httpError(400, 'Create at least one stage before drawing');
    stage = stages[0];
  }

  const existingMatches = await many('SELECT id, status FROM matches WHERE tournament_id = ? AND stage_id = ?', [tournamentId, stage.id]);
  const startedMatch = existingMatches.find((match) => !['scheduled', 'postponed', 'cancelled'].includes(match.status));
  if (startedMatch) {
    throw httpError(409, 'This stage has started. Use Reset stage before creating a new draw.');
  }

  // Stage linking: a stage only draws from teams that have already been
  // promoted into it (see stage_promotions), not the whole tournament
  // roster. Promotions are decided once, when a feeding stage finishes —
  // see finalizeLeagueStage and advanceKnockoutStage — so by draw time this
  // is just a lookup, not a computation.
  let participants;
  if (stage.sequence_order > 1) {
    participants = await getIncomingParticipants(stage);
    if (participants.length < 2) {
      const feederSeqs = await getFeederStageSequenceOrders(stage);
      const message = feederSeqs.length
        ? `Only ${participants.length} team(s) have been promoted into stage #${stage.sequence_order} so far from stage(s) ${feederSeqs.join(', ')}. Make sure those stages have finished.`
        : `No teams have been promoted into stage #${stage.sequence_order} yet. Finish the stage(s) whose promotion_rules target it first.`;
      throw httpError(409, message);
    }

  } else {
    participants = await many('SELECT * FROM participant_teams WHERE tournament_id = ?', [tournamentId]);
    const number_of_teams = (await one('SELECT * from tournaments WHERE id = ?', [tournamentId])).number_of_teams;
    if (participants.length != number_of_teams) {
      throw httpError(400, `add ${number_of_teams - participants.length} teams to run draw`);
    }
  }

  const groups = await many(`SELECT * FROM ${stage.type === 'league' ? 'groups' : 'rounds'} WHERE stage_id = ? ORDER BY sequence_order ASC, name ASC`, [stage.id]);

  if (existingMatches.length) {
    await run('DELETE FROM matches WHERE tournament_id = ? AND stage_id = ?', [tournamentId, stage.id]);
  }

  const result =
    stage.type === 'knockout'
      ? await drawKnockoutStage(tournament, stage, groups, participants)
      : await drawLeagueStage(tournament, stage, groups, participants);

  await run(
    `UPDATE tournaments SET status = CASE
      WHEN status IN ('draft', 'registration') THEN 'draw_complete'
      ELSE status
    END, updated_at = ? WHERE id = ?`
  , [now(), tournamentId]);

  return {
    tournamentId,
    stageId: stage.id,
    stageType: stage.type,
    sequenceOrder: stage.sequence_order,
    promotedFromStages: stage.sequence_order > 1 ? await getFeederStageSequenceOrders(stage) : [],
    ...result,
  };
}

async function resetStage({ tournamentId, stageId, scopeStageIds = null }) {
  const stage = await one('SELECT * FROM stages WHERE id = ? AND tournament_id = ?', [stageId, tournamentId]);
  if (!stage) throw httpError(404, 'Stage not found');

  const stageIds = new Set(scopeStageIds?.length ? scopeStageIds : [stage.id]);
  if (scopeStageIds?.length) {
    if (stageIds.has(stage.id)) {
      throw httpError(400, 'Scoped downstream reset cannot include the corrected source stage');
    }
    const placeholders = [...stageIds].map(() => '?').join(', ');
    const validStages = (await many(
      `SELECT id FROM stages WHERE tournament_id = ? AND id IN (${placeholders})`
    , [tournamentId, ...stageIds])).map(({ id }) => id);
    if (validStages.length !== stageIds.size) throw httpError(400, 'Invalid affected stage list');
  } else {
    const pending = [stage.id];
    while (pending.length) {
      const sourceStageId = pending.shift();
      const targets = await many(
        'SELECT DISTINCT target_stage_id FROM stage_promotions WHERE source_stage_id = ?'
      , [sourceStageId]);
      targets.forEach(({ target_stage_id: targetStageId }) => {
        if (!stageIds.has(targetStageId)) {
          stageIds.add(targetStageId);
          pending.push(targetStageId);
        }
      });
    }
  }

  const ids = [...stageIds];
  const downstreamIds = ids.filter((id) => id !== stage.id);
  const placeholders = ids.map(() => '?').join(', ');
  const matches = await many(
    `SELECT * FROM matches WHERE tournament_id = ? AND stage_id IN (${placeholders})`
  , [tournamentId, ...ids]);
  const stageGroupIds = (await many(
    `SELECT id FROM groups WHERE stage_id IN (${placeholders})`
  , [...ids])).map(({ id }) => id);
  const assignedTeamIds = new Set(
    matches.flatMap((match) => [
      match.home_participant_team_id,
      match.away_participant_team_id,
    ]).filter(Boolean)
  );
  if (stageGroupIds.length) {
    const groupPlaceholders = stageGroupIds.map(() => '?').join(', ');
    (await many(
      `SELECT id FROM participant_teams WHERE tournament_id = ? AND group_id IN (${groupPlaceholders})`
    , [tournamentId, ...stageGroupIds])).forEach(({ id }) => assignedTeamIds.add(id));
  }

  await runInTransaction(async () => {
    for (const match of matches) {
      if (match.status === 'finished') {
        const stageRow = await one('SELECT type, settings FROM stages WHERE id = ?', [match.stage_id]);
        if (stageRow?.type === 'league') {
          const settings = parseJson(stageRow.settings, defaultStageSettings('league'));
          const home = await one('SELECT * FROM participant_teams WHERE id = ?', [match.home_participant_team_id]);
          const away = await one('SELECT * FROM participant_teams WHERE id = ?', [match.away_participant_team_id]);
          if (home && away) {
            const homeScore = Number(match.home_score || 0);
            const awayScore = Number(match.away_score || 0);
            const homeWin = homeScore > awayScore;
            const draw = homeScore === awayScore;
            const pts = settings.points || { win: 3, draw: 1, loss: 0 };
            const reverse = async (team, wins, draws, losses, goalsFor, goalsAgainst, points) => run(
              `UPDATE participant_teams SET played = GREATEST(0, played - ?), won = GREATEST(0, won - ?),
                drawn = GREATEST(0, drawn - ?), lost = GREATEST(0, lost - ?),
                goals_for = GREATEST(0, goals_for - ?), goals_against = GREATEST(0, goals_against - ?),
                points = GREATEST(0, points - ?) WHERE id = ?`
            , [1, wins, draws, losses, goalsFor, goalsAgainst, points, team.id]);
            reverse(home, homeWin ? 1 : 0, draw ? 1 : 0, homeWin ? 0 : 1, homeScore, awayScore, homeWin ? pts.win : draw ? pts.draw : pts.loss);
            reverse(away, homeWin ? 0 : 1, draw ? 1 : 0, homeWin ? 1 : 0, awayScore, homeScore, homeWin ? pts.loss : draw ? pts.draw : pts.win);
          }
        }
      }
      const events = await many('SELECT type, card, player_id, payload FROM match_events WHERE match_id = ?', [match.id]);
      for (const event of events) {
        if (!event.player_id) return;
        const payload = parseJson(event.payload, {});
        const column = event.type === 'goal' && !payload.ownGoal
          ? 'goals'
          : event.type === 'assist' && !payload.skipped
            ? 'assists'
            : event.type === 'card'
              ? (event.card === 'red' ? 'red_cards' : 'yellow_cards')
              : null;
        if (column) await run(`UPDATE participant_players SET ${column} = GREATEST(0, ${column} - 1) WHERE id = ?`, [event.player_id]);
      }
    }
    // Promotions into the selected stage are still valid inputs for a redraw.
    // Only generated results from this stage and its downstream stages must be
    // discarded.
    await run(`DELETE FROM stage_promotions WHERE source_stage_id IN (${placeholders})`, [...ids]);
    if (downstreamIds.length && !scopeStageIds?.length) {
      const downstreamPlaceholders = downstreamIds.map(() => '?').join(', ');
      await run(`DELETE FROM stage_promotions WHERE target_stage_id IN (${downstreamPlaceholders})`, [...downstreamIds]);
    }
    await run(`DELETE FROM matches WHERE tournament_id = ? AND stage_id IN (${placeholders})`, [tournamentId, ...ids]);
    await run(`UPDATE stages SET status = NULL WHERE tournament_id = ? AND id IN (${placeholders})`, [tournamentId, ...ids]);
    if (assignedTeamIds.size && !scopeStageIds?.length) {
      const teamIds = [...assignedTeamIds];
      const teamPlaceholders = teamIds.map(() => '?').join(', ');
      await run(
        `UPDATE participant_teams
         SET group_id = NULL, status = 'registered', winner = false
         WHERE tournament_id = ? AND id IN (${teamPlaceholders})`
      , [tournamentId, ...teamIds]);
    }
  });
  return {
    resetStages: ids.length,
    deletedMatches: matches.length,
    resetParticipantTeams: scopeStageIds?.length ? 0 : assignedTeamIds.size,
  };
}

// Called whenever a knockout match is finished. Walks the stage's rounds in
// order; if a round just completed and the next round hasn't been generated
// yet, it pairs up the winners and creates that round's matches. If the
// final round just completed, crowns the champion (and, if this was the
// tournament's last stage, marks the tournament completed).
async function advanceKnockoutStage(stageId) {
  const stage = await one('SELECT * FROM stages WHERE id = ?', [stageId]);
  if (!stage || stage.type !== 'knockout') return null;

  const settings = parseJson(stage.settings, defaultStageSettings('knockout'));
  const legs = Math.max(1, Number(settings.headToHeadMatches) || 1);
  const groups = await many('SELECT * FROM rounds WHERE stage_id = ? ORDER BY sequence_order ASC', [stage.id]);
  if (!groups.length) return null;

  for (let i = 0; i < groups.length; i += 1) {
    const round = groups[i];
    const roundMatches = await many('SELECT * FROM matches WHERE group_id = ? ORDER BY matchday ASC, created_at ASC', [round.id]);
    if (!roundMatches.length) return null; // this round hasn't been drawn yet
    if (!roundMatches.every((m) => m.status === 'finished')) return null; // still in progress

    const ties = groupByMatchday(roundMatches);
    const resolved = [];
    for (const [, tieMatches] of ties) {
      const winnerId = resolveTieWinner(tieMatches);
      if (!winnerId) {
        return { pending: true, round: round.name, reason: 'Tie is level — enter extra time or penalties to resolve it' };
      }
      const loserId =
        tieMatches[0].home_participant_team_id === winnerId
          ? tieMatches[0].away_participant_team_id
          : tieMatches[0].home_participant_team_id;
      resolved.push({ winnerId, loserId });
    }
    const isFinalRound = i === groups.length - 1;
    if (isFinalRound) {
      // Knockout stages still promote their winner(s) straight to the next
      // stage by sequence_order (no promotion_rules on rounds yet).
      const nextStage = await one('SELECT * FROM stages WHERE tournament_id = ? AND sequence_order = ?', [stage.tournament_id, stage.sequence_order + 1]);
      const maxSeq = (await one('SELECT MAX(sequence_order) AS m FROM stages WHERE tournament_id = ?', [stage.tournament_id])).m;
      const isTournamentComplete = stage.sequence_order === maxSeq;

      await runInTransaction(async () => {
        for (const { winnerId, loserId } of resolved) {
          await run(`UPDATE participant_teams SET status = 'champion' WHERE id = ?`, [winnerId]);
          await run(`UPDATE participant_teams SET status = 'eliminated' WHERE id = ?`, [loserId]);
        }

        if (nextStage) {
          await run('DELETE FROM stage_promotions WHERE source_stage_id = ?', [stage.id]);
          for (const { winnerId } of resolved) {
            await insertStagePromotion(null, {
              tournamentId: stage.tournament_id,
              sourceStageId: stage.id,
              targetStageId: nextStage.id,
              participantTeamId: winnerId,
              viaRank: false,
            });
          }
        }

        if (isTournamentComplete) {
          await run(`UPDATE tournaments SET status = 'completed', updated_at = ? WHERE id = ?`, [now(),
            stage.tournament_id]);
        }
      });

      await setStageStatus(stage.id, "finished");

      return { finalized: true, round: round.name, champion: resolved[0]?.winnerId || null };
    }

    const nextRound = groups[i + 1];
    const nextRoundMatches = await one('SELECT COUNT(*) AS c FROM matches WHERE group_id = ?', [nextRound.id]);
    if (nextRoundMatches.c > 0) continue; // already generated — keep checking later rounds

    const winners = resolved.map((r) => r.winnerId);
    const created = [];
    await runInTransaction(async () => {
      for (const { loserId } of resolved) {
        await run(`UPDATE participant_teams SET status = 'eliminated' WHERE id = ?`, [loserId]);
      }

      for (let p = 0; p < winners.length; p += 2) {
        const home = winners[p];
        const away = winners[p + 1];
        if (!home) continue;
        if (!away) {
          // Odd team out gets a bye straight into the next round.
          await run(`UPDATE participant_teams SET status = 'drawn' WHERE id = ?`, [home]);
          continue;
        }
        for (let leg = 0; leg < legs; leg += 1) {
          const h = leg === 0 ? home : away;
          const a = leg === 0 ? away : home;
          created.push(
            await insertMatch({
              tournamentId: stage.tournament_id,
              stageId: stage.id,
              groupId: nextRound.id,
              matchday: Math.floor(p / 2) + 1,
              homeId: h,
              awayId: a,
            })
          );
        }
      }
    });
    return { round: nextRound.name, matchesCreated: created.length, advanced: winners.length };
  }

  return null;
}

// Call this whenever a match's status is set to 'finished'. It figures out
// the right thing to do for the match's stage type:
//   - league: if every match in the stage is now finished, computes and
//     persists promotions (finalizeLeagueStage).
//   - knockout: advances the bracket one step (generates the next round,
//     or — on the final round — crowns the champion and persists
//     promotions into the next stage). May need to be called again after
//     each subsequent round finishes.
// Returns null if the stage isn't in a state that needs anything done yet.
async function finalizeStageIfComplete(stageId) {
  const stage = await one('SELECT * FROM stages WHERE id = ?', [stageId]);
  if (!stage) return null;
  return stage.type === 'league' ? await finalizeLeagueStage(stage) : await advanceKnockoutStage(stage.id);
}

async function stagePromotionSnapshot(stageId) {
  return await many(
    `SELECT target_stage_id, participant_team_id, via_rank, rank_position
     FROM stage_promotions WHERE source_stage_id = ?
     ORDER BY target_stage_id, participant_team_id, via_rank, rank_position`
  , [stageId]);
}

async function downstreamImpact(stageId, beforePromotions, afterPromotions) {
  const before = JSON.stringify(beforePromotions);
  const after = JSON.stringify(afterPromotions);
  const changed = before !== after;
  const sourceStage = await one('SELECT sequence_order FROM stages WHERE id = ?', [stageId]);
  const candidateTargetIds = [...new Set([
    ...beforePromotions.map((row) => row.target_stage_id),
    ...afterPromotions.map((row) => row.target_stage_id),
  ])];
  const targetIds = [];
  for (const targetId of candidateTargetIds) {
    const target = await one('SELECT sequence_order FROM stages WHERE id = ?', [targetId]);
    if (target && Number(target.sequence_order) === Number(sourceStage?.sequence_order) + 1) targetIds.push(targetId);
  }
  const affected = [];
  const pending = [...targetIds];
  const seen = new Set();
  while (pending.length) {
    const currentId = pending.shift();
    if (seen.has(currentId)) continue;
    seen.add(currentId);
    const stage = await one('SELECT id, type, sequence_order FROM stages WHERE id = ?', [currentId]);
    if (!stage) continue;
    const matches = await one(
      'SELECT COUNT(*) AS total, SUM(CASE WHEN status = \'finished\' THEN 1 ELSE 0 END) AS finished FROM matches WHERE stage_id = ?'
    , [currentId]);
    const startedMatch = await one(
      `SELECT 1 FROM matches
       WHERE stage_id = ? AND status NOT IN ('scheduled', 'postponed', 'cancelled')
       LIMIT 1`
    , [currentId]);
    const hasDraw = Number(matches?.total || 0) > 0;
    affected.push({
      ...stage,
      matchCount: Number(matches?.total || 0),
      finishedMatchCount: Number(matches?.finished || 0),
      hasDraw,
      started: Boolean(startedMatch),
      action: !hasDraw ? 'none' : startedMatch ? 'reset' : 'redraw',
      incomingParticipants: afterPromotions
        .filter((row) => row.target_stage_id === currentId)
        .map((row) => row.participant_team_id),
    });
  }
  return {
    stageId,
    changed,
    resetRequired: changed && affected.length > 0,
    affectedStages: affected,
    beforePromotions,
    afterPromotions,
  };
}

async function reconcileStageOutputs(stageId) {
  const beforePromotions = await stagePromotionSnapshot(stageId);
  const result = await finalizeStageIfComplete(stageId);
  const afterPromotions = await stagePromotionSnapshot(stageId);
  return {
    ...(await downstreamImpact(stageId, beforePromotions, afterPromotions)),
    stageResult: result,
  };
}

module.exports = {
  runDraw,
  resetStage,
  roundRobinPairs,
  advanceKnockoutStage,
  finalizeLeagueStage,
  finalizeStageIfComplete,
  reconcileStageOutputs,
  getIncomingParticipants,
  isStageComplete,
  rankGroupTeams,
};
