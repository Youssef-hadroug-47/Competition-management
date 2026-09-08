const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { db, now } = require('../src/db');
const { id, slugify } = require('../src/utils/ids');
const map = require('../src/services/mappers');

function upsertUser(email, name, role, password) {
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) return existing;
  const userId = id();
  db.prepare(
    'INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, email, bcrypt.hashSync(password, 10), name, role);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

const admin = upsertUser('admin@tournament.local', 'Admin', 'admin', 'admin123');
upsertUser('referee@tournament.local', 'Referee', 'referee', 'referee123');
upsertUser('user@tournament.local', 'Fan', 'user', 'user123');

function addTeam(name, colors) {
  const existing = db.prepare('SELECT * FROM teams WHERE name = ?').get(name);
  if (existing) return existing;
  const teamId = id();
  db.prepare(
    `INSERT INTO teams (id, name, slug, short_name, primary_color, secondary_color, country)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(teamId, name, slugify(name), name.slice(0, 3).toUpperCase(), colors[0], colors[1], 'Sample');
  return db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
}

const teamNames = [
  ['Atlas FC', ['#1d4ed8', '#ffffff']],
  ['River United', ['#dc2626', '#111827']],
  ['Coastal SC', ['#0f766e', '#fbbf24']],
  ['Highland Rovers', ['#166534', '#e5e7eb']],
];
const teams = teamNames.map(([n, c]) => addTeam(n, c));

function addPlayer(name, position) {
  const existing = db.prepare('SELECT * FROM players WHERE name = ?').get(name);
  if (existing) return existing;
  const playerId = id();
  db.prepare(
    `INSERT INTO players (id, name, slug, position, nationality) VALUES (?, ?, ?, ?, ?)`
  ).run(playerId, name, slugify(name), position, 'Sample');
  return db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
}

const players = [
  addPlayer('Samir Kadri', 'forward'),
  addPlayer('Lina Benali', 'midfielder'),
  addPlayer('Omar Chen', 'defender'),
  addPlayer('Maya Rossi', 'goalkeeper'),
];

const existingT = db.prepare('SELECT * FROM tournaments WHERE name = ?').get('Spring Cup');
if (!existingT) {
  const tournamentId = id();
  db.prepare(
    `INSERT INTO tournaments (id, name, slug, status, visibility, format, number_of_teams, place, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'registration', 'public', 'stages', 4, 'Tunis', ?, ?, ?)`
  ).run(tournamentId, 'Spring Cup', slugify('Spring Cup'), admin.id, now(), now());

  const stageId = id();
  db.prepare(
    `INSERT INTO stages (id, tournament_id, type, sequence_order, settings) VALUES (?, ?, 'league', 1, ?)`
  ).run(stageId, tournamentId, JSON.stringify(map.defaultStageSettings('league')));

  db.prepare(`INSERT INTO groups (id, stage_id, name, sequence_order) VALUES (?, ?, 'Group A', 1)`).run(
    id(),
    stageId
  );

  teams.forEach((t, i) => {
    db.prepare(
      `INSERT INTO participant_teams (id, tournament_id, team_id, seed, status) VALUES (?, ?, ?, ?, 'registered')`
    ).run(id(), tournamentId, t.id, i + 1);
  });

  const firstPt = db.prepare('SELECT * FROM participant_teams WHERE tournament_id = ?').get(tournamentId);
  players.forEach((p, i) => {
    db.prepare(
      `INSERT INTO participant_players (id, participant_team_id, player_id, shirt_number, role)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id(), firstPt.id, p.id, i + 1, i === 0 ? 'captain' : 'player');
  });
}

console.log('Seed complete.');
console.log('Admin:   admin@tournament.local / admin123');
console.log('Referee: referee@tournament.local / referee123');
console.log('User:    user@tournament.local / user123');
