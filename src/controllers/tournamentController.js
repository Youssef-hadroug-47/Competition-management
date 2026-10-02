const { query, withTransaction, now, parseJson } = require('../db');
const { id, slugify } = require('../utils/ids');
const { asyncHandler } = require('../utils/asyncHandler');
const { httpError } = require('../middleware/error');
const map = require('../services/mappers');
const access = require('../services/access');
const { getRoles, getRole, addRole, updateRole, deleteRole } = require('../services/tournamentRolesService');

async function insertStageWithGroups(tournamentId, stageInput, index, executor = { query }) {
  if (!['league', 'knockout'].includes(stageInput.type)) throw httpError(400, 'stage type must be league or knockout');
  const stageId = id();
  const settings = { ...map.defaultStageSettings(stageInput.type), ...(stageInput.settings || {}) };
  await executor.query(
    `INSERT INTO stages (id, tournament_id, type, sequence_order, settings) VALUES ($1, $2, $3, $4, $5)`,
    [stageId, tournamentId, stageInput.type, stageInput.sequenceOrder ?? index + 1, JSON.stringify(settings)],
  );
  for (const [gIndex, g] of (stageInput.groups || []).entries()) {
    const sequenceOrder = g.sequenceOrder ?? g.sequence_order ?? gIndex + 1;
    if (stageInput.type === 'knockout') {
      await executor.query('INSERT INTO rounds (id, stage_id, name, sequence_order) VALUES ($1, $2, $3, $4)', [id(), stageId, g.name, sequenceOrder]);
    } else {
      await executor.query(
        'INSERT INTO groups (id, stage_id, name, sequence_order, number_teams, advancing_teams, promotion_rules) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [id(), stageId, g.name, sequenceOrder, g.number_teams ?? g.numberOfTeams, g.advancing_teams ?? g.advancingTeams ?? 0, g.promotion_rules ?? '[]'],
      );
    }
  }
  return stageId;
}

async function loadFormat(tournamentId) {
  const stages = (await query('SELECT * FROM stages WHERE tournament_id = $1 ORDER BY sequence_order ASC', [tournamentId])).rows;
  return Promise.all(stages.map(async (s) => {
    if (s.type === 'league') {
      const groups = (await query('SELECT * FROM groups WHERE stage_id = $1 ORDER BY sequence_order ASC, name ASC', [s.id])).rows;
      return { ...map.stage(s), groups: groups.map(map.group) };
    }
    const rounds = (await query('SELECT * FROM rounds WHERE stage_id = $1 ORDER BY sequence_order ASC, name ASC', [s.id])).rows;
    return { ...map.stage(s), rounds: rounds.map(map.round) };
  }));
}

function bucketSort(teams, key) {
  return [...teams].sort((a, b) => { const ka = key(a); const kb = key(b); for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return kb[i] - ka[i]; return a.id.localeCompare(b.id); });
}

