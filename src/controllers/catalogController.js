const { db } = require('../db');
const { id, slugify } = require('../utils/ids');
const { asyncHandler } = require('../utils/asyncHandler');
const { httpError } = require('../middleware/error');
const map = require('../services/mappers');
const access = require('../services/access');

const listTeams = asyncHandler((req, res) => {
  const rows = db.prepare('SELECT * FROM teams ORDER BY name').all();
  res.json({ teams: rows.map(map.team) });
});

const getTeam = asyncHandler((req, res) => {
  const row = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Team not found');
  res.json({ team: map.team(row) });
});

const createTeam = asyncHandler((req, res) => {
  const body = req.body || {};
  if (!body.name) throw httpError(400, 'name is required');
  const teamId = id();
  db.prepare(
    `INSERT INTO teams (id, name, slug, short_name, primary_color, secondary_color, city, country, founded_year)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    teamId,
    body.name.trim(),
    body.slug || slugify(body.name),
    body.shortName || null,
    body.primaryColor || body.colors?.primary || null,
    body.secondaryColor || body.colors?.secondary || null,
    body.city || null,
    body.country || null,
    body.foundedYear || null
  );
  res.status(201).json({ team: map.team(db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId)) });
});

const updateTeam = asyncHandler((req, res) => {
  const row = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Team not found');
  const body = req.body || {};
  db.prepare(
    `UPDATE teams SET name = ?, short_name = ?, primary_color = ?, secondary_color = ?, city = ?, country = ?, founded_year = ?
     WHERE id = ?`
  ).run(
    body.name ?? row.name,
    body.shortName ?? row.short_name,
    body.primaryColor ?? body.colors?.primary ?? row.primary_color,
    body.secondaryColor ?? body.colors?.secondary ?? row.secondary_color,
    body.city ?? row.city,
    body.country ?? row.country,
    body.foundedYear ?? row.founded_year,
    row.id
  );
  res.json({ team: map.team(db.prepare('SELECT * FROM teams WHERE id = ?').get(row.id)) });
});

const removeTeam = asyncHandler((req, res) => {
  const info = db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.id);
  if (!info.changes) throw httpError(404, 'Team not found');
  res.status(204).end();
});

const listPlayers = asyncHandler((req, res) => {
  const rows = db.prepare('SELECT * FROM players ORDER BY name').all();
  res.json({ players: rows.map(map.player) });
});

const getPlayer = asyncHandler((req, res) => {
  const row = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Player not found');
  res.json({ player: map.player(row) });
});

const createPlayer = asyncHandler((req, res) => {
  const body = req.body || {};
  if (!body.name) throw httpError(400, 'name is required');
  const playerId = id();
  db.prepare(
    `INSERT INTO players (id, name, slug, nickname, date_of_birth, nationality, position, preferred_foot, height_cm)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    playerId,
    body.name.trim(),
    body.slug || slugify(body.name),
    body.nickname || null,
    body.dateOfBirth || null,
    body.nationality || null,
    body.position || null,
    body.preferredFoot || null,
    body.heightCm || null
  );
  res.status(201).json({ player: map.player(db.prepare('SELECT * FROM players WHERE id = ?').get(playerId)) });
});

const updatePlayer = asyncHandler((req, res) => {
  const row = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Player not found');
  const body = req.body || {};
  db.prepare(
    `UPDATE players SET name = ?, nickname = ?, date_of_birth = ?, nationality = ?, position = ?, preferred_foot = ?, height_cm = ?
     WHERE id = ?`
  ).run(
    body.name ?? row.name,
    body.nickname ?? row.nickname,
    body.dateOfBirth ?? row.date_of_birth,
    body.nationality ?? row.nationality,
    body.position ?? row.position,
    body.preferredFoot ?? row.preferred_foot,
    body.heightCm ?? row.height_cm,
    row.id
  );
  res.json({ player: map.player(db.prepare('SELECT * FROM players WHERE id = ?').get(row.id)) });
});

const removePlayer = asyncHandler((req, res) => {
  const info = db.prepare('DELETE FROM players WHERE id = ?').run(req.params.id);
  if (!info.changes) throw httpError(404, 'Player not found');
  res.status(204).end();
});

const participantJoinSql = `
  SELECT pt.*, t.name AS team_name, t.slug AS team_slug, t.primary_color, t.secondary_color
  FROM participant_teams pt
  JOIN teams t ON t.id = pt.team_id
`;

