const { query, withTransaction } = require('../db');
const { id, slugify } = require('../utils/ids');
const { asyncHandler } = require('../utils/asyncHandler');
const { httpError } = require('../middleware/error');
const map = require('../services/mappers');
const access = require('../services/access');
const { getRole } = require('../services/tournamentRolesService');

const one = async (text, values = []) => (await query(text, values)).rows[0];
const many = async (text, values = []) => (await query(text, values)).rows;
const run = async (text, values = []) => (await query(text, values)).rowCount;

const listTeams = asyncHandler(async (req, res) => {
  const rows = await many('SELECT * FROM teams ORDER BY name', []);
  res.json({ teams: rows.map(map.team) });
});

const getTeam = asyncHandler(async (req, res) => {
  const row = await one('SELECT * FROM teams WHERE id = $1', [req.params.id]);
  if (!row) throw httpError(404, 'Team not found');
  res.json({ team: map.team(row) });
});

const createTeam = asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!body.name) throw httpError(400, 'name is required');
  const teamId = id();
  await run(
    `INSERT INTO teams (id, name, slug, short_name, primary_color, secondary_color, city, country, founded_year)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`
  , [teamId, body.name.trim(), body.slug || slugify(body.name), body.shortName || null, body.primaryColor || body.colors?.primary || null, body.secondaryColor || body.colors?.secondary || null, body.city || null, body.country || null, body.foundedYear || null]);
  res.status(201).json({ team: map.team(await one('SELECT * FROM teams WHERE id = $1', [teamId])) });
});

const updateTeam = asyncHandler(async (req, res) => {
  const row = await one('SELECT * FROM teams WHERE id = $1', [req.params.id]);
  if (!row) throw httpError(404, 'Team not found');
  const body = req.body || {};
  await run(
    `UPDATE teams SET name = $1, short_name = $2, primary_color = $3, secondary_color = $4, city = $5, country = $6, founded_year = $7
     WHERE id = $8`
  , [body.name ?? row.name, body.shortName ?? row.short_name, body.primaryColor ?? body.colors?.primary ?? row.primary_color, body.secondaryColor ?? body.colors?.secondary ?? row.secondary_color, body.city ?? row.city, body.country ?? row.country, body.foundedYear ?? row.founded_year, row.id]);
  res.json({ team: map.team(await one('SELECT * FROM teams WHERE id = $1', [row.id])) });
});

const removeTeam = asyncHandler(async (req, res) => {
  const info = await run('DELETE FROM teams WHERE id = $1', [req.params.id]);
  if (!info.rowCount) throw httpError(404, 'Team not found');
  res.status(204).end();
});

const listPlayers = asyncHandler(async (req, res) => {
  const rows = await many('SELECT * FROM players ORDER BY name', []);
  res.json({ players: rows.map(map.player) });
});

const getPlayer = asyncHandler(async (req, res) => {
  const row = await one('SELECT * FROM players WHERE id = $1', [req.params.id]);
  if (!row) throw httpError(404, 'Player not found');
  res.json({ player: map.player(row) });
});

const createPlayer = asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!body.name) throw httpError(400, 'name is required');
  const playerId = id();
  await run(
    `INSERT INTO players (id, name, slug, nickname, date_of_birth, nationality, position, preferred_foot, height_cm)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`
  , [playerId, body.name.trim(), body.slug || slugify(body.name), body.nickname || null, body.dateOfBirth || null, body.nationality || null, body.position || null, body.preferredFoot || null, body.heightCm || null]);
  res.status(201).json({ player: map.player(await one('SELECT * FROM players WHERE id = $1', [playerId])) });
});

const updatePlayer = asyncHandler(async (req, res) => {
  const row = await one('SELECT * FROM players WHERE id = $1', [req.params.id]);
  if (!row) throw httpError(404, 'Player not found');
  const body = req.body || {};
  await run(
    `UPDATE players SET name = $1, nickname = $2, date_of_birth = $3, nationality = $4, position = $5, preferred_foot = $6, height_cm = $7
     WHERE id = $8`
  , [body.name ?? row.name, body.nickname ?? row.nickname, body.dateOfBirth ?? row.date_of_birth, body.nationality ?? row.nationality, body.position ?? row.position, body.preferredFoot ?? row.preferred_foot, body.heightCm ?? row.height_cm, row.id]);
  res.json({ player: map.player(await one('SELECT * FROM players WHERE id = $1', [row.id])) });
});

