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
  const home = await one(client, 'SELECT * FROM participant_teams WHERE id = $1', [match.home_participant_team_id]);
  const away = await one(client, 'SELECT * FROM participant_teams WHERE id = $1', [match.away_participant_team_id]);
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
    const advance = reopened ? null : await finalizeStageIfComplete(stage.id);
    const match = await one(client, 'SELECT * FROM matches WHERE id=$1', [matchRow.id]);
    await writeAudit(client, { matchBefore: matchRow, matchAfter: match, userId, action });
    return { match, advance, stage };
  });
}

async function reverseResultFromTable(client, match, homeScore, awayScore, pointsSettings) {
  const pts = pointsSettings || { win: 3, draw: 1, loss: 0 };
  const home = await one(client, 'SELECT * FROM participant_teams WHERE id=$1', [match.home_participant_team_id]);
  const away = await one(client, 'SELECT * FROM participant_teams WHERE id=$1', [match.away_participant_team_id]);
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
    const teams = await many(client, 'SELECT id FROM participant_teams WHERE tournament_id=$1', [tournamentId]);
    const players = await many(client, `SELECT pp.id FROM participant_players pp JOIN participant_teams pt ON pt.id=pp.participant_team_id WHERE pt.tournament_id=$1`, [tournamentId]);
    for (const t of teams) await run(client, `UPDATE participant_teams SET played=0,won=0,drawn=0,lost=0,goals_for=0,goals_against=0,points=0,winner=false WHERE id=$1`, [t.id]);
    for (const p of players) await run(client, `UPDATE participant_players SET yellow_cards=0,red_cards=0,goals=0,assists=0 WHERE id=$1`, [p.id]);
    const matches = await many(client, `SELECT m.*,s.type,s.settings FROM matches m JOIN stages s ON s.id=m.stage_id WHERE m.tournament_id=$1 AND m.status='finished'`, [tournamentId]);
    for (const match of matches) {
      const events = await many(client, 'SELECT * FROM match_events WHERE match_id=$1', [match.id]);
      const stats = { home: 0, away: 0, extraHome: 0, extraAway: 0, penaltiesHome: 0, penaltiesAway: 0 };
      for (const event of events) {
        const payload = parseJson(event.payload, {});
        if (event.type === 'goal') {
          const home = payload.ownGoal ? event.team_id !== match.home_participant_team_id : event.team_id === match.home_participant_team_id;
          if (event.phase === 'extra_time') stats[home ? 'extraHome' : 'extraAway'] += 1;
          else if (event.phase !== 'shootout') stats[home ? 'home' : 'away'] += 1;
        } else if (event.type === 'shootout_attempt' && payload.scored) stats[event.team_id === match.home_participant_team_id ? 'penaltiesHome' : 'penaltiesAway'] += 1;
        if (event.player_id) {
          if (event.type === 'goal' && !payload.ownGoal) await run(client, 'UPDATE participant_players SET goals=goals+1 WHERE id=$1', [event.player_id]);
          if (event.type === 'assist' && !payload.skipped) await run(client, 'UPDATE participant_players SET assists=assists+1 WHERE id=$1', [event.player_id]);
          if (event.type === 'card') await run(client, `UPDATE participant_players SET ${event.card === 'red' ? 'red_cards' : 'yellow_cards'}=${event.card === 'red' ? 'red_cards' : 'yellow_cards'}+1 WHERE id=$1`, [event.player_id]);
        }
      }
      await run(client, `UPDATE matches SET home_score=$1,away_score=$2,extra_time_home=$3,extra_time_away=$4,penalties_home=$5,penalties_away=$6 WHERE id=$7`,
        [stats.home, stats.away, stats.extraHome, stats.extraAway, stats.penaltiesHome, stats.penaltiesAway, match.id]);
      if (match.type === 'league') {
        const settings = parseJson(match.settings, map.defaultStageSettings('league'));
        await applyResultToTableInternal(client, match, stats.home, stats.away, settings.points);
      }
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
  return one(null, `SELECT pt.*,t.name AS team_name,t.slug AS team_slug,t.primary_color,t.secondary_color FROM participant_teams pt JOIN teams t ON t.id=pt.team_id WHERE pt.id=$1`, [idValue]);
}
async function squadFor(idValue) {
  if (!idValue) return [];
  return many(null, `SELECT pp.*,p.name AS player_name,p.slug AS player_slug,p.position AS player_position FROM participant_players pp JOIN players p ON p.id=pp.player_id WHERE pp.participant_team_id=$1 ORDER BY pp.shirt_number`, [idValue]);
}
async function getMatchDetail(matchId) {
  const row = await one(null, 'SELECT * FROM matches WHERE id=$1', [matchId]); if (!row) return null;
  const stage = await one(null, 'SELECT * FROM stages WHERE id=$1', [row.stage_id]);
  let group = null; let round = null;
  if (row.group_id) {
    const groupRow = await one(null, 'SELECT id,name FROM groups WHERE id=$1', [row.group_id]);
    if (groupRow) group = { id: groupRow.id, name: groupRow.name };
    else { const roundRow = await one(null, 'SELECT id,name FROM rounds WHERE id=$1', [row.group_id]); if (roundRow) round = { id: roundRow.id, name: roundRow.name }; }
  }
  const [homeTeam, awayTeam, homeSquad, awaySquad, suspensions] = await Promise.all([
    participantTeamWithTeam(row.home_participant_team_id), participantTeamWithTeam(row.away_participant_team_id),
    squadFor(row.home_participant_team_id), squadFor(row.away_participant_team_id), suspension.getForMatch(row.id, row.tournament_id),
  ]);
  const byPlayer = new Map(suspensions.map((entry) => [entry.participantPlayerId, entry]));
  const annotate = (squad) => squad.map((player) => ({ ...map.participantPlayer(player), suspension: byPlayer.get(player.id) || null }));
  return { match: map.match(row), stage: stage ? map.stage(stage) : null, group, round,
    homeTeam: homeTeam ? map.participantTeam(homeTeam) : null, awayTeam: awayTeam ? map.participantTeam(awayTeam) : null,
    homeSquad: annotate(homeSquad), awaySquad: annotate(awaySquad), suspensions };
}

module.exports = { applyResultToTable, correctFinishedMatchRecord, finishMatchRecord, assertTransition,
  assertRevision, assertAdministratorMutationAllowed, rebuildTournamentProjections, pauseMatchRecord,
  resumeMatchRecord, abandonMatchRecord, cancelMatchRecord, getMatchDetail };
