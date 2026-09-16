const { db, now, parseJson } = require('../db');
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

function insertMatch({ tournamentId, stageId, groupId, matchday, homeId, awayId }) {
  const matchId = id();
  db.prepare(
    `INSERT INTO matches (
      id, tournament_id, stage_id, group_id, matchday,
      home_participant_team_id, away_participant_team_id, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`
  ).run(matchId, tournamentId, stageId, groupId, matchday, homeId, awayId, now());
  return matchId;
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

// node:sqlite's DatabaseSync has no better-sqlite3-style db.transaction()
// helper, so wrap the BEGIN/COMMIT/ROLLBACK by hand. Not reentrant — don't
// call this from inside another runInTransaction.
function runInTransaction(fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function insertStagePromotion(insert, { tournamentId, sourceStageId, targetStageId, participantTeamId, viaRank, rankPosition }) {
  insert.run(id(), tournamentId, sourceStageId, targetStageId, participantTeamId, viaRank ? 1 : 0, rankPosition ?? null, now());
}

// Everyone currently promoted INTO `stage`, regardless of which stage(s)
// fed them there.
function getIncomingParticipants(stage) {
  return db
    .prepare(
      `SELECT DISTINCT pt.* FROM stage_promotions sp
       JOIN participant_teams pt ON pt.id = sp.participant_team_id
       WHERE sp.target_stage_id = ?`
    )
    .all(stage.id);
}

// Which stages currently have promotions feeding `stage` — used for
// "finish stage X first" style error messages, since a stage can now be
// fed by more than one source.
function getFeederStageSequenceOrders(stage) {
  return db
    .prepare(
      `SELECT DISTINCT s.sequence_order AS seq FROM stage_promotions sp
       JOIN stages s ON s.id = sp.source_stage_id
       WHERE sp.target_stage_id = ?
       ORDER BY seq ASC`
    )
    .all(stage.id)
    .map((r) => r.seq);
}

function isStageComplete(stage) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'finished' THEN 1 ELSE 0 END) AS done
       FROM matches WHERE stage_id = ?`
    )
    .get(stage.id);
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
// the same matchday). Aggregates normal-time goals across legs, then falls
// back to extra time and penalties if the tie is level. Returns null if the
// tie can't be resolved yet (still needs a result, extra time or penalties).
function resolveTieWinner(tieMatches) {
  if (!tieMatches.length) return null;
  const teamX = tieMatches[0].home_participant_team_id;
  let scoreX = 0;
  let scoreY = 0;
  let etX = 0;
  let etY = 0;
  let penX = 0;
  let penY = 0;
  let hasEt = false;
  let hasPen = false;

  for (const m of tieMatches) {
    if (m.home_score == null || m.away_score == null) return null;
    const homeIsX = m.home_participant_team_id === teamX;
    scoreX += homeIsX ? m.home_score : m.away_score;
    scoreY += homeIsX ? m.away_score : m.home_score;
    if (m.extra_time_home != null && m.extra_time_away != null) {
      hasEt = true;
      etX += homeIsX ? m.extra_time_home : m.extra_time_away;
      etY += homeIsX ? m.extra_time_away : m.extra_time_home;
    }
    if (m.penalties_home != null && m.penalties_away != null) {
      hasPen = true;
      penX = homeIsX ? m.penalties_home : m.penalties_away;
      penY = homeIsX ? m.penalties_away : m.penalties_home;
    }
  }

  const teamY = tieMatches[0].home_participant_team_id === teamX
    ? tieMatches[0].away_participant_team_id
    : tieMatches[0].home_participant_team_id;

  if (scoreX !== scoreY) return scoreX > scoreY ? teamX : teamY;
  if (hasEt && etX !== etY) return etX > etY ? teamX : teamY;
  if (hasPen && penX !== penY) return penX > penY ? teamX : teamY;
  return null;
}

// --- Tiebreakers for league stages -----------------------------------

// One query for every tied team's card totals, instead of one query per
// team per comparison. Returns raw rows; callers build a Map keyed by
// participant_team_id.
function getCardsForTeams(teams) {
  if (!teams.length) return [];
  const teamIds = teams.map((t) => t.id);
  const placeholders = teamIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT participant_team_id, SUM(yellow_cards) yellows, SUM(red_cards) reds
       FROM participant_players
       WHERE participant_team_id IN (${placeholders})
       GROUP BY participant_team_id`
    )
    .all(...teamIds);
}

