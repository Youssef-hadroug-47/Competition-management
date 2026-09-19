const { db, now, parseJson } = require('../db');
const { id, slugify } = require('../utils/ids');
const { asyncHandler } = require('../utils/asyncHandler');
const { httpError } = require('../middleware/error');
const map = require('../services/mappers');
const access = require('../services/access');
const { getRoles, getRole, addRole, deleteRole } = require('../services/tournamentRolesService');
const { updateRole } = require('./authController');

function insertStageWithGroups(tournamentId, stageInput, index) {
  if (!['league', 'knockout'].includes(stageInput.type)) {
    throw httpError(400, 'stage type must be league or knockout');
  }
  const stageId = id();
  const settings = {
    ...map.defaultStageSettings(stageInput.type),
    ...(stageInput.settings || {}),
  };
  db.prepare(
    `INSERT INTO stages (id, tournament_id, type, sequence_order, settings)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    stageId,
    tournamentId,
    stageInput.type,
    stageInput.sequenceOrder ?? index + 1,
    JSON.stringify(settings)
  );

  const groups = stageInput.groups || [];
  groups.forEach((g, gIndex) => {
    const sequenceOrder = g.sequenceOrder ?? g.sequence_order ?? gIndex + 1;
    if (stageInput.type === 'knockout') {
      db.prepare(`INSERT INTO rounds (id, stage_id, name, sequence_order) VALUES (?, ?, ?, ?)`).run(
        id(),
        stageId,
        g.name,
        sequenceOrder
      );
    } else {
      db.prepare(
        'INSERT INTO groups (id, stage_id, name, sequence_order, number_teams, promotion_rules) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(
        id(),
        stageId,
        g.name,
        sequenceOrder,
        g.number_teams ?? g.numberOfTeams,
        g.promotion_rules ?? '[]'
      );
    }
  });
  return stageId;
}

function loadFormat(tournamentId) {
  const stages = db
    .prepare('SELECT * FROM stages WHERE tournament_id = ? ORDER BY sequence_order ASC')
    .all(tournamentId)
    .map((s) => {
        if (s.type === 'league') {
          const groups = db
            .prepare( `SELECT * FROM groups WHERE stage_id = ? ORDER BY sequence_order ASC, name ASC`)
            .all(s.id)
            .map(map.group);
          return { ...map.stage(s), groups };
        }
        const rounds = db
          .prepare( `SELECT * FROM rounds WHERE stage_id = ? ORDER BY sequence_order ASC, name ASC`)
          .all(s.id)
          .map(map.round);
        return { ...map.stage(s), rounds };

    });
  return stages;
}

const create = asyncHandler((req, res) => {
  const body = req.body || {};
  if (!body.name) throw httpError(400, 'name is required');
  const visibility = body.visibility === 'private' ? 'private' : 'public';
  const tournamentId = id();
  db.prepare(
    `INSERT INTO tournaments (id, name, slug, status, visibility, number_of_teams, place, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    tournamentId,
    body.name.trim(),
    body.slug || slugify(body.name),
    body.status || 'draft',
    visibility,
    Number(body.numberOfTeams) || 0,
    body.place || null,
    req.user.id,
    now(),
    now()
  );

  db.prepare(
    `INSERT INTO tournament_role (tournament_id, user_id, role)
    VALUES (? ,? ,?)`
  ).run(
    tournamentId,
    req.user.id,
    'moderator'
  )

  const stages = Array.isArray(body.stages) ? body.stages : [];
  stages.forEach((stage, index) => insertStageWithGroups(tournamentId, stage, index));

  const row = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId);
  res.status(201).json({ tournament: map.tournament(row), stages: loadFormat(tournamentId) });
});

const list = asyncHandler((req, res) => {
  const rows = db.prepare('SELECT * FROM tournaments ORDER BY created_at DESC').all();
  const items = rows.map((row) => {
    const visible = access.canInspectTournament(row, req.user);
    const base = map.tournament(row);
    if (visible) return base;
    return {
      id: base.id,
      name: base.name,
      slug: base.slug,
      visibility: 'private',
      status: base.status,
      place: base.place,
      restricted: true,
    };
  });
  res.json({ tournaments: items });
});