const removePlayer = asyncHandler(async (req, res) => {
  const info = await run('DELETE FROM players WHERE id = $1', [req.params.id]);
  if (!info.rowCount) throw httpError(404, 'Player not found');
  res.status(204).end();
});

const participantJoinSql = `
  SELECT pt.*, t.name AS team_name, t.slug AS team_slug, t.primary_color, t.secondary_color
  FROM participant_teams pt
  JOIN teams t ON t.id = pt.team_id
`;

const addParticipantTeam = asyncHandler(async (req, res) => {
  const tournament = await access.getTournamentOrThrow(req.params.tournamentId);
  const { teamId, seed, nickname } = req.body || {};
  if (!teamId) throw httpError(400, 'teamId is required');
  const team = await one('SELECT * FROM teams WHERE id = $1', [teamId]);
  if (!team) throw httpError(404, 'Team not found');
  if (await one('SELECT 1 FROM participant_teams WHERE tournament_id = $1 AND team_id = $2', [tournament.id, teamId])) {
    throw httpError(409, 'Team is already registered in this tournament');
  }
  const ptId = id();
  await run(
    `INSERT INTO participant_teams (id, tournament_id, team_id, seed, nickname, status)
     VALUES ($1, $2, $3, $4, $5, 'registered')`
  , [ptId, tournament.id, teamId, seed ?? null, nickname || null]);
  const row = await one(`${participantJoinSql} WHERE pt.id = $1`, [ptId]);
  res.status(201).json({ participantTeam: map.participantTeam(row) });
});

const createTeamLeaderTeam = asyncHandler(async (req, res) => {
  const tournament = await access.getTournamentOrThrow(req.params.tournamentId);
  const userId = req.user.id;
  if (await getRole(tournament.id, userId) !== 'team_leader') {
    throw httpError(403, 'Assigned tournament team leader access required');
  }
  if (await one('SELECT 1 FROM tournament_team_leaders WHERE tournament_id = $1 AND user_id = $2', [tournament.id, userId])) {
    throw httpError(409, 'You already created a team for this tournament');
  }
  const body = req.body || {};
  if (!String(body.name || '').trim()) throw httpError(400, 'Team name is required');
  const teamId = id();
  const participantTeamId = id();
  const slug = body.slug || slugify(body.name);
  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO teams (id, name, slug, short_name, primary_color, secondary_color, city, country)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [teamId, body.name.trim(), slug, body.shortName || null, body.primaryColor || null,
          body.secondaryColor || null, body.city || null, body.country || null],
      );
      await client.query(
        `INSERT INTO participant_teams (id, tournament_id, team_id, nickname, status)
         VALUES ($1, $2, $3, $4, 'registered')`,
        [participantTeamId, tournament.id, teamId, body.nickname || null],
      );
      await client.query(
        `INSERT INTO tournament_team_leaders (tournament_id, user_id, participant_team_id)
         VALUES ($1, $2, $3)`,
        [tournament.id, userId, participantTeamId],
      );
    });
  } catch (error) {
    if (error.code === '23505') throw httpError(409, 'A team with this slug or ownership already exists');
    throw error;
  }
  const row = await one(`${participantJoinSql} WHERE pt.id = $1`, [participantTeamId]);
  res.status(201).json({ participantTeam: map.participantTeam(row) });
});

const getTeamLeaderTeam = asyncHandler(async (req, res) => {
  const tournament = await access.getTournamentOrThrow(req.params.tournamentId);
  if (await getRole(tournament.id, req.user.id) !== 'team_leader') {
    throw httpError(403, 'Assigned tournament team leader access required');
  }
  const row = await one(
    `${participantJoinSql} JOIN tournament_team_leaders ttl
     ON ttl.participant_team_id = pt.id
     WHERE ttl.tournament_id = $1 AND ttl.user_id = $2`
  , [tournament.id, req.user.id]);
  if (!row) return res.json({ participantTeam: null, participantPlayers: [] });
  const players = await many(`${playerJoinSql} WHERE pp.participant_team_id = $1 ORDER BY pp.shirt_number, p.name`, [row.id]);
  res.json({ participantTeam: map.participantTeam(row), participantPlayers: players.map(map.participantPlayer) });
});

