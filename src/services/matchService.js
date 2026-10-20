const { query, withTransaction, now, parseJson } = require('../db');
const map = require('./mappers');
const { httpError } = require('../middleware/error');
const { finalizeStageIfComplete } = require('./drawService');
const { id } = require('../utils/ids');
const suspension = require('./suspensionService');

const TRANSITIONS = {
  start: { from: ['scheduled', 'postponed'], to: 'live' },
  pause: { from: ['live'], to: 'paused' },
  resume: { from: ['paused'], to: 'live' },
  abandon: { from: ['live', 'paused'], to: 'scheduled' },
  update: { from: ['live', 'paused'], to: null },
  finish: { from: ['live', 'paused'], to: 'finished' },
};

const run = (client, text, values = []) => (client || { query }).query(text, values);
const one = async (client, text, values) => (await run(client, text, values)).rows[0] || null;
const many = async (client, text, values) => (await run(client, text, values)).rows;

function assertTransition(currentStatus, action) {
  const rule = TRANSITIONS[action];
  if (!rule || !rule.from.includes(currentStatus)) throw httpError(409, `Cannot ${action} a match with status "${currentStatus}".`);
}
function assertAdministratorMutationAllowed(status) {
  if (['live', 'paused'].includes(status)) throw httpError(409, 'Administrator changes are disabled while the match is active. The assigned referee has control.');
}
function assertRevision(match, expectedRevision) {
  if (expectedRevision == null) return;
  const expected = Number(expectedRevision);
  if (!Number.isInteger(expected) || expected < 0 || expected !== Number(match.revision || 0)) {
    throw httpError(409, 'Match changed since it was loaded. Refresh before making another change.');
  }
}