const addParticipantTeam = asyncHandler((req, res) => {
  const tournament = access.getTournamentOrThrow(req.params.tournamentId);
  const { teamId, seed, nickname } = req.body || {};
  if (!teamId) throw httpError(400, 'teamId is required');
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!team) throw httpError(404, 'Team not found');
  const ptId = id();
  db.prepare(
    `INSERT INTO participant_teams (id, tournament_id, team_id, seed, nickname, status)
     VALUES (?, ?, ?, ?, ?, 'registered')`
  ).run(ptId, tournament.id, teamId, seed ?? null, nickname || null);
  const row = db.prepare(`${participantJoinSql} WHERE pt.id = ?`).get(ptId);
  res.status(201).json({ participantTeam: map.participantTeam(row) });
});

const listParticipantTeams = asyncHandler((req, res) => {
  const tournament = access.getTournamentOrThrow(req.params.tournamentId);
  access.requireTournamentInspect(tournament, req.user);
  const rows = db
    .prepare(`${participantJoinSql} WHERE pt.tournament_id = ? ORDER BY pt.seed, t.name`)
    .all(tournament.id);
  res.json({ participantTeams: rows.map(map.participantTeam) });
});

const updateParticipantTeam = asyncHandler((req, res) => {
  const row = db.prepare('SELECT * FROM participant_teams WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Participant team not found');
  const body = req.body || {};
  db.prepare(
    `UPDATE participant_teams SET seed = ?, nickname = ?, status = ?, group_id = ? WHERE id = ?`
  ).run(
    body.seed ?? row.seed,
    body.nickname ?? row.nickname,
    body.status ?? row.status,
    body.groupId === undefined ? row.group_id : body.groupId,
    row.id
  );
  const updated = db.prepare(`${participantJoinSql} WHERE pt.id = ?`).get(row.id);
  res.json({ participantTeam: map.participantTeam(updated) });
});

const removeParticipantTeam = asyncHandler((req, res) => {
  const info = db.prepare('DELETE FROM participant_teams WHERE id = ?').run(req.params.id);
  if (!info.changes) throw httpError(404, 'Participant team not found');
  res.status(204).end();
});

const playerJoinSql = `
  SELECT pp.*, p.name AS player_name, p.slug AS player_slug, p.position AS player_position
  FROM participant_players pp
  JOIN players p ON p.id = pp.player_id
`;

const addParticipantPlayer = asyncHandler((req, res) => {
  const pt = db.prepare('SELECT * FROM participant_teams WHERE id = ?').get(req.params.id);
  if (!pt) throw httpError(404, 'Participant team not found');
  const body = req.body || {};
  if (!body.playerId) throw httpError(400, 'playerId is required');
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(body.playerId);
  if (!player) throw httpError(404, 'Player not found');
  const ppId = id();
  db.prepare(
    `INSERT INTO participant_players (id, participant_team_id, player_id, shirt_number, role, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    ppId,
    pt.id,
    body.playerId,
    body.shirtNumber ?? null,
    body.role || 'player',
    body.status || 'active'
  );
  const row = db.prepare(`${playerJoinSql} WHERE pp.id = ?`).get(ppId);
  res.status(201).json({ participantPlayer: map.participantPlayer(row) });
});

const listParticipantPlayers = asyncHandler((req, res) => {
  const pt = db.prepare('SELECT * FROM participant_teams WHERE id = ?').get(req.params.id);
  if (!pt) throw httpError(404, 'Participant team not found');
  const tournament = access.getTournamentOrThrow(pt.tournament_id);
  access.requireTournamentInspect(tournament, req.user);
  const rows = db.prepare(`${playerJoinSql} WHERE pp.participant_team_id = ? ORDER BY pp.shirt_number`).all(pt.id);
  res.json({ participantPlayers: rows.map(map.participantPlayer) });
});

const updateParticipantPlayer = asyncHandler((req, res) => {
  const row = db.prepare('SELECT * FROM participant_players WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Participant player not found');
  const body = req.body || {};
  db.prepare(
    `UPDATE participant_players SET shirt_number = ?, role = ?, status = ?, yellow_cards = ?, red_cards = ?, goals = ?, assists = ?
     WHERE id = ?`
  ).run(
    body.shirtNumber ?? row.shirt_number,
    body.role ?? row.role,
    body.status ?? row.status,
    body.yellowCards ?? row.yellow_cards,
    body.redCards ?? row.red_cards,
    body.goals ?? row.goals,
    body.assists ?? row.assists,
    row.id
  );
  res.json({
    participantPlayer: map.participantPlayer(db.prepare(`${playerJoinSql} WHERE pp.id = ?`).get(row.id)),
  });
});

const removeParticipantPlayer = asyncHandler((req, res) => {
  const info = db.prepare('DELETE FROM participant_players WHERE id = ?').run(req.params.id);
  if (!info.changes) throw httpError(404, 'Participant player not found');
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
  listParticipantTeams,
  updateParticipantTeam,
  removeParticipantTeam,
  addParticipantPlayer,
  listParticipantPlayers,
  updateParticipantPlayer,
  removeParticipantPlayer,
};
