const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

const dir = path.dirname(path.resolve(config.dbPath));
fs.mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(path.resolve(config.dbPath));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

const matchColumns = db.prepare('PRAGMA table_info(matches)').all().map((column) => column.name);
if (!matchColumns.includes('revision')) {
  db.exec(`ALTER TABLE matches ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS match_audit (
    id TEXT PRIMARY KEY,
    match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id),
    action TEXT NOT NULL,
    reason TEXT,
    before_state TEXT NOT NULL DEFAULT '{}',
    after_state TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_match_audit_match ON match_audit(match_id, created_at);
`);

const voteSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vote'").get()?.sql || '';
if (voteSql && !voteSql.includes('finished_at')) {
  db.exec(`
    ALTER TABLE vote RENAME TO vote_legacy;
    CREATE TABLE vote (
      id TEXT PRIMARY KEY,
      tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      award TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'finished')),
      finished_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO vote (id, tournament_id, name, award)
      SELECT id, tournament_id, name, award FROM vote_legacy;
    DROP TABLE vote_legacy;
    CREATE INDEX IF NOT EXISTS idx_vote_tournament ON vote(tournament_id);
  `);

  const migratedMatchColumns = db.prepare('PRAGMA table_info(matches)').all().map((column) => column.name);
  for (const [name, definition] of [
    ['duration_minutes', 'INTEGER'],
    ['phase', "TEXT NOT NULL DEFAULT 'scheduled'"],
    ['phase_started_at', 'TEXT'],
    ['phase_elapsed_seconds', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    if (!migratedMatchColumns.includes(name)) db.exec(`ALTER TABLE matches ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS match_events (
      id TEXT PRIMARY KEY,
      match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('goal', 'assist', 'card', 'phase', 'shootout_attempt')),
      phase TEXT NOT NULL CHECK (phase IN ('regulation', 'extra_time', 'shootout')),
      team_id TEXT REFERENCES participant_teams(id),
      player_id TEXT REFERENCES participant_players(id),
      assister_id TEXT REFERENCES participant_players(id),
      card TEXT CHECK (card IN ('yellow', 'red')),
      scored BOOLEAN,
      minute INTEGER,
      payload TEXT NOT NULL DEFAULT '{}',
      client_event_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (match_id, client_event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_match_events_match ON match_events(match_id, created_at);
  `);
}

const matchEventsSql = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'match_events'"
).get()?.sql || '';
if (matchEventsSql && !matchEventsSql.includes("'assist'")) {
  db.exec(`
    ALTER TABLE match_events RENAME TO match_events_legacy;
    CREATE TABLE match_events (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('goal', 'assist', 'card', 'phase', 'shootout_attempt')),
        phase TEXT NOT NULL CHECK (phase IN ('regulation', 'extra_time', 'shootout')),
        team_id TEXT REFERENCES participant_teams(id),
        player_id TEXT REFERENCES participant_players(id),
        assister_id TEXT REFERENCES participant_players(id),
        card TEXT CHECK (card IN ('yellow', 'red')),
        scored BOOLEAN,
        minute INTEGER,
        payload TEXT NOT NULL DEFAULT '{}',
        client_event_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (match_id, client_event_id)
    );
    INSERT INTO match_events
      (id, match_id, tournament_id, type, phase, team_id, player_id, assister_id, card, scored, minute, payload, client_event_id, created_at)
      SELECT id, match_id, tournament_id, type, phase, team_id, player_id, assister_id, card, scored, minute, payload, client_event_id, created_at
      FROM match_events_legacy;
    DROP TABLE match_events_legacy;
    CREATE INDEX IF NOT EXISTS idx_match_events_match ON match_events(match_id, created_at);
  `);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS vote_ballots (
    vote_id TEXT NOT NULL REFERENCES vote(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nominee_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (vote_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_vote_ballots_vote ON vote_ballots(vote_id);
`);

// Existing installations may have created the matches table before the
// paused lifecycle state was introduced. SQLite cannot alter a CHECK
// constraint in place, so migrate that table once while preserving rows.
const matchesSql = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'matches'"
).get()?.sql || '';
if (matchesSql && !matchesSql.includes("'paused'")) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE matches RENAME TO matches_legacy;
    CREATE TABLE matches (
      id TEXT PRIMARY KEY,
      tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      stage_id TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
      group_id TEXT,
      matchday INTEGER,
      home_participant_team_id TEXT REFERENCES participant_teams(id),
      away_participant_team_id TEXT REFERENCES participant_teams(id),
      venue TEXT,
      scheduled_at TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'live', 'paused', 'finished', 'postponed', 'cancelled')),
      home_score INTEGER,
      away_score INTEGER,
      extra_time_home INTEGER,
      extra_time_away INTEGER,
      penalties_home INTEGER,
      penalties_away INTEGER,
      referee_id TEXT REFERENCES users(id),
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO matches (
      id, tournament_id, stage_id, group_id, matchday,
      home_participant_team_id, away_participant_team_id, venue, scheduled_at,
      status, home_score, away_score, extra_time_home, extra_time_away,
      penalties_home, penalties_away, referee_id, started_at, finished_at, created_at
    )
    SELECT
      id, tournament_id, stage_id, group_id, matchday,
      home_participant_team_id, away_participant_team_id, venue, scheduled_at,
      status, home_score, away_score, extra_time_home, extra_time_away,
      penalties_home, penalties_away, referee_id, started_at, finished_at, created_at
    FROM matches_legacy;
    DROP TABLE matches_legacy;
    PRAGMA foreign_keys = ON;
  `);
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function parseJson(value, fallback = {}) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

module.exports = { db, now, parseJson };