// Builds a mini-league sub-table for a set of tied teams: finds all
// finished matches between them within the given group, and computes
// points/GF/GA from those matches only (their "mini-league"). Used to
// resolve head-to-head among 3+ teams tied on points, since pairwise
// comparison isn't guaranteed transitive (A > B > C > A is possible).
function computeMiniLeagueStats(teams, groupId) {
  const teamIds = teams.map((t) => t.id);
  const stats = {};
  for (const t of teams) stats[t.id] = { pts: 0, gf: 0, ga: 0 };
  if (teamIds.length < 2) return stats;

  const placeholders = teamIds.map(() => '?').join(',');
  const matches = db
    .prepare(
      `SELECT home_participant_team_id, away_participant_team_id, home_score, away_score
       FROM matches WHERE group_id = ? AND status = 'finished'
       AND home_participant_team_id IN (${placeholders})
       AND away_participant_team_id IN (${placeholders})`
    )
    .all(groupId, ...teamIds, ...teamIds);

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
function splitIntoBuckets(teams, type, groupId) {
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
      const stats = computeMiniLeagueStats(teams, groupId);
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
function sortTeamsWithTiebreakers(teams, sortedTiebreakers, idx, groupId) {
  if (teams.length <= 1) return teams;
  if (idx >= sortedTiebreakers.length) {
    return [...teams].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  const buckets = splitIntoBuckets(teams, sortedTiebreakers[idx].type, groupId);
  const result = [];
  for (const bucket of buckets) {
    if (bucket.length === 1) result.push(...bucket);
    else result.push(...sortTeamsWithTiebreakers(bucket, sortedTiebreakers, idx + 1, groupId));
  }
  return result;
}

// Ranks a single group's teams using the stage's tiebreaker chain. Rank 1
// (group winner) is index 0. Points/goals_for/goals_against are read from
// the stored participant_teams columns (not recomputed from matches) so
// any manual adjustment — deductions, forfeits, bonus points — is
// respected; only goal_difference is derived, and only cards/head-to-head
// pull from other tables.
function rankGroupTeams(group, tiebreakers) {
  const sortedTbs = [...tiebreakers].sort((a, b) => a.priority - b.priority);
  const teams = db.prepare('SELECT * FROM participant_teams WHERE group_id = ?').all(group.id);
  if (!teams.length) return teams;

  const cardRows = getCardsForTeams(teams);
  const cards = new Map(
    cardRows.map((c) => [c.participant_team_id, { yellow_cards: c.yellows || 0, red_cards: c.reds || 0 }])
  );

  for (const team of teams) {
    const c = cards.get(team.id) || { yellow_cards: 0, red_cards: 0 };
    team.yellow_cards = c.yellow_cards;
    team.red_cards = c.red_cards;
    team.goal_difference = (team.goals_for || 0) - (team.goals_against || 0);
  }

  return sortTeamsWithTiebreakers(teams, sortedTbs, 0, group.id);
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
function finalizeLeagueStage(stage) {
  if (!stage || stage.type !== 'league') return null;
  if (!isStageComplete(stage)) return null;

  const settings = parseJson(stage.settings, defaultStageSettings('league'));
  const defaultTbs = defaultStageSettings('league').tiebreakers;
  const tiebreakers =
    settings.tiebreakers && settings.tiebreakers.length ? settings.tiebreakers : defaultTbs;
  const defaultAdvanceFromRanking = defaultStageSettings('league').advancingTeamsFromRanking;
  const nbrAdvanceFromRanking = settings.advancingTeamsFromRanking ?? defaultAdvanceFromRanking ?? 0;

  const groups = db
    .prepare('SELECT * FROM groups WHERE stage_id = ? ORDER BY sequence_order ASC, name ASC')
    .all(stage.id);
  if (!groups.length) {
    return { promoted: 0, direct: 0, viaRank: 0, note: 'Stage has no groups configured — nothing to promote.' };
  }

  const directPromotions = []; // { participantTeamId, targetStageId }
  const rankingCandidates = []; // { team, targetStageId }

  for (const grp of groups) {
    const ranked = rankGroupTeams(grp, tiebreakers);
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
  const sortedCandidateTeams = sortTeamsWithTiebreakers(candidateTeams, crossGroupTiebreakers, 0, null);
  const orderIndex = new Map(sortedCandidateTeams.map((t, i) => [t.id, i]));
  rankingCandidates.sort((a, b) => orderIndex.get(a.team.id) - orderIndex.get(b.team.id));

  const rankedPromotions = rankingCandidates.slice(0, nbrAdvanceFromRanking).map((c, index) => ({
    participantTeamId: c.team.id,
    targetStageId: c.targetStageId,
    rankPosition: index + 1,
  }));

  const del = db.prepare('DELETE FROM stage_promotions WHERE source_stage_id = ?');
  const insert = db.prepare(
    `INSERT INTO stage_promotions (
      id, tournament_id, source_stage_id, target_stage_id, participant_team_id, via_rank, rank_position, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  runInTransaction(() => {
    del.run(stage.id);
    for (const p of directPromotions) {
      insertStagePromotion(insert, {
        tournamentId: stage.tournament_id,
        sourceStageId: stage.id,
        targetStageId: p.targetStageId,
        participantTeamId: p.participantTeamId,
        viaRank: false,
      });
    }
    for (const p of rankedPromotions) {
      insertStagePromotion(insert, {
        tournamentId: stage.tournament_id,
        sourceStageId: stage.id,
        targetStageId: p.targetStageId,
        participantTeamId: p.participantTeamId,
        viaRank: true,
        rankPosition: p.rankPosition,
      });
    }
  });

  return {
    promoted: directPromotions.length + rankedPromotions.length,
    direct: directPromotions.length,
    viaRank: rankedPromotions.length,
  };
}

function drawLeagueStage(tournament, stage, groups, participants) {
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
  runInTransaction(() => {
    const update = db.prepare(`UPDATE participant_teams SET group_id = ?, status = 'drawn' WHERE id = ?`);
    for (const pt of assignments) update.run(pt.group_id, pt.id);

    for (const group of groups) {
      const ids = byGroup.get(group.id) || [];
      const fixtures = roundRobinPairs(ids, legs);
      for (const fx of fixtures) {
        created.push(
          insertMatch({
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
function drawKnockoutStage(tournament, stage, groups, participants) {
  const shuffled = shuffle(participants);
  const settings = parseJson(stage.settings, defaultStageSettings('knockout'));
  const legs = Math.max(1, Number(settings.headToHeadMatches) || 1);

  let roundGroups = groups;
  let firstRound;
  const created = [];

  runInTransaction(() => {
    if (!roundGroups.length) {
      const names = knockoutRounds(shuffled.length);
      const insertGroup = db.prepare(
        `INSERT INTO rounds (id, stage_id, name, sequence_order) VALUES (?, ?, ?, ?)`
      );
      roundGroups = names.map((name, index) => {
        const gid = id();
        insertGroup.run(gid, stage.id, name, index + 1);
        return { id: gid, name, sequence_order: index + 1 };
      });
    }

    firstRound = [...roundGroups].sort((a, b) => a.sequence_order - b.sequence_order)[0];
    const pairs = [];
    for (let i = 0; i < shuffled.length; i += 2) {
      const home = shuffled[i];
      const away = shuffled[i + 1];
      if (!away) continue;
      pairs.push([home, away]);
    }

    pairs.forEach((pair, index) => {
      for (let leg = 0; leg < legs; leg += 1) {
        const home = leg === 0 ? pair[0] : pair[1];
        const away = leg === 0 ? pair[1] : pair[0];
        created.push(
          insertMatch({
            tournamentId: tournament.id,
            stageId: stage.id,
            groupId: firstRound.id,
            matchday: index + 1,
            homeId: home.id,
            awayId: away.id,
          })
        );
      }
    });

    const mark = db.prepare(`UPDATE participant_teams SET status = 'drawn' WHERE id = ?`);
    for (const pt of shuffled) mark.run(pt.id);
  });

  return { assigned: shuffled.length, matchesCreated: created.length, firstRound: firstRound.name };
}

function runDraw({ tournamentId, stageId }) {
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId);
  if (!tournament) throw httpError(404, 'Tournament not found');

  let stage;
  if (stageId) {
    stage = db.prepare('SELECT * FROM stages WHERE id = ? AND tournament_id = ?').get(stageId, tournamentId);
    if (!stage) throw httpError(404, 'Stage not found');
  } else {
    const stages = db
      .prepare('SELECT * FROM stages WHERE tournament_id = ? ORDER BY sequence_order ASC')
      .all(tournamentId);
    if (!stages.length) throw httpError(400, 'Create at least one stage before drawing');
    stage = stages[0];
  }

  const existingMatches = db
    .prepare('SELECT COUNT(*) AS c FROM matches WHERE tournament_id = ? AND stage_id = ?')
    .get(tournamentId, stage.id);
  if (existingMatches.c > 0) {
    throw httpError(409, 'A draw already exists for this stage. Delete its matches first to redraw.');
  }

  // Stage linking: a stage only draws from teams that have already been
  // promoted into it (see stage_promotions), not the whole tournament
  // roster. Promotions are decided once, when a feeding stage finishes —
  // see finalizeLeagueStage and advanceKnockoutStage — so by draw time this
  // is just a lookup, not a computation.
  let participants;
  if (stage.sequence_order > 1) {
    participants = getIncomingParticipants(stage);
    if (participants.length < 2) {
      const feederSeqs = getFeederStageSequenceOrders(stage);
      const message = feederSeqs.length
        ? `Only ${participants.length} team(s) have been promoted into stage #${stage.sequence_order} so far from stage(s) ${feederSeqs.join(', ')}. Make sure those stages have finished.`
        : `No teams have been promoted into stage #${stage.sequence_order} yet. Finish the stage(s) whose promotion_rules target it first.`;
      throw httpError(409, message);
    }
  } else {
    participants = db.prepare('SELECT * FROM participant_teams WHERE tournament_id = ?').all(tournamentId);
    const number_of_teams = db.prepare('SELECT * from tournaments WHERE id = ?').get(tournamentId).number_of_teams;
    if (participants.length != number_of_teams) {
      throw httpError(400, `add ${number_of_teams - participants.length} teams to run draw`);
    }
  }

  const groups =  db
    .prepare(`SELECT * FROM ${ stage.type === "league" ? 'groups' : 'rounds'} WHERE stage_id = ? ORDER BY sequence_order ASC, name ASC`)
    .all(stage.id) ; 


  const result =
    stage.type === 'knockout'
      ? drawKnockoutStage(tournament, stage, groups, participants)
      : drawLeagueStage(tournament, stage, groups, participants);

  db.prepare(
    `UPDATE tournaments SET status = CASE
      WHEN status IN ('draft', 'registration') THEN 'draw_complete'
      ELSE status
    END, updated_at = ? WHERE id = ?`
  ).run(now(), tournamentId);

  return {
    tournamentId,
    stageId: stage.id,
    stageType: stage.type,
    sequenceOrder: stage.sequence_order,
    promotedFromStages: stage.sequence_order > 1 ? getFeederStageSequenceOrders(stage) : [],
    ...result,
  };
}

// Called whenever a knockout match is finished. Walks the stage's rounds in
// order; if a round just completed and the next round hasn't been generated
// yet, it pairs up the winners and creates that round's matches. If the
// final round just completed, crowns the champion (and, if this was the
// tournament's last stage, marks the tournament completed).
function advanceKnockoutStage(stageId) {
  const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(stageId);
  if (!stage || stage.type !== 'knockout') return null;

  const settings = parseJson(stage.settings, defaultStageSettings('knockout'));
  const legs = Math.max(1, Number(settings.headToHeadMatches) || 1);
  const groups = db
    .prepare('SELECT * FROM rounds WHERE stage_id = ? ORDER BY sequence_order ASC')
    .all(stage.id);
  if (!groups.length) return null;

  for (let i = 0; i < groups.length; i += 1) {
    const round = groups[i];
    const roundMatches = db
      .prepare('SELECT * FROM matches WHERE group_id = ? ORDER BY matchday ASC, created_at ASC')
      .all(round.id);
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
      const nextStage = db
        .prepare('SELECT * FROM stages WHERE tournament_id = ? AND sequence_order = ?')
        .get(stage.tournament_id, stage.sequence_order + 1);
      const maxSeq = db
        .prepare('SELECT MAX(sequence_order) AS m FROM stages WHERE tournament_id = ?')
        .get(stage.tournament_id).m;
      const isTournamentComplete = stage.sequence_order === maxSeq;

      runInTransaction(() => {
        for (const { winnerId, loserId } of resolved) {
          db.prepare(`UPDATE participant_teams SET status = 'champion' WHERE id = ?`).run(winnerId);
          db.prepare(`UPDATE participant_teams SET status = 'eliminated' WHERE id = ?`).run(loserId);
        }

        if (nextStage) {
          db.prepare('DELETE FROM stage_promotions WHERE source_stage_id = ?').run(stage.id);
          const insert = db.prepare(
            `INSERT INTO stage_promotions (
              id, tournament_id, source_stage_id, target_stage_id, participant_team_id, via_rank, rank_position, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          );
          for (const { winnerId } of resolved) {
            insertStagePromotion(insert, {
              tournamentId: stage.tournament_id,
              sourceStageId: stage.id,
              targetStageId: nextStage.id,
              participantTeamId: winnerId,
              viaRank: false,
            });
          }
        }

        if (isTournamentComplete) {
          db.prepare(`UPDATE tournaments SET status = 'completed', updated_at = ? WHERE id = ?`).run(
            now(),
            stage.tournament_id
          );
        }
      });

      return { finalized: true, round: round.name, champion: resolved[0]?.winnerId || null };
    }

    const nextRound = groups[i + 1];
    const nextRoundMatches = db.prepare('SELECT COUNT(*) AS c FROM matches WHERE group_id = ?').get(nextRound.id);
    if (nextRoundMatches.c > 0) continue; // already generated — keep checking later rounds

    const winners = resolved.map((r) => r.winnerId);
    const created = [];
    runInTransaction(() => {
      for (const { loserId } of resolved) {
        db.prepare(`UPDATE participant_teams SET status = 'eliminated' WHERE id = ?`).run(loserId);
      }

      for (let p = 0; p < winners.length; p += 2) {
        const home = winners[p];
        const away = winners[p + 1];
        if (!home) continue;
        if (!away) {
          // Odd team out gets a bye straight into the next round.
          db.prepare(`UPDATE participant_teams SET status = 'drawn' WHERE id = ?`).run(home);
          continue;
        }
        for (let leg = 0; leg < legs; leg += 1) {
          const h = leg === 0 ? home : away;
          const a = leg === 0 ? away : home;
          created.push(
            insertMatch({
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
function finalizeStageIfComplete(stageId) {
  const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(stageId);
  if (!stage) return null;
  return stage.type === 'league' ? finalizeLeagueStage(stage) : advanceKnockoutStage(stage.id);
}

module.exports = {
  runDraw,
  roundRobinPairs,
  advanceKnockoutStage,
  finalizeLeagueStage,
  finalizeStageIfComplete,
  getIncomingParticipants,
  isStageComplete,
};
