CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  email_verified BOOLEAN NOT NULL DEFAULT true,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE IF NOT EXISTS oauth_user_links (
  better_auth_user_id TEXT PRIMARY KEY,
  app_user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_exchange_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  settings TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

CREATE TABLE IF NOT EXISTS tournament_role (
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('referee', 'moderator', 'team_leader')),
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

CREATE TABLE IF NOT EXISTS participant_teams (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  short_name TEXT,
  primary_color TEXT,
  secondary_color TEXT,
  city TEXT,
  country TEXT,
  founded_year INTEGER,
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
  UNIQUE (tournament_id, slug)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_participant_teams_id_tournament
  ON participant_teams(id, tournament_id);

CREATE TABLE IF NOT EXISTS stage_draw_pot_assignments (
  stage_id TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  participant_team_id TEXT NOT NULL REFERENCES participant_teams(id) ON DELETE CASCADE,
  pot_number INTEGER NOT NULL CHECK (pot_number >= 1),
  pot_count INTEGER NOT NULL CHECK (pot_count >= 2),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stage_id, participant_team_id),
  CHECK (pot_number <= pot_count)
);
CREATE INDEX IF NOT EXISTS idx_stage_draw_pots_stage_pot
  ON stage_draw_pot_assignments(stage_id, pot_number);

CREATE TABLE IF NOT EXISTS tournament_team_leaders (
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_team_id TEXT NOT NULL UNIQUE REFERENCES participant_teams(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  PRIMARY KEY (tournament_id, user_id),
  UNIQUE (tournament_id, participant_team_id)
);

CREATE TABLE IF NOT EXISTS participant_players (
  id TEXT PRIMARY KEY,
  participant_team_id TEXT NOT NULL REFERENCES participant_teams(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL REFERENCES users(id),
  joined_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  nickname TEXT,
  date_of_birth TEXT,
  nationality TEXT,
  position TEXT,
  preferred_foot TEXT,
  height_cm INTEGER,
  shirt_number INTEGER,
  role TEXT DEFAULT 'player' CHECK (role IN ('player', 'captain', 'goalkeeper')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'injured', 'suspended', 'ineligible')),
  yellow_cards INTEGER NOT NULL DEFAULT 0,
  red_cards INTEGER NOT NULL DEFAULT 0,
  goals INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  UNIQUE (participant_team_id, slug)
);

ALTER TABLE participant_players
 ADD COLUMN IF NOT EXISTS joined_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_participant_players_joined_user
 ON participant_players(joined_by_user_id)
 WHERE joined_by_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS participant_player_invite_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  participant_team_id TEXT NOT NULL,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (participant_team_id, tournament_id)
    REFERENCES participant_teams(id, tournament_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_player_invite_codes_team_expiry
  ON participant_player_invite_codes(participant_team_id, expires_at);

CREATE TABLE IF NOT EXISTS participant_player_invite_attempts (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('issue', 'redeem')),
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_player_invite_attempts_user_action_time
  ON participant_player_invite_attempts(user_id, action, attempted_at);
CREATE INDEX IF NOT EXISTS idx_player_invite_attempts_time
  ON participant_player_invite_attempts(attempted_at);

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
    CHECK (status IN ('scheduled', 'live', 'paused', 'finished', 'postponed', 'cancelled')),
  home_score INTEGER,
  away_score INTEGER,
  extra_time_home INTEGER,
  extra_time_away INTEGER,
  penalties_home INTEGER,
  penalties_away INTEGER,
  referee_id TEXT REFERENCES users(id),
  duration_minutes INTEGER,
  phase TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (phase IN ('scheduled', 'regulation', 'extra_time', 'shootout', 'finished', 'abandoned')),
  phase_started_at TEXT,
  phase_elapsed_seconds INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

CREATE TABLE IF NOT EXISTS match_audit (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  reason TEXT,
  before_state TEXT NOT NULL DEFAULT '{}',
  after_state TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
CREATE INDEX IF NOT EXISTS idx_match_audit_match ON match_audit(match_id, created_at);

CREATE TABLE IF NOT EXISTS match_events (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('goal', 'assist', 'card', 'phase', 'shootout_attempt')),
  phase TEXT NOT NULL CHECK (phase IN ('regulation', 'extra_time', 'shootout')),
  goal_event_id TEXT REFERENCES match_events(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES participant_teams(id),
  player_id TEXT REFERENCES participant_players(id) ON DELETE SET NULL,
  assister_id TEXT REFERENCES participant_players(id) ON DELETE SET NULL,
  card TEXT CHECK (card IN ('yellow', 'red')),
  scored BOOLEAN,
  minute INTEGER,
  payload TEXT NOT NULL DEFAULT '{}',
  client_event_id TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  UNIQUE (match_id, client_event_id)
);
CREATE INDEX IF NOT EXISTS idx_match_events_match ON match_events(match_id, created_at);
CREATE INDEX IF NOT EXISTS idx_match_events_goal ON match_events(goal_event_id);

CREATE TABLE IF NOT EXISTS player_match_suspensions (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  participant_player_id TEXT NOT NULL REFERENCES participant_players(id) ON DELETE CASCADE,
  target_match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  source_match_id TEXT REFERENCES matches(id) ON DELETE SET NULL,
  source_event_id TEXT REFERENCES match_events(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('yellow_threshold', 'red_card')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'excluded', 'included', 'consumed')),
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  UNIQUE (participant_player_id, target_match_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_player_match_suspensions_target
  ON player_match_suspensions(target_match_id, participant_player_id);

CREATE TABLE IF NOT EXISTS tournament_follows (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
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
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  UNIQUE (source_stage_id, participant_team_id)
);

CREATE TABLE IF NOT EXISTS vote (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  award TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'finished')),
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

CREATE TABLE IF NOT EXISTS vote_nominees (
  nominee_id TEXT NOT NULL REFERENCES participant_players(id) ON DELETE CASCADE,
  vote_id TEXT NOT NULL REFERENCES vote(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  votes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vote_id, nominee_id)
);

CREATE TABLE IF NOT EXISTS vote_ballots (
  vote_id TEXT NOT NULL REFERENCES vote(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nominee_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  PRIMARY KEY (vote_id, user_id),
  FOREIGN KEY (vote_id, nominee_id)
    REFERENCES vote_nominees(vote_id, nominee_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stages_tournament ON stages(tournament_id);
CREATE INDEX IF NOT EXISTS idx_groups_stage ON groups(stage_id);
CREATE INDEX IF NOT EXISTS idx_pt_tournament ON participant_teams(tournament_id);
CREATE INDEX IF NOT EXISTS idx_pt_creator ON participant_teams(creator_id);
CREATE INDEX IF NOT EXISTS idx_pp_creator ON participant_players(creator_id);
CREATE INDEX IF NOT EXISTS idx_matches_tournament ON matches(tournament_id);
CREATE INDEX IF NOT EXISTS idx_matches_tournament_schedule
  ON matches(tournament_id, matchday, created_at);
CREATE INDEX IF NOT EXISTS idx_match_events_match_created
  ON match_events(match_id, created_at);
CREATE INDEX IF NOT EXISTS idx_follows_tournament ON tournament_follows(tournament_id);
CREATE INDEX IF NOT EXISTS idx_follows_user_status
  ON tournament_follows(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tournament_roles_user
  ON tournament_role(user_id, tournament_id);
CREATE INDEX IF NOT EXISTS idx_stage_promotions_source ON stage_promotions(source_stage_id);
CREATE INDEX IF NOT EXISTS idx_stage_promotions_target ON stage_promotions(target_stage_id);
CREATE INDEX IF NOT EXISTS idx_vote_tournament ON vote(tournament_id);
CREATE INDEX IF NOT EXISTS idx_vote_nominees_vote ON vote_nominees(vote_id);
CREATE INDEX IF NOT EXISTS idx_vote_ballots_vote ON vote_ballots(vote_id);
CREATE INDEX IF NOT EXISTS idx_tournaments_public_recent
  ON tournaments(visibility, created_at DESC);
