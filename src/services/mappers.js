const { parseJson } = require('../db');

function userPublic(row) {
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role, createdAt: row.created_at };
}

function tournament(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    visibility: row.visibility,
    // format: row.format,
    numberOfTeams: row.number_of_teams,
    place: row.place,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stage(row) {
  if (!row) return null;
  return {
    id: row.id,
    tournamentId: row.tournament_id,
    type: row.type,
    sequenceOrder: row.sequence_order,
    settings: parseJson(row.settings, defaultStageSettings(row.type)),
  };
}

function defaultStageSettings(type) {
  const base = {
    headToHeadMatches: 1,
    extraTime: type === 'knockout',
    penalties: type === 'knockout',
    suspensionSystem: {
      enabled: true,
      yellowCardsForSuspension: 2,
      redCardMissedMatches: 1,
    },
    advancingTeamsFromRanking: type == 'league' ? 0 : null,
    points: type == 'league' ? { win: 3, draw: 1, loss: 0 } : null,
    tiebreakers: type === 'league'
      ? [
          { type: 'points', priority: 1},
          { type: 'head_to_head', priority: 1},
          { type: 'goal_difference', priority: 2 },
          { type: 'goals_for', priority: 3 },
          { type: 'sportsmanlike', priority: 4 },
        ]
      : [],
  };
  return base;
}

function group(row) {
  if (!row) return null;
  return {
    id: row.id,
    stageId: row.stage_id,
    name: row.name,
    sequenceOrder: row.sequence_order,
    numberOfTeams: row.number_teams,
    promotionRules: row.promotion_rules,
  };
}

function round(row) {
  if (!row) return null;
  return {
    id: row.id,
    stageId: row.stage_id,
    name: row.name,
    sequenceOrder: row.sequence_order,
  };
}

function team(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    shortName: row.short_name,
    colors: { primary: row.primary_color, secondary: row.secondary_color },
    city: row.city,
    country: row.country,
    foundedYear: row.founded_year,
    createdAt: row.created_at,
  };
}

function player(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    nickname: row.nickname,
    dateOfBirth: row.date_of_birth,
    nationality: row.nationality,
    position: row.position,
    preferredFoot: row.preferred_foot,
    heightCm: row.height_cm,
    createdAt: row.created_at,
  };
}

function participantTeam(row) {
  if (!row) return null;
  return {
    id: row.id,
    tournamentId: row.tournament_id,
    teamId: row.team_id,
    groupId: row.group_id,
    seed: row.seed,
    nickname: row.nickname,
    status: row.status,
    stats: {
      played: row.played,
      won: row.won,
      drawn: row.drawn,
      lost: row.lost,
      goalsFor: row.goals_for,
      goalsAgainst: row.goals_against,
      goalDifference: row.goals_for - row.goals_against,
      points: row.points,
    },
    team: row.team_name
      ? {
          id: row.team_id,
          name: row.team_name,
          slug: row.team_slug,
          colors: { primary: row.primary_color, secondary: row.secondary_color },
        }
      : undefined,
  };
}

function participantPlayer(row) {
  if (!row) return null;
  return {
    id: row.id,
    participantTeamId: row.participant_team_id,
    playerId: row.player_id,
    shirtNumber: row.shirt_number,
    role: row.role,
    status: row.status,
    yellowCards: row.yellow_cards,
    redCards: row.red_cards,
    goals: row.goals,
    assists: row.assists,
    player: row.player_name
      ? { id: row.player_id, name: row.player_name, slug: row.player_slug, position: row.player_position }
      : undefined,
  };
}

function match(row) {
  if (!row) return null;
  return {
    id: row.id,
    tournamentId: row.tournament_id,
    stageId: row.stage_id,
    groupId: row.group_id,
    matchday: row.matchday,
    homeParticipantTeamId: row.home_participant_team_id,
    awayParticipantTeamId: row.away_participant_team_id,
    venue: row.venue,
    scheduledAt: row.scheduled_at,
    status: row.status,
    score: {
      home: row.home_score,
      away: row.away_score,
      extraTimeHome: row.extra_time_home,
      extraTimeAway: row.extra_time_away,
      penaltiesHome: row.penalties_home,
      penaltiesAway: row.penalties_away,
    },
    refereeId: row.referee_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

function follow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tournamentId: row.tournament_id,
    userId: row.user_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

function vote(row) {
  if (!row) return null;
  return {
    id: row.id,
    tournamentId: row.tournament_id,
    name: row.name,
    award: row.award,
  };
}

function voteNominee(row) {
  if (!row) return null;
  return {
    voteId: row.vote_id,
    nomineeId: row.nominee_id,
    userId: row.user_id
  };
}

module.exports = {
  userPublic,
  tournament,
  stage,
  group,
  round,
  team,
  player,
  participantTeam,
  participantPlayer,
  match,
  follow,
  defaultStageSettings,
  vote,
  voteNominee,
};