const getStage = asyncHandler((req, res) => {
  const stageRow = db.prepare('SELECT * FROM stages WHERE id = ?').get(req.params.id);
  res.json(map.stage(stageRow));
});

const getOne = asyncHandler((req, res) => {
  const row = access.getTournamentOrThrow(req.params.tournamentId);
  access.requireTournamentInspect(row, req.user);
  res.json({
    tournament: map.tournament(row),
    stages: loadFormat(row.id),
  });
});

const update = asyncHandler((req, res) => {
  const row = access.getTournamentOrThrow(req.params.tournamentId);
  const body = req.body || {};
  const next = {
    name: body.name ?? row.name,
    status: body.status ?? row.status,
    visibility: body.visibility ?? row.visibility,
    number_of_teams: body.numberOfTeams ?? row.number_of_teams,
    place: body.place === undefined ? row.place : body.place,
  };
  db.prepare(
    `UPDATE tournaments SET name = ?, status = ?, visibility = ?, number_of_teams = ?, place = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    next.name,
    next.status,
    next.visibility,
    next.number_of_teams,
    next.place,
    now(),
    row.id
  );
  const updated = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(row.id);
  res.json({ tournament: map.tournament(updated) });
});

const remove = asyncHandler((req, res) => {
  access.getTournamentOrThrow(req.params.tournamentId);
  db.prepare('DELETE FROM tournaments WHERE id = ?').run(req.params.tournamentId);
  res.status(204).end();
});

const addStage = asyncHandler((req, res) => {
  const tournament = access.getTournamentOrThrow(req.params.tournamentId);
  insertStageWithGroups(tournament.id, req.body || {}, 0);
  res.status(201).json({ stages: loadFormat(tournament.id) });
});

const updateStage = asyncHandler((req, res) => {
  const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(req.params.id);
  if (!stage) throw httpError(404, 'Stage not found');
  const body = req.body || {};
  const settings = body.settings
    ? { ...map.defaultStageSettings(stage.type), ...parseJson(stage.settings), ...body.settings }
    : parseJson(stage.settings);
  db.prepare(
    `UPDATE stages SET type = ?, sequence_order = ?, settings = ? WHERE id = ?`
  ).run(body.type || stage.type, body.sequenceOrder ?? stage.sequence_order, JSON.stringify(settings), stage.id);
  const updated = db.prepare('SELECT * FROM stages WHERE id = ?').get(stage.id);
  res.json({ stage: map.stage(updated) });
});

const removeStage = asyncHandler((req, res) => {
  const info = db.prepare('DELETE FROM stages WHERE id = ?').run(req.params.id);
  if (!info.changes) throw httpError(404, 'Stage not found');
  res.status(204).end();
});

const addGroup = asyncHandler((req, res) => {
  const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(req.params.id);
  if (!stage) throw httpError(404, 'Stage not found');
  if (!req.body?.name) throw httpError(400, 'name is required');
  if (req.body?.number_teams === undefined || req.body?.number_teams === null)
    throw httpError(400, 'number of teams is required');

  const groupId = id();
  db.prepare(`INSERT INTO groups (id, stage_id, name, sequence_order, number_teams, promotion_rules) VALUES (?, ?, ?, ?, ?, ?)`).run(
    groupId,
    stage.id,
    req.body.name,
    req.body.sequenceOrder ?? 1,
    req.body.number_teams,
    req.body.promotion_rules ?? JSON.stringify([{from: 1, to: req.body.number_teams, stage: null}])
  );

  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  res.status(201).json({ group: map.group(group) });
});

const addRound = asyncHandler((req, res) => {
  const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(req.params.id);
  if (!stage) throw httpError(404, 'Stage not found');
  if (!req.body?.name) throw httpError(400, 'name is required');

  const roundId = id();
  db.prepare(`INSERT INTO rounds (id, stage_id, name, sequence_order) VALUES (?, ?, ?, ?)`).run(
    roundId,
    stage.id,
    req.body.name,
    req.body.sequenceOrder ?? 1
  );

  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(roundId);
  res.status(201).json({ round: map.round(round) });
});

const updateRound = asyncHandler((req, res) => {
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(req.params.id);
  if (!round) throw httpError(404, 'round not found');
  db.prepare('UPDATE rounds SET name = ?, sequence_order = ? WHERE id = ?').run(
    req.body?.name ?? round.name,
    req.body?.sequenceOrder ?? round.sequence_order,
    round.id
  );
  res.json({ round: map.round(db.prepare('SELECT * FROM rounds WHERE id = ?').get(round.id)) });
});

const updateGroup = asyncHandler((req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!group) throw httpError(404, 'Group not found');
  db.prepare(
    'UPDATE groups SET name = ?, sequence_order = ?, number_teams = ?, promotion_rules = ? WHERE id = ?'
  ).run(
    req.body?.name ?? group.name,
    req.body?.sequence_order ?? group.sequence_order,
    req.body?.number_teams ?? group.number_teams,
    req.body.promotion_rules ?? JSON.stringify([{from: 1, to: req.body.number_teams, stage: null}]),
    group.id
  );
  res.json({group: map.group(db.prepare('SELECT * from groups WHERE id = ?').get(group.id))});
});

const removeGroup = asyncHandler((req, res) => {
  db.prepare('UPDATE matches SET group_id = NULL WHERE group_id = ?').run(req.params.id);
  const info = db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);
  if (!info.changes) throw httpError(404, 'Group not found');
  res.status(204).end();
});

const removeRound = asyncHandler((req, res) => {
  db.prepare('UPDATE matches SET group_id = NULL WHERE group_id = ?').run(req.params.id);
  const info = db.prepare('DELETE FROM rounds WHERE id = ?').run(req.params.id);
  if (!info.changes) throw httpError(404, 'Round not found');
  res.status(204).end();
})

const getAllTournamentRole = asyncHandler((req, res) => {
  const tournamentId = req.params.tournamentId || null;

  if (!tournamentId)
    throw httpError(400, 'tournaments id is required');

  const roles = getRoles(tournamentId);
  if (!roles || roles.length === 0 )
    throw httpError(404, 'Requested tournament does not exist or tournament roles are not set');
  
  res.json(roles);

});

const getTournamentRole = asyncHandler((req, res) => {
  const userId = req.params.userId || null;
  const tournamentId = req.params.tournamentId || null;
  
  if (!userId || !tournamentId)
    throw httpError(400, 'user and tournament ids are both required');
  const role = getRole(tournamentId, userId);
  if (!role)
    throw httpError(404, 'Requested user does not have a role in the given tournamnet');
  res.json({role});
});

const addTournamentRole = asyncHandler((req, res) => {
  const userId = req.params.userId || null;
  const tournamentId = req.params.tournamentId || null;
  const role = req.body.role || null;

  if (!userId || !tournamentId || !role )  
    throw httpError(400, 'userId, tournamentId and role are required');


  if (!['referee', 'moderator'].includes(role))
    throw httpError(400, 'only referee and moderator roles are available');

  if (!addRole(tournamentId, userId, role))
    throw httpError(400, 'this user already have a role');

  res.status(201).end();

});

const updateTournamentRole = asyncHandler((req, res) => {
  const userId = req.params.userId || null;
  const tournamentId = req.params.tournamentId || null;
  const role = req.body.role || null;


  if (!userId || !tournamentId || !role) 
    throw httpError(400, 'userId, tournamentId and role are required');

  if (!['referee', 'moderator'].includes(role))
    throw httpError(400, 'only referee and moderator roles are available');

  if(!updateRole(tournamentId, userId, role)) 
    throw httpError(404, 'tournament or user does not exist');
  res.status(204).end();
});
const deleteTournamentRole = asyncHandler((req, res) => {

  const userId = req.params.userId || null;
  const tournamentId = req.params.tournamentId || null;


  if (!userId || !tournamentId) 
    throw httpError(400, 'userId and tournamentId are required');

  if (!deleteRole(tournamentId, userId))
    throw httpError(404, 'tournament or user does not exist');

  res.status(204).end();
});

module.exports = {
  getAllTournamentRole,
  getTournamentRole,
  updateTournamentRole,
  addTournamentRole,
  deleteTournamentRole,
  create,
  list,
  getOne,
  update,
  remove,
  getStage,
  addStage,
  updateStage,
  removeStage,
  addGroup,
  addRound,
  updateGroup,
  updateRound,
  removeGroup,
  removeRound,
  loadFormat,
};