async function teamLeaderOwnedTeam(tournamentId, userId, participantTeamId) {
  const row = await one(
    `SELECT pt.* FROM tournament_team_leaders ttl
     JOIN participant_teams pt ON pt.id = ttl.participant_team_id
     WHERE ttl.tournament_id = $1 AND ttl.user_id = $2 AND pt.id = $3`
  , [tournamentId, userId, participantTeamId]);
  if (!row) throw httpError(403, 'You can manage only your own tournament team');
  return row;
}

const addTeamLeaderPlayer = asyncHandler(async (req, res) => {
  const pt = await teamLeaderOwnedTeam(req.params.tournamentId, req.user.id, req.params.id);
  const count = Number((await one(
    'SELECT COUNT(*) AS count FROM participant_players WHERE participant_team_id = $1',
    [pt.id],
  )).count);
  if (count >= 11) throw httpError(409, 'A team leader can register at most 11 players');
  const body = req.body || {};
  if (!String(body.name || '').trim()) throw httpError(400, 'Player name is required');
  const playerId = id();
  const participantPlayerId = id();
  const slug = body.slug || slugify(body.name);
  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO players (id, name, slug, nickname, date_of_birth, nationality, position, preferred_foot, height_cm)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [playerId, body.name.trim(), slug, body.nickname || null, body.dateOfBirth || null,
          body.nationality || null, body.position || null, body.preferredFoot || null, body.heightCm || null],
      );
      await client.query(
        `INSERT INTO participant_players (id, participant_team_id, player_id, shirt_number, role, status)
         VALUES ($1, $2, $3, $4, $5, 'active')`,
        [participantPlayerId, pt.id, playerId, body.shirtNumber ?? null, body.role || 'player'],
      );
    });
  } catch (error) {
    if (error.code === '23505') throw httpError(409, 'A player with this slug already exists');
    throw error;
  }
  const row = await one(`${playerJoinSql} WHERE pp.id = $1`, [participantPlayerId]);
  res.status(201).json({ participantPlayer: map.participantPlayer(row) });
});

const autoAddParticipantTeams = asyncHandler(async (req, res) => {
  const tournament = await access.getTournamentOrThrow(req.params.tournamentId);
  const target = Number(req.body?.count ?? tournament.number_of_teams);
  if (!Number.isInteger(target) || target < 0) throw httpError(400, 'count must be a non-negative integer');

  const registered = await many('SELECT team_id FROM participant_teams WHERE tournament_id = $1', [tournament.id]);
  const registeredIds = new Set(registered.map((row) => row.team_id));
  let teams = await many('SELECT * FROM teams ORDER BY name', []);
  let nextNumber = teams.length + 1;

  while (teams.length < target) {
    let slug = `auto-team-${nextNumber}`;
    while (await one('SELECT 1 FROM teams WHERE slug = $1', [slug])) {
      nextNumber += 1;
      slug = `auto-team-${nextNumber}`;
    }
    const teamId = id();
    await run(
      'INSERT INTO teams (id, name, slug, short_name) VALUES ($1, $2, $3, $4)'
    , [teamId, `Team ${nextNumber}`, slug, `T${nextNumber}`]);
    teams.push(await one('SELECT * FROM teams WHERE id = $1', [teamId]));
    nextNumber += 1;
  }

  const missing = Math.max(0, target - registered.length);
  const available = teams.filter((team) => !registeredIds.has(team.id)).slice(0, missing);
  await Promise.all(available.map((team, index) => run(
    `INSERT INTO participant_teams (id, tournament_id, team_id, seed, status)
     VALUES ($1, $2, $3, $4, 'registered')`,
    [id(), tournament.id, team.id, registered.length + index + 1]
  )));

  const rows = await many(`${participantJoinSql} WHERE pt.tournament_id = $1 ORDER BY pt.seed, t.name`, [tournament.id]);
  res.status(201).json({ participantTeams: rows.map(map.participantTeam) });
});

const listParticipantTeams = asyncHandler(async (req, res) => {
  const tournament = await access.getTournamentOrThrow(req.params.tournamentId);
  await access.requireTournamentInspect(tournament, req.user);
  
  const rows = await many(
    `${participantJoinSql} WHERE pt.tournament_id = $1 ORDER BY pt.seed, t.name`,
    [tournament.id],
  );

  res.json({ participantTeams: rows.map(map.participantTeam) });
  

});