async function rankGroupTeams(groupId, tiebreakers) {
  const teams = (await query(`SELECT DISTINCT pt.* FROM participant_teams pt LEFT JOIN matches m ON m.group_id = $1 AND (m.home_participant_team_id = pt.id OR m.away_participant_team_id = pt.id) WHERE pt.group_id = $1 OR m.id IS NOT NULL`, [groupId])).rows;
  if (!teams.length) return teams;
  const cards = (await query(`SELECT pp.participant_team_id, COALESCE(SUM(pp.yellow_cards), 0) AS yellows, COALESCE(SUM(pp.red_cards), 0) AS reds FROM participant_players pp WHERE pp.participant_team_id = ANY($1::text[]) GROUP BY pp.participant_team_id`, [teams.map((t) => t.id)])).rows;
  const cardMap = new Map(cards.map((c) => [c.participant_team_id, c]));
  teams.forEach((t) => { const c = cardMap.get(t.id) || {}; t.yellow_cards = Number(c.yellows || 0); t.red_cards = Number(c.reds || 0); t.goal_difference = (t.goals_for || 0) - (t.goals_against || 0); });
  const ordered = [...tiebreakers].sort((a, b) => a.priority - b.priority);
  async function resolve(bucket, index) {
    if (bucket.length <= 1) return bucket;
    if (index >= ordered.length) return [...bucket].sort((a, b) => a.id.localeCompare(b.id));
    const tb = ordered[index];
    let keys;
    if (tb.type === 'points') keys = (t) => [Number(t.points || 0)];
    else if (tb.type === 'goal_difference') keys = (t) => [Number(t.goal_difference || 0)];
    else if (tb.type === 'goals_for') keys = (t) => [Number(t.goals_for || 0)];
    else if (tb.type === 'sportsmanlike') keys = (t) => [-Number(t.red_cards || 0), -Number(t.yellow_cards || 0)];
    else if (tb.type === 'draw') return [...bucket].sort((a, b) => a.id.localeCompare(b.id));
    else if (tb.type === 'head_to_head') {
      const ids = bucket.map((t) => t.id);
      const matches = (await query(`SELECT home_participant_team_id AS home, away_participant_team_id AS away, home_score, away_score FROM matches WHERE group_id = $1 AND status = 'finished' AND home_participant_team_id = ANY($2::text[]) AND away_participant_team_id = ANY($2::text[])`, [groupId, ids])).rows;
      const stats = new Map(ids.map((x) => [x, { pts: 0, gf: 0, ga: 0 }]));
      matches.forEach((m) => { const hs = m.home_score || 0; const as = m.away_score || 0; const h = stats.get(m.home); const a = stats.get(m.away); h.gf += hs; h.ga += as; a.gf += as; a.ga += hs; if (hs > as) h.pts += 3; else if (as > hs) a.pts += 3; else { h.pts += 1; a.pts += 1; } });
      keys = (t) => { const s = stats.get(t.id); return [s.pts, s.gf - s.ga, s.gf]; };
    } else throw httpError(500, `Unknown tiebreaker type: ${tb.type}`);
    const sorted = bucketSort(bucket, keys); const groups = []; let current = [];
    sorted.forEach((t) => { if (!current.length || JSON.stringify(keys(t)) === JSON.stringify(keys(current[0]))) current.push(t); else { groups.push(current); current = [t]; } });
    if (current.length) groups.push(current);
    const result = []; for (const group of groups) result.push(...await resolve(group, index + 1)); return result;
  }
  return resolve(teams, 0);
}

