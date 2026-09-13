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
 * Stage linking helpers — a stage with sequence_order > 1 is "fed" by the
 * stage immediately before it (sequence_order - 1). Its draw pool is
 * restricted to the teams that stage's promotion rules produced, instead
 * of every team registered in the tournament.
 * -------------------------------------------------------------------- */

function getPreviousStage(tournamentId, stage) {
  if (!stage || stage.sequence_order <= 1) return null;
  return db
    .prepare('SELECT * FROM stages WHERE tournament_id = ? AND sequence_order = ?')
    .get(tournamentId, stage.sequence_order - 1);
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

function getCardsForTeam(participantTeamId) {
  const players = db
    .prepare('SELECT yellow_cards, red_cards FROM participant_players WHERE participant_team_id = ?')
    .all(participantTeamId);
  let reds = 0;
  let yellows = 0;
  for (const p of players) {
    reds += Number(p.red_cards || 0);
    yellows += Number(p.yellow_cards || 0);
  }
  return { reds, yellows };
}

function getHeadToHeadMatches(aId, bId, stageId) {
  return db
    .prepare(
      `SELECT * FROM matches WHERE stage_id = ? AND (
        (home_participant_team_id = ? AND away_participant_team_id = ?) OR
        (home_participant_team_id = ? AND away_participant_team_id = ?)
      ) AND status = 'finished'`
    )
    .all(stageId, aId, bId, bId, aId);
}

function compareHeadToHead(a, b, stageId, awayGoalsPrivileged) {
  const matches = getHeadToHeadMatches(a.id, b.id, stageId);
  if (!matches.length) return 0;
  let aPts = 0, bPts = 0;
  let aGf = 0, bGf = 0;
  let aAg = 0, bAg = 0;
  for (const m of matches) {
    const aIsHome = m.home_participant_team_id === a.id;
    const aScore = aIsHome ? (m.home_score || 0) : (m.away_score || 0);
    const bScore = aIsHome ? (m.away_score || 0) : (m.home_score || 0);
    aGf += aScore;
    bGf += bScore;
    if (aIsHome) { aAg += 0; bAg += bScore; }
    else { aAg += aScore; bAg += 0; }
    if (aScore > bScore) aPts += 3;
    else if (bScore > aScore) bPts += 3;
    else { aPts += 1; bPts += 1; }
  }
  if (aPts !== bPts) return bPts - aPts;
  const aGd = aGf - bGf;
  if (aGd !== 0) return (aGd > 0 ? -1 : 1);
  if (aGf !== bGf) return bGf - aGf;
  if (awayGoalsPrivileged && aAg !== bAg) return bAg - aAg;
  return 0;
}

function compareTeams(a, b, allTeams, tiebreakers, stageId) {
  for (const tb of [...tiebreakers].sort((x, y) => x.priority - y.priority)) {
    let result = 0;
    switch (tb.type) {
      case 'goal_difference': {
        const gdA = (a.goals_for || 0) - (a.goals_against || 0);
        const gdB = (b.goals_for || 0) - (b.goals_against || 0);
        if (gdA !== gdB) result = gdB - gdA;
        break;
      }
      case 'goals_for': {
        if ((a.goals_for || 0) !== (b.goals_for || 0)) result = (b.goals_for || 0) - (a.goals_for || 0);
        break;
      }
      case 'head_to_head': {
        const h2h = compareHeadToHead(a, b, stageId, tb.awayGoalsPrivileged !== false);
        if (h2h !== 0) result = h2h;
        break;
      }
      case 'sportsmanlike': {
        const ca = getCardsForTeam(a.id);
        const cb = getCardsForTeam(b.id);
        if (ca.reds !== cb.reds) result = ca.reds - cb.reds;
        else if (ca.yellows !== cb.yellows) result = ca.yellows - cb.yellows;
        break;
      }
      case 'draw': {
        result = a.id < b.id ? -1 : 1;
        break;
      }
    }
    if (result !== 0) return result;
  }
  return 0;
}

// Builds a mini-league sub-table for a set of tied teams: finds all
// finished matches between them within the given stage, computes points
// GD and GF from those matches only, then returns them sorted by those
// mini-league stats (points → GD → GF).
// Computes each team's points/GF/GA from only the matches they played
// against each other within this bucket (their "mini-league").
function computeMiniLeagueStats(teams, stageId) {
  const teamIds = teams.map((t) => t.id);
  const placeholders = teamIds.map(() => '?').join(',');
  const matches = db
    .prepare(
      `SELECT * FROM matches WHERE stage_id = ? AND status = 'finished'
       AND home_participant_team_id IN (${placeholders})
       AND away_participant_team_id IN (${placeholders})`
    )
    .all(stageId, ...teamIds, ...teamIds);

  const stats = {};
  for (const t of teams) {
    stats[t.id] = { pts: 0, gf: 0, ga: 0 };
  }
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

function sortByMiniLeague(teams, stageId) {
  const stats = computeMiniLeagueStats(teams, stageId);
  return [...teams].sort((a, b) => {
    const sa = stats[a.id], sb = stats[b.id];
    if (!sa && !sb) return 0;
    if (!sa) return 1;
    if (!sb) return -1;
    if (sb.pts !== sa.pts) return sb.pts - sa.pts;
    const gdA = sa.gf - sa.ga, gdB = sb.gf - sb.ga;
    if (gdB !== gdA) return gdB - gdA;
    if (sb.gf !== sa.gf) return sb.gf - sa.gf;
    return 0;
  });
}

// Resolves ties: groups teams by their accumulated score (points + all
// tiebreaker criteria recursively), resolves each group using mini-league
// when head_to_head is the primary tiebreaker, then applies remaining
// tiebreakers. Returns the fully sorted array.
function sortTeamsWithTiebreakers(teams, tiebreakers, stageId) {
  const h2hPrimary = tiebreakers.length && tiebreakers.sort((x, y) => x.priority - y.priority)[0].type === 'head_to_head';

  // First pass: sort by points descending
  const byPoints = [...teams].sort((a, b) => (b.points || 0) - (a.points || 0));

  // Split into buckets of equal points
  const buckets = [];
  let current = [];
  for (const t of byPoints) {
    if (!current.length || (t.points || 0) === (current[0].points || 0)) {
      current.push(t);
    } else {
      buckets.push(current);
      current = [t];
    }
  }
  if (current.length) buckets.push(current);

  // Sort each bucket (teams with same points)
  const result = [];
  for (const bucket of buckets) {
    let sorted;
    if (bucket.length <= 2 || !h2hPrimary) {
      // Simple pairwise comparison works for 1-2 teams or non-h2h primary
      sorted = [...bucket].sort((a, b) => compareTeams(a, b, bucket, tiebreakers, stageId));
    } else {
      // 3+ teams tied on points with head_to_head first:
      // First pass: use mini-league to get the relative ordering
      sorted = sortByMiniLeague(bucket, stageId);
      // Second pass: resolve any remaining ties within mini-league
      // using the full tiebreaker chain (excluding head_to_head to avoid
      // double-counting). Teams only carry forward into the same sub-bucket
      // here if they were ACTUALLY still tied after the mini-league (equal
      // mini-league points/GD/GF) — grouping by overall tournament points
      // would be wrong, since every team in `bucket` already shares those.
      const remainingTbs = tiebreakers.filter((tb) => tb.type !== 'head_to_head');
      if (remainingTbs.length) {
        const mlStats = computeMiniLeagueStats(bucket, stageId);
        const miniLeagueKey = (t) => {
          const s = mlStats[t.id] || { pts: 0, gf: 0, ga: 0 };
          return `${s.pts}|${s.gf - s.ga}|${s.gf}`;
        };
        const mlBuckets = [];
        let mlCurrent = [];
        for (const t of sorted) {
          if (!mlCurrent.length || miniLeagueKey(t) === miniLeagueKey(mlCurrent[0])) {
            mlCurrent.push(t);
          } else {
            mlBuckets.push(mlCurrent);
            mlCurrent = [t];
          }
        }
        if (mlCurrent.length) mlBuckets.push(mlCurrent);
        sorted = mlBuckets.flatMap((b) =>
          (b.length > 1 ? [...b].sort((a, b) => compareTeams(a, b, b, remainingTbs, stageId)) : b)
        );
      }
    }
    result.push(...sorted);
  }
  return result;
}



function getLeaguePromotedTeams(stage) {
  if (stage.type !== "league") return null;
  const settings = parseJson(stage.settings, defaultStageSettings('league'));
  const defaultTbs = defaultStageSettings('league').tiebreakers;
  const tiebreakers =
    settings.tiebreakers && settings.tiebreakers.length ? settings.tiebreakers : defaultTbs;
  const defaultAdvanceFromRanking = defaultStageSettings('league').advancingTeamsFromRanking;
  const nbrAdvanceFromRanking = settings.advancingTeamsFromRanking ?? defaultAdvanceFromRanking ?? 0;

  const groups = db
    .prepare('SELECT * FROM groups WHERE stage_id = ? ORDER BY sequence_order ASC, name ASC')
    .all(stage.id);
  const sourceGroups = groups.length ? groups : [{ id: null }];
  const promoted = [];
  // Candidates for the pooled "ranking group" (e.g. best third-placed teams
  // across all groups, as in the Euros) — gathered from every group here,
  // then sorted together and trimmed to nbrAdvanceFromRanking below.
  const rankingPool = [];
  for (const g of sourceGroups) {
    const teams = g.id
      ? db.prepare('SELECT * FROM participant_teams WHERE group_id = ?').all(g.id)
      : db.prepare('SELECT * FROM participant_teams WHERE tournament_id = ? AND group_id IS NULL').all(
          stage.tournament_id
        );
    teams.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      return compareTeams(a, b, teams, tiebreakers, stage.id);
    });
    // g.advancing_teams is the raw DB column (snake_case) — only real groups
    // (g.id set) carry it; the synthetic "no groups configured" fallback
    // promotes every team, same as before.
    const n = g.id == null ? teams.length : Math.min(g.advancing_teams, teams.length);
    promoted.push(...teams.slice(0, n));
    const nbrTeamsToRanking = g.id == null ? 0 : (g.advancing_teams_to_ranking ?? 0);
    // Ranking-eligible teams are the ones placed right after the teams that
    // advance automatically — i.e. starting at index n, not n + 1.
    rankingPool.push(...teams.slice(n, n + nbrTeamsToRanking));
  }

  rankingPool.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    return compareTeams(a, b, rankingPool, tiebreakers, stage.id);
  });

  promoted.push(...rankingPool.slice(0, nbrAdvanceFromRanking));

  return promoted;
}

