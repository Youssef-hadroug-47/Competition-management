PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'registration', 'draw_complete', 'in_progress', 'completed', 'cancelled')),
  visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'private')),
  -- format TEXT NOT NULL DEFAULT 'stages'
    -- CHECK (format IN ('stages', 'groups', 'division', 'league', 'knockout', 'custom')),
  number_of_teams INTEGER NOT NULL DEFAULT 0,
  place TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tournament_role (
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('referee', 'moderator')),
  UNIQUE(tournament_id, user_id)
);


CREATE TABLE IF NOT EXISTS stages (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('league', 'knockout')),
  sequence_order INTEGER NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  status TEXT CHECK (status IN ('finished')),
  UNIQUE (tournament_id, sequence_order)
);

CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  name TEXT NOT NULL, 
  sequence_order INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  promotion_rules TEXT NOT NULL DEFAULT '[]',
  sequence_order INTEGER NOT NULL DEFAULT 1,
  number_teams INTEGER NOT NULL CHECK ( number_teams >= 3 ),
  advancing_teams INTEGER NOT NULL DEFAULT 0 CHECK (advancing_teams < number_teams),
  advancing_teams_to_ranking INTEGER NOT NULL DEFAULT 0
    CHECK (advancing_teams + advancing_teams_to_ranking <= number_teams)
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  short_name TEXT,
  primary_color TEXT,
  secondary_color TEXT,
  city TEXT,
  country TEXT,
  founded_year INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  nickname TEXT,
  date_of_birth TEXT,
  nationality TEXT,
  position TEXT,
  preferred_foot TEXT,
  height_cm INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS participant_teams (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id),
  group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
  seed INTEGER,
  nickname TEXT,
  status TEXT NOT NULL DEFAULT 'registered'
    CHECK (status IN ('registered', 'drawn', 'active', 'eliminated', 'champion', 'withdrawn')),
  played INTEGER NOT NULL DEFAULT 0,
  winner BOOLEAN NOT NULL DEFAULT false,
  won INTEGER NOT NULL DEFAULT 0,
  drawn INTEGER NOT NULL DEFAULT 0,
  lost INTEGER NOT NULL DEFAULT 0,
  goals_for INTEGER NOT NULL DEFAULT 0,
  goals_against INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  UNIQUE (tournament_id, team_id)
);

CREATE TABLE IF NOT EXISTS participant_players (
  id TEXT PRIMARY KEY,
  participant_team_id TEXT NOT NULL REFERENCES participant_teams(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id),
  shirt_number INTEGER,
  role TEXT DEFAULT 'player' CHECK (role IN ('player', 'captain', 'goalkeeper')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'injured', 'suspended', 'ineligible')),
  yellow_cards INTEGER NOT NULL DEFAULT 0,
  red_cards INTEGER NOT NULL DEFAULT 0,
  goals INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,
  UNIQUE (participant_team_id, player_id)
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  -- Points at a groups.id (league stage) or a rounds.id (knockout stage),
  -- depending on the parent stage's type — so it can't have a single-table
  -- FK. Application code clears it when the referenced group/round is
  -- deleted (see removeGroup/removeRound in tournamentController.js).
  group_id TEXT,
  matchday INTEGER,
  home_participant_team_id TEXT REFERENCES participant_teams(id),
  away_participant_team_id TEXT REFERENCES participant_teams(id),
  venue TEXT,
  scheduled_at TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'live', 'finished', 'postponed', 'cancelled')),
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

CREATE TABLE IF NOT EXISTS tournament_follows (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tournament_id, user_id)
);

-- Promotions used to be computed on the fly at draw time by walking back to
-- the immediately preceding stage. A group's promotion_rules can now route
-- different rank ranges to different, arbitrary target stages, and the
-- decision is made once — when the source stage finishes — rather than at
-- draw time. This table is that persisted decision; draws for a stage read
-- their incoming participants from here (WHERE target_stage_id = ?).
CREATE TABLE IF NOT EXISTS stage_promotions (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  source_stage_id TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  target_stage_id TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  participant_team_id TEXT NOT NULL REFERENCES participant_teams(id) ON DELETE CASCADE,
  via_rank BOOLEAN NOT NULL DEFAULT false,
  rank_position INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_stage_id, participant_team_id)
);

CREATE TABLE IF NOT EXISTS vote (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  award TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vote_nominees (
  nominee_id TEXT NOT NULL REFERENCES participant_players(id) ON DELETE CASCADE,
  vote_id TEXT NOT NULL REFERENCES vote(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  votes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, vote_id)
);

CREATE INDEX IF NOT EXISTS idx_stages_tournament ON stages(tournament_id);
CREATE INDEX IF NOT EXISTS idx_groups_stage ON groups(stage_id);
CREATE INDEX IF NOT EXISTS idx_pt_tournament ON participant_teams(tournament_id);
CREATE INDEX IF NOT EXISTS idx_matches_tournament ON matches(tournament_id);
CREATE INDEX IF NOT EXISTS idx_follows_tournament ON tournament_follows(tournament_id);
CREATE INDEX IF NOT EXISTS idx_stage_promotions_source ON stage_promotions(source_stage_id);
CREATE INDEX IF NOT EXISTS idx_stage_promotions_target ON stage_promotions(target_stage_id);
CREATE INDEX IF NOT EXISTS idx_vote_tournament ON vote(tournament_id);
CREATE INDEX IF NOT EXISTS idx_vote_nominees_vote ON vote_nominees(vote_id);