const create = asyncHandler(async (req, res) => {
  const body = req.body || {}; if (!body.name) throw httpError(400, 'name is required');
  const visibility = body.visibility === 'private' ? 'private' : 'public'; const tournamentId = id();
  await withTransaction(async (client) => {
    await client.query(`INSERT INTO tournaments (id, name, slug, status, visibility, number_of_teams, place, settings, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [tournamentId, body.name.trim(), body.slug || slugify(body.name), body.status || 'draft', visibility, Number(body.numberOfTeams) || 0, body.place || null, JSON.stringify({ ...map.defaultTournamentSettings(), ...(body.settings || {}), suspensionSystem: { ...map.defaultTournamentSettings().suspensionSystem, ...(body.settings?.suspensionSystem || {}) } }), req.user.id, now(), now()]);
    await client.query('INSERT INTO tournament_role (tournament_id, user_id, role) VALUES ($1,$2,$3)', [tournamentId, req.user.id, 'moderator']);
    for (const [index, stage] of (Array.isArray(body.stages) ? body.stages : []).entries()) await insertStageWithGroups(tournamentId, stage, index, client);
  });
  const row = (await query('SELECT * FROM tournaments WHERE id = $1', [tournamentId])).rows[0];
  res.status(201).json({ tournament: map.tournament(row), stages: await loadFormat(tournamentId) });
});

const list = asyncHandler(async (req, res) => { const rows = (await query(`SELECT * FROM tournaments WHERE visibility = 'public' ORDER BY created_at DESC`)).rows; res.json({ tournaments: rows.map(map.tournament) }); });
const listMine = asyncHandler(async (req, res) => { if (!req.user) throw httpError(401, 'Authentication required'); const rows = (await query(`SELECT DISTINCT t.* FROM tournaments t LEFT JOIN tournament_role tr ON tr.tournament_id = t.id AND tr.user_id = $1 WHERE t.created_by = $1 OR tr.role IN ('moderator', 'team_leader') ORDER BY t.created_at DESC`, [req.user.id])).rows; res.json({ tournaments: rows.map(map.tournament) }); });
const searchByName = asyncHandler(async (req, res) => { const name = typeof req.query.name === 'string' ? req.query.name.trim() : ''; if (!name) throw httpError(400, 'Tournament name is required'); const row = (await query('SELECT * FROM tournaments WHERE name = $1 LIMIT 1', [name])).rows[0]; if (!row) throw httpError(404, 'Tournament not found'); res.json({ tournament: map.tournament(row), locked: !(await access.canInspectTournament(row, req.user)) }); });
const findStaffUser = asyncHandler(async (req, res) => { const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : ''; if (!email) throw httpError(400, 'User email is required'); const user = (await query('SELECT id, name FROM users WHERE email = $1', [email])).rows[0]; if (!user) throw httpError(404, 'No user found with that email'); res.json({ user }); });

const getStanding = asyncHandler(async (req, res) => { const stageId = req.params.id; const groups = (await query('SELECT id FROM groups WHERE stage_id = $1', [stageId])).rows; const stage = (await query('SELECT settings FROM stages WHERE id = $1', [stageId])).rows[0]; const tiebreakers = stage && parseJson(stage.settings).tiebreakers; if (!tiebreakers || !groups.length) throw httpError(404, 'stage is not found'); const rankedGroups = { stageId, groups: [] }; for (const group of groups) rankedGroups.groups.push({ groupId: group.id, order: (await rankGroupTeams(group.id, tiebreakers)).map((t) => t.id) }); res.json(rankedGroups); });
const getStage = asyncHandler(async (req, res) => { const row = (await query('SELECT * FROM stages WHERE id = $1', [req.params.id])).rows[0]; res.json(map.stage(row)); });
const getOne = asyncHandler(async (req, res) => { const row = await access.getTournamentOrThrow(req.params.tournamentId); await access.requireTournamentInspect(row, req.user); const viewerRole = req.user?.role === 'admin' || req.user?.id === row.created_by ? 'moderator' : await getRole(row.id, req.user?.id); res.json({ tournament: map.tournament(row), stages: await loadFormat(row.id), viewerRole }); });
const update = asyncHandler(async (req, res) => { const row = await access.getTournamentOrThrow(req.params.tournamentId); const body = req.body || {}; const next = { name: body.name ?? row.name, status: body.status ?? row.status, visibility: body.visibility ?? row.visibility, number_of_teams: body.numberOfTeams ?? row.number_of_teams, place: body.place === undefined ? row.place : body.place }; await query('UPDATE tournaments SET name=$1,status=$2,visibility=$3,number_of_teams=$4,place=$5,updated_at=$6 WHERE id=$7', [next.name, next.status, next.visibility, next.number_of_teams, next.place, now(), row.id]); const updated = (await query('SELECT * FROM tournaments WHERE id = $1', [row.id])).rows[0]; res.json({ tournament: map.tournament(updated) }); });
const remove = asyncHandler(async (req, res) => { await access.getTournamentOrThrow(req.params.tournamentId); await query('DELETE FROM tournaments WHERE id = $1', [req.params.tournamentId]); res.status(204).end(); });
const addStage = asyncHandler(async (req, res) => { const tournament = await access.getTournamentOrThrow(req.params.tournamentId); await insertStageWithGroups(tournament.id, req.body || {}, 0); res.status(201).json({ stages: await loadFormat(tournament.id) }); });
const updateStage = asyncHandler(async (req, res) => { const stage = (await query('SELECT * FROM stages WHERE id = $1', [req.params.id])).rows[0]; if (!stage) throw httpError(404, 'Stage not found'); const body = req.body || {}; const settings = body.settings ? { ...map.defaultStageSettings(stage.type), ...parseJson(stage.settings), ...body.settings } : parseJson(stage.settings); await query('UPDATE stages SET type=$1,sequence_order=$2,settings=$3 WHERE id=$4', [body.type || stage.type, body.sequenceOrder ?? stage.sequence_order, JSON.stringify(settings), stage.id]); const updated = (await query('SELECT * FROM stages WHERE id = $1', [stage.id])).rows[0]; res.json({ stage: map.stage(updated) }); });
const removeStage = asyncHandler(async (req, res) => { const result = await query('DELETE FROM stages WHERE id = $1', [req.params.id]); if (!result.rowCount) throw httpError(404, 'Stage not found'); res.status(204).end(); });
const addGroup = asyncHandler(async (req, res) => { const stage = (await query('SELECT * FROM stages WHERE id = $1', [req.params.id])).rows[0]; if (!stage) throw httpError(404, 'Stage not found'); if (!req.body?.name) throw httpError(400, 'name is required'); if (req.body?.number_teams == null) throw httpError(400, 'number of teams is required'); const groupId = id(); await query('INSERT INTO groups (id,stage_id,name,sequence_order,number_teams,advancing_teams,promotion_rules) VALUES ($1,$2,$3,$4,$5,$6,$7)', [groupId, stage.id, req.body.name, req.body.sequenceOrder ?? 1, req.body.number_teams, req.body.advancing_teams ?? 0, req.body.promotion_rules ?? JSON.stringify([{ from: 1, to: req.body.number_teams, stage: null }])]); const group = (await query('SELECT * FROM groups WHERE id = $1', [groupId])).rows[0]; res.status(201).json({ group: map.group(group) }); });
const addRound = asyncHandler(async (req, res) => { const stage = (await query('SELECT * FROM stages WHERE id = $1', [req.params.id])).rows[0]; if (!stage) throw httpError(404, 'Stage not found'); if (!req.body?.name) throw httpError(400, 'name is required'); const roundId = id(); await query('INSERT INTO rounds (id,stage_id,name,sequence_order) VALUES ($1,$2,$3,$4)', [roundId, stage.id, req.body.name, req.body.sequenceOrder ?? 1]); const round = (await query('SELECT * FROM rounds WHERE id = $1', [roundId])).rows[0]; res.status(201).json({ round: map.round(round) }); });
const updateRound = asyncHandler(async (req, res) => { const round = (await query('SELECT * FROM rounds WHERE id = $1', [req.params.id])).rows[0]; if (!round) throw httpError(404, 'round not found'); await query('UPDATE rounds SET name=$1,sequence_order=$2 WHERE id=$3', [req.body?.name ?? round.name, req.body?.sequenceOrder ?? round.sequence_order, round.id]); res.json({ round: map.round((await query('SELECT * FROM rounds WHERE id = $1', [round.id])).rows[0]) }); });
const updateGroup = asyncHandler(async (req, res) => { const group = (await query('SELECT * FROM groups WHERE id = $1', [req.params.id])).rows[0]; if (!group) throw httpError(404, 'Group not found'); await query('UPDATE groups SET name=$1,sequence_order=$2,number_teams=$3,promotion_rules=$4 WHERE id=$5', [req.body?.name ?? group.name, req.body?.sequence_order ?? group.sequence_order, req.body?.number_teams ?? group.number_teams, req.body.promotion_rules ?? JSON.stringify([{ from: 1, to: req.body.number_teams, stage: null }]), group.id]); res.json({ group: map.group((await query('SELECT * FROM groups WHERE id = $1', [group.id])).rows[0]) }); });
const removeGroup = asyncHandler(async (req, res) => { await withTransaction(async (client) => { await client.query('UPDATE matches SET group_id = NULL WHERE group_id = $1', [req.params.id]); const result = await client.query('DELETE FROM groups WHERE id = $1', [req.params.id]); if (!result.rowCount) throw httpError(404, 'Group not found'); }); res.status(204).end(); });
const removeRound = asyncHandler(async (req, res) => { await withTransaction(async (client) => { await client.query('UPDATE matches SET group_id = NULL WHERE group_id = $1', [req.params.id]); const result = await client.query('DELETE FROM rounds WHERE id = $1', [req.params.id]); if (!result.rowCount) throw httpError(404, 'Round not found'); }); res.status(204).end(); });
const getUserRole = asyncHandler(async (req, res) => { const tournamentId = req.params.tournamentId || null; if (!tournamentId) throw httpError(400, 'tournaments id is required'); res.json({ role: await getRole(tournamentId, req.user.id) }); });
const getAllTournamentRole = asyncHandler(async (req, res) => { const tournamentId = req.params.tournamentId || null; if (!tournamentId) throw httpError(400, 'tournaments id is required'); res.json((await getRoles(tournamentId)) || []); });
const getTournamentRole = asyncHandler(async (req, res) => { const { userId, tournamentId } = req.params; if (!userId || !tournamentId) throw httpError(400, 'user and tournament ids are both required'); const role = await getRole(tournamentId, userId); if (!role) throw httpError(404, 'Requested user does not have a role in the given tournamnet'); res.json({ role }); });
const addTournamentRole = asyncHandler(async (req, res) => { const { userId, tournamentId } = req.params; const role = req.body.role || null; if (!userId || !tournamentId || !role) throw httpError(400, 'userId, tournamentId and role are required'); const tournament = await access.getTournamentOrThrow(tournamentId); const targetUser = (await query('SELECT id FROM users WHERE id = $1', [userId])).rows[0]; if (!targetUser) throw httpError(404, 'User not found'); if (userId === tournament.created_by && role !== 'moderator') throw httpError(400, 'The tournament creator must remain a moderator'); if (!['referee', 'moderator', 'team_leader'].includes(role)) throw httpError(400, 'only referee, moderator, and team leader roles are available'); if (!(await addRole(tournamentId, userId, role))) throw httpError(400, 'this user already have a role'); res.status(201).end(); });
const updateTournamentRole = asyncHandler(async (req, res) => { const { userId, tournamentId } = req.params; const role = req.body.role || null; if (!userId || !tournamentId || !role) throw httpError(400, 'userId, tournamentId and role are required'); const tournament = await access.getTournamentOrThrow(tournamentId); if (userId === tournament.created_by) throw httpError(400, 'The tournament creator must remain a moderator'); if (!['referee', 'moderator', 'team_leader'].includes(role)) throw httpError(400, 'only referee, moderator, and team leader roles are available'); if (!(await updateRole(tournamentId, userId, role))) throw httpError(404, 'tournament or user does not exist'); res.status(204).end(); });
const deleteTournamentRole = asyncHandler(async (req, res) => { const { userId, tournamentId } = req.params; if (!userId || !tournamentId) throw httpError(400, 'userId and tournamentId are required'); const tournament = await access.getTournamentOrThrow(tournamentId); if (userId === tournament.created_by) throw httpError(400, 'The tournament creator must remain a moderator'); if (!(await deleteRole(tournamentId, userId))) throw httpError(404, 'tournament or user does not exist'); res.status(204).end(); });

module.exports = { getAllTournamentRole, getTournamentRole, updateTournamentRole, addTournamentRole, deleteTournamentRole, create, list, listMine, searchByName, findStaffUser, getOne, update, remove, getStage, addStage, updateStage, removeStage, addGroup, addRound, updateGroup, updateRound, removeGroup, removeRound, loadFormat, getStanding, getUserRole };