const updateParticipantTeam = asyncHandler(async (req, res) => {
  const row = await one('SELECT * FROM participant_teams WHERE id = $1', [req.params.id]);
  if (!row) throw httpError(404, 'Participant team not found');
  if (row.tournament_id !== req.params.tournamentId) throw httpError(404, 'Participant team not found');
  const body = req.body || {};
  await run(
    `UPDATE participant_teams SET seed = $1, nickname = $2, status = $3, group_id = $4 WHERE id = $5`
  , [body.seed ?? row.seed, body.nickname ?? row.nickname, body.status ?? row.status, body.groupId === undefined ? row.group_id : body.groupId, row.id]);
  const updated = await one(`${participantJoinSql} WHERE pt.id = $1`, [row.id]);
  res.json({ participantTeam: map.participantTeam(updated) });
});

const removeParticipantTeam = asyncHandler(async (req, res) => {
  const row = await one('SELECT tournament_id FROM participant_teams WHERE id = $1', [req.params.id]);
  if (!row || row.tournament_id !== req.params.tournamentId) throw httpError(404, 'Participant team not found');
  const info = await run('DELETE FROM participant_teams WHERE id = $1', [req.params.id]);
  if (!info.rowCount) throw httpError(404, 'Participant team not found');
  res.status(204).end();
});

const playerJoinSql = `
  SELECT pp.*, p.name AS player_name, p.slug AS player_slug, p.position AS player_position
  FROM participant_players pp
  JOIN players p ON p.id = pp.player_id
`;

const addParticipantPlayer = asyncHandler(async (req, res) => {
  const pt = await one('SELECT * FROM participant_teams WHERE id = $1', [req.params.id]);
  if (!pt) throw httpError(404, 'Participant team not found');
  if (pt.tournament_id !== req.params.tournamentId) throw httpError(404, 'Participant team not found');
  const body = req.body || {};
  if (!body.playerId) throw httpError(400, 'playerId is required');
  const player = await one('SELECT * FROM players WHERE id = $1', [body.playerId]);
  if (!player) throw httpError(404, 'Player not found');
  if (await one(
    `SELECT 1
     FROM participant_players pp
     JOIN participant_teams pt ON pt.id = pp.participant_team_id
     WHERE pt.tournament_id = $1 AND pp.player_id = $2`
  , [pt.tournament_id, body.playerId])) {
    throw httpError(409, 'Player is already registered in this tournament');
  }
  const ppId = id();
  await run(
    `INSERT INTO participant_players (id, participant_team_id, player_id, shirt_number, role, status)
     VALUES ($1, $2, $3, $4, $5, $6)`
  , [ppId, pt.id, body.playerId, body.shirtNumber ?? null, body.role || 'player', body.status || 'active']);
  const row = await one(`${playerJoinSql} WHERE pp.id = $1`, [ppId]);
  res.status(201).json({ participantPlayer: map.participantPlayer(row) });
});