function getKnockoutPromotedTeams(stage) {
  const rounds = db
    .prepare('SELECT * FROM rounds WHERE stage_id = ? ORDER BY sequence_order DESC')
    .all(stage.id);
  if (!rounds.length) return [];
  const finalRound = rounds[0];
  const matches = db
    .prepare('SELECT * FROM matches WHERE group_id = ? ORDER BY matchday ASC, created_at ASC')
    .all(finalRound.id);
  const ties = groupByMatchday(matches);
  const winners = [];
  for (const [, tieMatches] of ties) {
    const winnerId = resolveTieWinner(tieMatches);
    if (winnerId) winners.push(db.prepare('SELECT * FROM participant_teams WHERE id = ?').get(winnerId));
  }
  return winners;
}

// Returns the participant_teams promoted out of `previousStage`: for a
// league stage, each group's own advancing_teams/advancing_teams_to_ranking
// plus the stage's advancingTeamsFromRanking setting; for a knockout stage,
// the winners of its final round.
function getPromotedParticipants(previousStage) {
  return previousStage.type === 'league'
    ? getLeaguePromotedTeams(previousStage)
    : getKnockoutPromotedTeams(previousStage);
}

function drawLeagueStage(tournament, stage, groups, participants) {
  if (!groups.length) throw httpError(400, 'Create groups for this league stage before drawing');
  const shuffled = shuffle(participants);
  const assignments = shuffled.map((pt, index) => ({
    ...pt,
    group_id: groups[index % groups.length].id,
  }));

  const update = db.prepare(
    `UPDATE participant_teams SET group_id = ?, status = 'drawn' WHERE id = ?`
  );
  for (const pt of assignments) update.run(pt.group_id, pt.id);

  const settings = parseJson(stage.settings, defaultStageSettings('league'));
  const legs = Math.max(1, Number(settings.headToHeadMatches) || 1);

  const byGroup = new Map();
  for (const pt of assignments) {
    if (!byGroup.has(pt.group_id)) byGroup.set(pt.group_id, []);
    byGroup.get(pt.group_id).push(pt.id);
  }

  const created = [];
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

  const firstRound = [...roundGroups].sort((a, b) => a.sequence_order - b.sequence_order)[0];
  const pairs = [];
  for (let i = 0; i < shuffled.length; i += 2) {
    const home = shuffled[i];
    const away = shuffled[i + 1];
    if (!away) continue;
    pairs.push([home, away]);
  }

  const created = [];
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

  // Stage linking: a stage only draws from the teams its predecessor
  // promoted, not the whole tournament roster.
  const previousStage = getPreviousStage(tournamentId, stage);
  let participants;
  if (previousStage) {
    if (!isStageComplete(previousStage)) {
      throw httpError(
        409,
        `Finish every match in stage #${previousStage.sequence_order} (${previousStage.type}) before drawing stage #${stage.sequence_order} — only its promoted teams feed this stage.`
      );
    }
    participants = getPromotedParticipants(previousStage);
    if (participants.length < 2) {
      throw httpError(
        400,
        `Stage #${previousStage.sequence_order} did not produce enough promoted teams (found ${participants.length}) to draw stage #${stage.sequence_order}.`
      );
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
    promotedFromStage: previousStage ? previousStage.sequence_order : null,
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
      for (const { winnerId, loserId } of resolved) {
        db.prepare(`UPDATE participant_teams SET status = 'champion' WHERE id = ?`).run(winnerId);
        db.prepare(`UPDATE participant_teams SET status = 'eliminated' WHERE id = ?`).run(loserId);
      }
      const maxSeq = db
        .prepare('SELECT MAX(sequence_order) AS m FROM stages WHERE tournament_id = ?')
        .get(stage.tournament_id).m;
      if (stage.sequence_order === maxSeq) {
        db.prepare(`UPDATE tournaments SET status = 'completed', updated_at = ? WHERE id = ?`).run(
          now(),
          stage.tournament_id
        );
      }
      return { finalized: true, round: round.name, champion: resolved[0]?.winnerId || null };
    }

    const nextRound = groups[i + 1];
    const nextRoundMatches = db.prepare('SELECT COUNT(*) AS c FROM matches WHERE group_id = ?').get(nextRound.id);
    if (nextRoundMatches.c > 0) continue; // already generated — keep checking later rounds

    for (const { loserId } of resolved) {
      db.prepare(`UPDATE participant_teams SET status = 'eliminated' WHERE id = ?`).run(loserId);
    }

    const winners = resolved.map((r) => r.winnerId);
    const created = [];
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
    return { round: nextRound.name, matchesCreated: created.length, advanced: winners.length };
  }

  return null;
}

module.exports = {
  runDraw,
  roundRobinPairs,
  advanceKnockoutStage,
  getPromotedParticipants,
  isStageComplete,
};