async function writeAudit(client, { matchBefore, matchAfter, userId, action, reason }) {
  await run(client, `INSERT INTO match_audit
    (id, match_id, tournament_id, user_id, action, reason, before_state, after_state)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [id(), matchBefore.id, matchBefore.tournament_id, userId || null, action, reason || null,
    JSON.stringify(matchBefore), JSON.stringify(matchAfter)]);
}

async function applyResultToTableInternal(client, match, homeScore, awayScore, pointsSettings) {
  const pts = pointsSettings || { win: 3, draw: 1, loss: 0 };
  const teams = await many(
    client,
    'SELECT * FROM participant_teams WHERE id = ANY($1::text[])',
    [[match.home_participant_team_id, match.away_participant_team_id]],
  );
  const teamsById = new Map(teams.map((team) => [team.id, team]));
  const home = teamsById.get(match.home_participant_team_id);
  const away = teamsById.get(match.away_participant_team_id);
  if (!home || !away) return;
  const homeWin = homeScore > awayScore;
  const draw = homeScore === awayScore;
  await run(client, `UPDATE participant_teams SET played=played+1, won=won+$1, drawn=drawn+$2,
    lost=lost+$3, goals_for=goals_for+$4, goals_against=goals_against+$5, points=points+$6, status='active' WHERE id=$7`,
  [homeWin ? 1 : 0, draw ? 1 : 0, homeWin || draw ? 0 : 1, homeScore, awayScore,
    homeWin ? pts.win : draw ? pts.draw : pts.loss, home.id]);
  await run(client, `UPDATE participant_teams SET played=played+1, won=won+$1, drawn=drawn+$2,
    lost=lost+$3, goals_for=goals_for+$4, goals_against=goals_against+$5, points=points+$6, status='active' WHERE id=$7`,
  [homeWin ? 0 : draw ? 0 : 1, draw ? 1 : 0, homeWin ? 1 : 0, awayScore, homeScore,
    homeWin ? pts.loss : draw ? pts.draw : pts.win, away.id]);
}

async function applyResultToTable(match, homeScore, awayScore, pointsSettings) {
  return withTransaction((client) => applyResultToTableInternal(client, match, homeScore, awayScore, pointsSettings));
}

async function finishMatchRecord({ matchRow, homeScore, awayScore, extraTimeHome = null, extraTimeAway = null,
  penaltiesHome = null, penaltiesAway = null, refereeId, userId = refereeId, action = 'finish', expectedRevision }) {
  assertRevision(matchRow, expectedRevision);
  const reopened = Boolean(matchRow.finished_at);
  return withTransaction(async (client) => {
    const result = await run(client, `UPDATE matches SET status='finished', home_score=$1, away_score=$2,
      extra_time_home=$3, extra_time_away=$4, penalties_home=$5, penalties_away=$6, finished_at=$7,
      referee_id=COALESCE(referee_id,$8), revision=revision+1 WHERE id=$9 AND revision=$10`,
    [homeScore, awayScore, extraTimeHome, extraTimeAway, penaltiesHome, penaltiesAway, now(), refereeId || null,
      matchRow.id, Number(matchRow.revision || 0)]);
    if (!result.rowCount) throw httpError(409, 'Match changed while it was being finished. Refresh and retry.');
    const stage = await one(client, 'SELECT * FROM stages WHERE id=$1', [matchRow.stage_id]);
    const settings = parseJson(stage?.settings, map.defaultStageSettings(stage?.type));
    if (stage?.type === 'league' && !reopened) await applyResultToTableInternal(client, matchRow, Number(homeScore), Number(awayScore), settings.points);
    const advance = reopened ? null : await finalizeStageIfComplete(stage.id, client);
    const match = await one(client, 'SELECT * FROM matches WHERE id=$1', [matchRow.id]);
    await writeAudit(client, { matchBefore: matchRow, matchAfter: match, userId, action });
    return { match, advance, stage };
  });
}

async function reverseResultFromTable(client, match, homeScore, awayScore, pointsSettings) {
  const pts = pointsSettings || { win: 3, draw: 1, loss: 0 };
  const teams = await many(
    client,
    'SELECT * FROM participant_teams WHERE id = ANY($1::text[])',
    [[match.home_participant_team_id, match.away_participant_team_id]],
  );
  const teamsById = new Map(teams.map((team) => [team.id, team]));
  const home = teamsById.get(match.home_participant_team_id);
  const away = teamsById.get(match.away_participant_team_id);
  if (!home || !away) return;
  const homeWin = homeScore > awayScore; const draw = homeScore === awayScore;
  const reverse = (team, wins, draws, losses, gf, ga, points) => run(client,
    `UPDATE participant_teams SET played=GREATEST(0,played-1), won=GREATEST(0,won-$1),
     drawn=GREATEST(0,drawn-$2), lost=GREATEST(0,lost-$3), goals_for=GREATEST(0,goals_for-$4),
     goals_against=GREATEST(0,goals_against-$5), points=GREATEST(0,points-$6) WHERE id=$7`,
    [wins, draws, losses, gf, ga, points, team.id]);
  await reverse(home, homeWin ? 1 : 0, draw ? 1 : 0, homeWin || draw ? 0 : 1, homeScore, awayScore, homeWin ? pts.win : draw ? pts.draw : pts.loss);
  await reverse(away, homeWin ? 0 : draw ? 0 : 1, draw ? 1 : 0, homeWin ? 1 : 0, awayScore, homeScore, homeWin ? pts.loss : draw ? pts.draw : pts.win);
}

async function correctFinishedMatchRecord({ matchRow, homeScore, awayScore, extraTimeHome = null, extraTimeAway = null,
  penaltiesHome = null, penaltiesAway = null, userId, expectedRevision, reason }) {
  assertRevision(matchRow, expectedRevision);
  const stage = await one(null, 'SELECT * FROM stages WHERE id=$1', [matchRow.stage_id]);
  if (!stage || stage.type !== 'league') throw httpError(409, 'Finished knockout matches cannot be corrected directly. Reset and redraw the stage to recalculate its bracket safely.');
  const settings = parseJson(stage.settings, map.defaultStageSettings(stage.type));
  return withTransaction(async (client) => {
    await reverseResultFromTable(client, matchRow, Number(matchRow.home_score || 0), Number(matchRow.away_score || 0), settings.points);
    const result = await run(client, `UPDATE matches SET home_score=$1, away_score=$2, extra_time_home=$3,
      extra_time_away=$4, penalties_home=$5, penalties_away=$6, revision=revision+1 WHERE id=$7 AND revision=$8`,
    [homeScore, awayScore, extraTimeHome, extraTimeAway, penaltiesHome, penaltiesAway, matchRow.id, Number(matchRow.revision || 0)]);
    if (!result.rowCount) throw httpError(409, 'Match changed while the correction was being saved. Refresh and retry.');
    await applyResultToTableInternal(client, matchRow, Number(homeScore), Number(awayScore), settings.points);
    const updated = await one(client, 'SELECT * FROM matches WHERE id=$1', [matchRow.id]);
    await writeAudit(client, { matchBefore: matchRow, matchAfter: updated, userId, action: 'correct_finished_result', reason });
    return { match: updated, advance: null, stage };
  });
}

async function rebuildTournamentProjections(tournamentId) {
  return withTransaction(async (client) => {
    // Set-based rebuild. Team and player projections are reset with one UPDATE
    // each, every finished match's events are read in a single query, and the
    // resulting score/stat/table changes are written back with bulk unnest
    // updates. Total query count is constant instead of scaling with the number
    // of teams, players, matches, and events.
    await run(client, `UPDATE participant_teams pt
      SET played=0,won=0,drawn=0,lost=0,goals_for=0,goals_against=0,points=0,winner=false
      FROM tournaments t
      WHERE t.id=$1 AND pt.tournament_id=t.id`, [tournamentId]);
    await run(client, `UPDATE participant_players pp
      SET yellow_cards=0,red_cards=0,goals=0,assists=0
      FROM participant_teams pt
      WHERE pt.tournament_id=$1 AND pp.participant_team_id=pt.id`, [tournamentId]);

    const matches = await many(client, `SELECT m.id,m.stage_id,m.home_participant_team_id,m.away_participant_team_id,s.type,s.settings
      FROM matches m JOIN stages s ON s.id=m.stage_id
      WHERE m.tournament_id=$1 AND m.status='finished'`, [tournamentId]);
    if (!matches.length) return;

    const events = await many(client, `SELECT me.*
      FROM match_events me JOIN matches m ON m.id=me.match_id
      WHERE m.tournament_id=$1 AND m.status='finished'`, [tournamentId]);
    const eventsByMatch = new Map();
    for (const event of events) {
      if (!eventsByMatch.has(event.match_id)) eventsByMatch.set(event.match_id, []);
      eventsByMatch.get(event.match_id).push(event);
    }

    const scoreIds = [];
    const scores = { home: [], away: [], extraHome: [], extraAway: [], penaltiesHome: [], penaltiesAway: [] };
    const playerGoals = new Map();
    const playerAssists = new Map();
    const playerYellow = new Map();
    const playerRed = new Map();
    const teamAgg = new Map();
    const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
    const teamEntry = (teamId) => {
      if (!teamAgg.has(teamId)) {
        teamAgg.set(teamId, { played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, points: 0 });
      }
      return teamAgg.get(teamId);
    };

    for (const match of matches) {
      const stats = { home: 0, away: 0, extraHome: 0, extraAway: 0, penaltiesHome: 0, penaltiesAway: 0 };
      for (const event of eventsByMatch.get(match.id) || []) {
        const payload = parseJson(event.payload, {});
        if (event.type === 'goal') {
          const home = payload.ownGoal ? event.team_id !== match.home_participant_team_id : event.team_id === match.home_participant_team_id;
          if (event.phase === 'extra_time') stats[home ? 'extraHome' : 'extraAway'] += 1;
          else if (event.phase !== 'shootout') stats[home ? 'home' : 'away'] += 1;
        } else if (event.type === 'shootout_attempt' && payload.scored) {
          stats[event.team_id === match.home_participant_team_id ? 'penaltiesHome' : 'penaltiesAway'] += 1;
        }
        if (event.player_id) {
          if (event.type === 'goal' && !payload.ownGoal) bump(playerGoals, event.player_id);
          if (event.type === 'assist' && !payload.skipped) bump(playerAssists, event.player_id);
          if (event.type === 'card') (event.card === 'red' ? bump(playerRed, event.player_id) : bump(playerYellow, event.player_id));
        }
      }

      scoreIds.push(match.id);
      scores.home.push(stats.home);
      scores.away.push(stats.away);
      scores.extraHome.push(stats.extraHome);
      scores.extraAway.push(stats.extraAway);
      scores.penaltiesHome.push(stats.penaltiesHome);
      scores.penaltiesAway.push(stats.penaltiesAway);

      if (match.type === 'league') {
        const settings = parseJson(match.settings, map.defaultStageSettings('league'));
        const pts = settings.points || { win: 3, draw: 1, loss: 0 };
        const homeWin = stats.home > stats.away;
        const draw = stats.home === stats.away;
        const home = teamEntry(match.home_participant_team_id);
        home.played += 1;
        home.won += homeWin ? 1 : 0;
        home.drawn += draw ? 1 : 0;
        home.lost += homeWin || draw ? 0 : 1;
        home.gf += stats.home;
        home.ga += stats.away;
        home.points += homeWin ? pts.win : draw ? pts.draw : pts.loss;
        const away = teamEntry(match.away_participant_team_id);
        away.played += 1;
        away.won += !homeWin && !draw ? 1 : 0;
        away.drawn += draw ? 1 : 0;
        away.lost += homeWin ? 1 : 0;
        away.gf += stats.away;
        away.ga += stats.home;
        away.points += homeWin ? pts.loss : draw ? pts.draw : pts.win;
      }
    }

    await run(client, `UPDATE matches m SET home_score=v.home,away_score=v.away,
      extra_time_home=v.extra_home,extra_time_away=v.extra_away,
      penalties_home=v.pen_home,penalties_away=v.pen_away
      FROM unnest($1::text[],$2::int[],$3::int[],$4::int[],$5::int[],$6::int[],$7::int[])
        AS v(id,home,away,extra_home,extra_away,pen_home,pen_away)
      WHERE m.id=v.id`,
    [scoreIds, scores.home, scores.away, scores.extraHome, scores.extraAway, scores.penaltiesHome, scores.penaltiesAway]);

    if (playerGoals.size || playerAssists.size || playerYellow.size || playerRed.size) {
      const ids = [...new Set([...playerGoals.keys(), ...playerAssists.keys(), ...playerYellow.keys(), ...playerRed.keys()])];
      await run(client, `UPDATE participant_players pp
        SET goals=pp.goals+v.goals,assists=pp.assists+v.assists,
            yellow_cards=pp.yellow_cards+v.yellow,red_cards=pp.red_cards+v.red
        FROM unnest($1::text[],$2::int[],$3::int[],$4::int[],$5::int[])
          AS v(id,goals,assists,yellow,red)
        WHERE pp.id=v.id`,
      [ids, ids.map((id) => playerGoals.get(id) || 0), ids.map((id) => playerAssists.get(id) || 0),
        ids.map((id) => playerYellow.get(id) || 0), ids.map((id) => playerRed.get(id) || 0)]);
    }

    if (teamAgg.size) {
      const ids = [...teamAgg.keys()];
      const agg = ids.map((id) => teamAgg.get(id));
      await run(client, `UPDATE participant_teams pt
        SET played=pt.played+v.played,won=pt.won+v.won,drawn=pt.drawn+v.drawn,lost=pt.lost+v.lost,
            goals_for=pt.goals_for+v.gf,goals_against=pt.goals_against+v.ga,points=pt.points+v.points,
            status='active'
        FROM unnest($1::text[],$2::int[],$3::int[],$4::int[],$5::int[],$6::int[],$7::int[],$8::int[])
          AS v(id,played,won,drawn,lost,gf,ga,points)
        WHERE pt.id=v.id`,
      [ids, agg.map((x) => x.played), agg.map((x) => x.won), agg.map((x) => x.drawn), agg.map((x) => x.lost),
        agg.map((x) => x.gf), agg.map((x) => x.ga), agg.map((x) => x.points)]);
    }
  });
}

async function pauseMatchRecord(matchRow, adminOverride = false, expectedRevision) {
  assertRevision(matchRow, expectedRevision); if (!adminOverride) assertTransition(matchRow.status, 'pause');
  const result = await run(null, `UPDATE matches SET status='paused',revision=revision+1 WHERE id=$1 AND revision=$2`, [matchRow.id, Number(matchRow.revision || 0)]);
  if (!result.rowCount) throw httpError(409, 'Match changed while it was being paused. Refresh and retry.');
  return one(null, 'SELECT * FROM matches WHERE id=$1', [matchRow.id]);
}
async function resumeMatchRecord(matchRow, adminOverride = false, expectedRevision) {
  assertRevision(matchRow, expectedRevision); if (!adminOverride) assertTransition(matchRow.status, 'resume');
  const result = await run(null, `UPDATE matches SET status='live',revision=revision+1 WHERE id=$1 AND revision=$2`, [matchRow.id, Number(matchRow.revision || 0)]);
  if (!result.rowCount) throw httpError(409, 'Match changed while it was being resumed. Refresh and retry.');
  return one(null, 'SELECT * FROM matches WHERE id=$1', [matchRow.id]);
}
async function abandonMatchRecord(matchRow, reason, adminOverride = false) {
  if (!reason || !String(reason).trim()) throw httpError(400, 'A reason is required to abandon a match.');
  if (!adminOverride) assertTransition(matchRow.status, 'abandon');
  await run(null, `UPDATE matches SET status='scheduled',${adminOverride ? "phase='abandoned'," : ''} home_score=NULL,away_score=NULL,extra_time_home=NULL,extra_time_away=NULL,penalties_home=NULL,penalties_away=NULL,started_at=NULL,finished_at=NULL${adminOverride ? ',phase_started_at=NULL,phase_elapsed_seconds=0' : ''} WHERE id=$1`, [matchRow.id]);
  await suspension.resetDecisionsForAbandonedMatch(matchRow.id);
  return one(null, 'SELECT * FROM matches WHERE id=$1', [matchRow.id]);
}
async function cancelMatchRecord(matchRow) {
  await run(null, `UPDATE matches SET status='cancelled',phase='abandoned',home_score=NULL,away_score=NULL,extra_time_home=NULL,extra_time_away=NULL,penalties_home=NULL,penalties_away=NULL,started_at=NULL,finished_at=NULL,phase_started_at=NULL,phase_elapsed_seconds=0 WHERE id=$1`, [matchRow.id]);
  return one(null, 'SELECT * FROM matches WHERE id=$1', [matchRow.id]);
}
async function participantTeamWithTeam(idValue) {
  if (!idValue) return null;
  return one(null, 'SELECT pt.* FROM participant_teams pt WHERE pt.id=$1', [idValue]);
}
async function squadFor(idValue) {
  if (!idValue) return [];
  return many(null, `SELECT pp.* FROM participant_players pp WHERE pp.participant_team_id=$1 ORDER BY pp.shirt_number`, [idValue]);
}
async function getMatchDetail(matchId, matchRow = null) {
  const row = matchRow || await one(null, 'SELECT * FROM matches WHERE id=$1', [matchId]);
  if (!row) return null;
  const [
    context,
    homeTeam,
    awayTeam,
    homeSquad,
    awaySquad,
    suspensions,
  ] = await Promise.all([
    one(
      null,
      `SELECT s.*,
              g.id AS detail_group_id, g.name AS detail_group_name,
              r.id AS detail_round_id, r.name AS detail_round_name
       FROM stages s
       LEFT JOIN groups g ON g.id = $2 AND g.stage_id = s.id
       LEFT JOIN rounds r ON r.id = $2 AND r.stage_id = s.id
       WHERE s.id = $1`,
      [row.stage_id, row.group_id],
    ),
    participantTeamWithTeam(row.home_participant_team_id),
    participantTeamWithTeam(row.away_participant_team_id),
    squadFor(row.home_participant_team_id),
    squadFor(row.away_participant_team_id),
    suspension.getForMatch(row.id, row.tournament_id),
  ]);
  const stage = context;
  const group = context?.detail_group_id
    ? { id: context.detail_group_id, name: context.detail_group_name }
    : null;
  const round = !group && context?.detail_round_id
    ? { id: context.detail_round_id, name: context.detail_round_name }
    : null;
  const byPlayer = new Map(suspensions.map((entry) => [entry.participantPlayerId, entry]));
  const annotate = (squad) => squad.map((player) => ({ ...map.participantPlayer(player), suspension: byPlayer.get(player.id) || null }));
  return { match: map.match(row), stage: stage ? map.stage(stage) : null, group, round,
    homeTeam: homeTeam ? map.participantTeam(homeTeam) : null, awayTeam: awayTeam ? map.participantTeam(awayTeam) : null,
    homeSquad: annotate(homeSquad), awaySquad: annotate(awaySquad), suspensions };
}

module.exports = { applyResultToTable, correctFinishedMatchRecord, finishMatchRecord, assertTransition,
  assertRevision, assertAdministratorMutationAllowed, rebuildTournamentProjections, pauseMatchRecord,
  resumeMatchRecord, abandonMatchRecord, cancelMatchRecord, getMatchDetail };