const autoAddParticipantPlayers = asyncHandler(async (req, res) => {
  const participantTeam = await one('SELECT * FROM participant_teams WHERE id = $1', [req.params.id]);
  if (!participantTeam || participantTeam.tournament_id !== req.params.tournamentId) {
    throw httpError(404, 'Participant team not found');
  }
  const target = Number(req.body?.count);
  if (!Number.isInteger(target) || target < 0) throw httpError(400, 'count must be a non-negative integer');

  const existing = await many(
    `SELECT pp.player_id
     FROM participant_players pp
     JOIN participant_teams pt ON pt.id = pp.participant_team_id
     WHERE pt.tournament_id = $1`
  , [participantTeam.tournament_id]);
  const currentTeamCount = await one(
    'SELECT COUNT(*) AS count FROM participant_players WHERE participant_team_id = $1'
  , [participantTeam.id]).count;
  const existingIds = new Set(existing.map((row) => row.player_id));
  let players = await many('SELECT * FROM players ORDER BY name', []);
  let nextNumber = players.length + 1;
  const missing = Math.max(0, target - currentTeamCount);

  while (players.filter((player) => !existingIds.has(player.id)).length < missing) {
    let slug = `auto-player-${nextNumber}`;
    while (await one('SELECT 1 FROM players WHERE slug = $1', [slug])) {
      nextNumber += 1;
      slug = `auto-player-${nextNumber}`;
    }
    const playerId = id();
    await run(
      `INSERT INTO players (id, name, slug, nickname, position)
       VALUES ($1, $2, $3, $4, 'player')`
    , [playerId, `Player ${nextNumber}`, slug, `P${nextNumber}`]);
    players.push(await one('SELECT * FROM players WHERE id = $1', [playerId]));
    nextNumber += 1;
  }

  const available = players.filter((player) => !existingIds.has(player.id)).slice(0, missing);
  await Promise.all(available.map((player, index) => run(
    `INSERT INTO participant_players
       (id, participant_team_id, player_id, shirt_number, role, status)
     VALUES ($1, $2, $3, $4, 'player', 'active')`,
    [id(), participantTeam.id, player.id, currentTeamCount + index + 1]
  )));

  const rows = await many(`${playerJoinSql} WHERE pp.participant_team_id = $1 ORDER BY pp.shirt_number`, [participantTeam.id]);
  res.status(201).json({ participantPlayers: rows.map(map.participantPlayer) });
});

const listParticipantPlayers = asyncHandler(async (req, res) => {
  const pt = await one('SELECT * FROM participant_teams WHERE id = $1', [req.params.id]);
  if (!pt) throw httpError(404, 'Participant team not found');
  if (pt.tournament_id !== req.params.tournamentId) throw httpError(404, 'Participant team not found');
  const tournament = await access.getTournamentOrThrow(pt.tournament_id);
  await access.requireTournamentInspect(tournament, req.user);
  const rows = await many(`${playerJoinSql} WHERE pp.participant_team_id = $1 ORDER BY pp.shirt_number`, [pt.id]);
  res.json({ participantPlayers: rows.map(map.participantPlayer) });
});

const updateParticipantPlayer = asyncHandler(async (req, res) => {
  const row = await one('SELECT * FROM participant_players WHERE id = $1', [req.params.id]);
  if (!row) throw httpError(404, 'Participant player not found');
  const pt = await one('SELECT tournament_id FROM participant_teams WHERE id = $1', [row.participant_team_id]);
  if (!pt || pt.tournament_id !== req.params.tournamentId) throw httpError(404, 'Participant player not found');
  const body = req.body || {};
  await run(
    `UPDATE participant_players SET shirt_number = $1, role = $2, status = $3, yellow_cards = $4, red_cards = $5, goals = $6, assists = $7
     WHERE id = $8`
  , [body.shirtNumber ?? row.shirt_number, body.role ?? row.role, body.status ?? row.status, body.yellowCards ?? row.yellow_cards, body.redCards ?? row.red_cards, body.goals ?? row.goals, body.assists ?? row.assists, row.id]);
  res.json({
    participantPlayer: map.participantPlayer(await one(`${playerJoinSql} WHERE pp.id = $1`, [row.id])),
  });
});

const removeParticipantPlayer = asyncHandler(async (req, res) => {
  const row = await one(`
    SELECT pp.id, pt.tournament_id
    FROM participant_players pp
    JOIN participant_teams pt ON pt.id = pp.participant_team_id
    WHERE pp.id = $1
  `, [req.params.id]);
  if (!row || row.tournament_id !== req.params.tournamentId) throw httpError(404, 'Participant player not found');
  const info = await run('DELETE FROM participant_players WHERE id = $1', [req.params.id]);
  if (!info.rowCount) throw httpError(404, 'Participant player not found');
  res.status(204).end();
});

module.exports = {
  listTeams,
  getTeam,
  createTeam,
  updateTeam,
  removeTeam,
  listPlayers,
  getPlayer,
  createPlayer,
  updatePlayer,
  removePlayer,
  addParticipantTeam,
  createTeamLeaderTeam,
  getTeamLeaderTeam,
  addTeamLeaderPlayer,
  autoAddParticipantTeams,
  listParticipantTeams,
  updateParticipantTeam,
  removeParticipantTeam,
  addParticipantPlayer,
  autoAddParticipantPlayers,
  listParticipantPlayers,
  updateParticipantPlayer,
  removeParticipantPlayer,
};
