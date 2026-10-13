const { query, withTransaction, parseJson } = require('../db');
const { id, slugify } = require('../utils/ids');
const crypto = require('crypto');
const { asyncHandler } = require('../utils/asyncHandler');
const { httpError } = require('../middleware/error');
const map = require('../services/mappers');
const access = require('../services/access');
const { getRole } = require('../services/tournamentRolesService');

const one = async (text, values = []) => (await query(text, values)).rows[0];
const many = async (text, values = []) => (await query(text, values)).rows;
const run = async (text, values = []) => (await query(text, values)).rowCount;
const optionalValue = (value) => value === '' || value == null ? null : value;
const playerRoles = new Set(['player', 'captain', 'goalkeeper']);
const playerStatuses = new Set(['active', 'injured', 'suspended', 'ineligible']);

function tournamentPlayerCap(settings) {
  const configuredCap = Number(settings?.maxPlayersPerTeam);
  const defaultCap = map.defaultTournamentSettings().maxPlayersPerTeam;
  return Number.isInteger(configuredCap) && configuredCap >= 1 && configuredCap <= 99
    ? configuredCap
    : defaultCap;
}

function playerRegistrationMode(settings) {
  const mode = settings?.playerRegistrationMode;
  return ['direct', 'invite_code', 'both'].includes(mode) ? mode : 'direct';
}

function assertPlayerRegistrationStrategy(settings, strategy, isAdmin = false) {
  if (strategy === 'direct' && isAdmin) return;
  const mode = playerRegistrationMode(settings);
  const allowed = strategy === 'direct'
    ? mode === 'direct' || mode === 'both'
    : mode === 'invite_code' || mode === 'both';
  if (!allowed) {
    throw httpError(403, strategy === 'direct'
      ? 'Direct player entry is disabled for this tournament.'
      : 'Invite-code registration is disabled for this tournament.');
  }
}

async function lockTeamRoster(client, tournamentId, participantTeamId) {
  const teamResult = await client.query(
    `SELECT pt.id
     FROM participant_teams pt
     WHERE pt.id = $1 AND pt.tournament_id = $2
     FOR UPDATE`,
    [participantTeamId, tournamentId],
  );
  if (!teamResult.rows[0]) throw httpError(404, 'Participant team not found');
  const tournamentResult = await client.query(
    'SELECT settings FROM tournaments WHERE id = $1',
    [tournamentId],
  );
  if (!tournamentResult.rows[0]) throw httpError(404, 'Tournament not found');
  const countResult = await client.query(
    'SELECT COUNT(*) AS count FROM participant_players WHERE participant_team_id = $1',
    [participantTeamId],
  );
  const settings = parseJson(tournamentResult.rows[0].settings, {});
  const inviteCountResult = await client.query(
    `SELECT COUNT(*) AS count FROM participant_player_invite_codes
     WHERE participant_team_id = $1 AND expires_at > NOW()`,
    [participantTeamId],
  );
  return {
    count: Number(countResult.rows[0].count),
    maximum: tournamentPlayerCap(settings),
    reservedInviteCodes: Number(inviteCountResult.rows[0].count),
    settings,
  };
}

function assertRosterCapacity(
  roster,
  requestedCount = roster.count + 1,
  reservedInviteCodes = roster.reservedInviteCodes,
) {
  if (roster.count > roster.maximum || requestedCount + reservedInviteCodes > roster.maximum) {
    throw httpError(409, `This tournament allows at most ${roster.maximum} players per team.`);
  }
}

const inviteAttemptLimits = {
  issue: { maximum: 100, window: '1 hour', message: 'Too many invite codes have been requested. Try again later.' },
  redeem: { maximum: 10, window: '15 minutes', message: 'Too many invite-code attempts. Try again later.' },
};

async function recordInviteAttempt(userId, action) {
  const limit = inviteAttemptLimits[action];
  const allowed = await withTransaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`player-invite:${userId}:${action}`],
    );
    await client.query(
      `DELETE FROM participant_player_invite_attempts
       WHERE attempted_at < NOW() - INTERVAL '24 hours'`,
    );
    await client.query(
      'INSERT INTO participant_player_invite_attempts (user_id, action) VALUES ($1, $2)',
      [userId, action],
    );
    const result = await client.query(
      `SELECT COUNT(*) AS count FROM participant_player_invite_attempts
       WHERE user_id = $1 AND action = $2
         AND attempted_at > NOW() - INTERVAL '${limit.window}'`,
      [userId, action],
    );
    return Number(result.rows[0].count) <= limit.maximum;
  });
  if (!allowed) throw httpError(429, limit.message);
}

function normalizedInviteCode(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{16}$/i.test(value)) {
    throw httpError(400, 'Enter a valid 16-character invite code.');
  }
  return value.toLowerCase();
}

function inviteCodeHash(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function validatePlayerFields(body) {
  if (body.role != null && !playerRoles.has(body.role)) {
    throw httpError(400, 'role must be player, captain, or goalkeeper');
  }
  if (body.status != null && !playerStatuses.has(body.status)) {
    throw httpError(400, 'status must be active, injured, suspended, or ineligible');
  }
  for (const [field, minimum, maximum] of [['shirtNumber', 1, 99], ['heightCm', 1, 300]]) {
    if (body[field] == null || body[field] === '') continue;
    const value = Number(body[field]);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw httpError(400, `${field} must be an integer from ${minimum} to ${maximum}`);
    }
  }
}

const participantJoinSql = 'SELECT pt.* FROM participant_teams pt';

const listTeams = asyncHandler(async (req, res) => {
  const tournament = await access.getTournamentOrThrow(req.params.tournamentId);
  await access.requireTournamentInspect(tournament, req.user);
  const rows = await many(`${participantJoinSql} WHERE pt.tournament_id = $1 ORDER BY pt.name`, [tournament.id]);
  res.json({ teams: rows.map(map.participantTeam) });
});

const getTeam = asyncHandler(async (req, res) => {
  const row = await one(`${participantJoinSql} WHERE pt.id = $1`, [req.params.id]);
  if (!row) throw httpError(404, 'Team not found');
  const tournament = await access.getTournamentOrThrow(row.tournament_id);
  await access.requireTournamentInspect(tournament, req.user);
  res.json({ team: map.participantTeam(row) });
});

const createTeam = asyncHandler(async (req, res) => {
  const tournament = await access.getTournamentOrThrow(req.params.tournamentId);
  await access.requireTournamentManage(tournament, req.user);
  const body = req.body || {};
  if (!String(body.name || '').trim()) throw httpError(400, 'name is required');
  const teamId = id();
  await run(
    `INSERT INTO participant_teams
      (id, tournament_id, creator_id, name, slug, short_name, primary_color, secondary_color, city, country, founded_year, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'registered')`,
    [teamId, tournament.id, req.user.id, body.name.trim(), body.slug || slugify(body.name),
      body.shortName || null, body.primaryColor || body.colors?.primary || null,
      body.secondaryColor || body.colors?.secondary || null, body.city || null,
      body.country || null, body.foundedYear || null],
  );
  res.status(201).json({ team: map.participantTeam(await one(`${participantJoinSql} WHERE pt.id = $1`, [teamId])) });
});

const updateTeam = asyncHandler(async (req, res) => {
  const row = await one(`${participantJoinSql} WHERE pt.id = $1`, [req.params.id]);
  if (!row || row.tournament_id !== req.params.tournamentId) throw httpError(404, 'Team not found');
  const tournament = await access.getTournamentOrThrow(row.tournament_id);
  await access.requireTournamentManage(tournament, req.user);
  const body = req.body || {};
  await run(
    `UPDATE participant_teams
     SET name=$1, short_name=$2, primary_color=$3, secondary_color=$4, city=$5, country=$6, founded_year=$7
     WHERE id=$8`,
    [body.name ?? row.name, body.shortName ?? row.short_name,
      body.primaryColor ?? body.colors?.primary ?? row.primary_color,
      body.secondaryColor ?? body.colors?.secondary ?? row.secondary_color,
      body.city ?? row.city, body.country ?? row.country,
      body.foundedYear ?? row.founded_year, row.id],
  );
  res.json({ team: map.participantTeam(await one(`${participantJoinSql} WHERE pt.id = $1`, [row.id])) });
});

const removeTeam = asyncHandler(async (req, res) => {
  const row = await one('SELECT tournament_id FROM participant_teams WHERE id = $1', [req.params.id]);
  if (!row || row.tournament_id !== req.params.tournamentId) throw httpError(404, 'Team not found');
  const tournament = await access.getTournamentOrThrow(row.tournament_id);
  await access.requireTournamentManage(tournament, req.user);
  if (!(await run('DELETE FROM participant_teams WHERE id = $1', [req.params.id]))) {
    throw httpError(404, 'Team not found');
  }
  res.status(204).end();
});

const addParticipantTeam = asyncHandler(async (req, res) => {
  const tournament = await access.getTournamentOrThrow(req.params.tournamentId);
  const body = req.body || {};
  if (!String(body.name || '').trim()) throw httpError(400, 'name is required');
  const ptId = id();
  await run(
    `INSERT INTO participant_teams
      (id, tournament_id, creator_id, name, slug, short_name, primary_color, secondary_color, city, country, founded_year, seed, nickname, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'registered')`,
    [ptId, tournament.id, req.user.id, body.name.trim(), body.slug || slugify(body.name),
      body.shortName || null, body.primaryColor || null, body.secondaryColor || null,
      body.city || null, body.country || null, body.foundedYear || null,
      body.seed ?? null, body.nickname || null],
  );
  const row = await one(`${participantJoinSql} WHERE pt.id = $1`, [ptId]);
  res.status(201).json({ participantTeam: map.participantTeam(row) });
});

const createTeamLeaderTeam = asyncHandler(async (req, res) => {
  const tournament = await access.getTournamentOrThrow(req.params.tournamentId);
  const userId = req.user.id;
  await access.requireTeamLeader(tournament.id, req.user);
  if (await one('SELECT 1 FROM tournament_team_leaders WHERE tournament_id = $1 AND user_id = $2', [tournament.id, userId])) {
    throw httpError(409, 'You already created a team for this tournament');
  }
  const body = req.body || {};
  if (!String(body.name || '').trim()) throw httpError(400, 'Team name is required');
  const participantTeamId = id();
  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO participant_teams
          (id, tournament_id, creator_id, name, slug, short_name, primary_color, secondary_color, city, country, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'registered')`,
        [participantTeamId, tournament.id, userId, body.name.trim(), body.slug || slugify(body.name),
          body.shortName || null, body.primaryColor || null, body.secondaryColor || null,
          body.city || null, body.country || null],
      );
      await client.query(
        `INSERT INTO tournament_team_leaders (tournament_id, user_id, participant_team_id)
         VALUES ($1, $2, $3)`,
        [tournament.id, userId, participantTeamId],
      );
    });
  } catch (error) {
    if (error.code === '23505') throw httpError(409, 'A team with this name or ownership already exists');
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
  const players = await many(`${playerJoinSql} WHERE pp.participant_team_id = $1 ORDER BY pp.shirt_number, pp.name`, [row.id]);
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

const removeTeamLeaderTeam = asyncHandler(async (req, res) => {
  const team = await teamLeaderOwnedTeam(
    req.params.tournamentId,
    req.user.id,
    req.params.id,
  );
  const result = await run(
    'DELETE FROM participant_teams WHERE id = $1 AND tournament_id = $2',
    [team.id, req.params.tournamentId],
  );
  if (!result) throw httpError(404, 'Team not found');
  res.status(204).end();
});

const addTeamLeaderPlayer = asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!String(body.name || '').trim()) throw httpError(400, 'name is required');
  validatePlayerFields(body);
  const participantPlayerId = id();
  const slug = body.slug || slugify(body.name);
  try {
    await withTransaction(async (client) => {
      const roster = await lockTeamLeaderRoster(
        client,
        req.params.tournamentId,
        req.params.id,
        req.user.id,
      );
      assertPlayerRegistrationStrategy(roster.settings, 'direct', req.user.role === 'admin');
      assertRosterCapacity(roster);
      await client.query(
        `INSERT INTO participant_players
          (id, participant_team_id, creator_id, name, slug, nickname, date_of_birth,
           nationality, position, preferred_foot, height_cm, shirt_number, role, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [participantPlayerId, req.params.id, req.user.id, body.name.trim(), slug,
          optionalValue(body.nickname), optionalValue(body.dateOfBirth),
          optionalValue(body.nationality), optionalValue(body.position),
          optionalValue(body.preferredFoot), optionalValue(body.heightCm),
          optionalValue(body.shirtNumber), body.role || 'player', body.status || 'active'],
      );
    });
  } catch (error) {
    if (error.code === '23505') throw httpError(409, 'A player with this name or slug already exists on this team');
    throw error;
  }
  const row = await one('SELECT * FROM participant_players WHERE id = $1', [participantPlayerId]);
  res.status(201).json({ participantPlayer: map.participantPlayer(row) });
});

const removeTeamLeaderPlayer = asyncHandler(async (req, res) => {
  await teamLeaderOwnedTeam(req.params.tournamentId, req.user.id, req.params.id);
  const result = await run(
    `DELETE FROM participant_players
     WHERE id = $1 AND participant_team_id = $2`,
    [req.params.playerId, req.params.id],
  );
  if (!result) throw httpError(404, 'Player not found');
  res.status(204).end();
});

const autoAddParticipantTeams = asyncHandler(async (req, res) => {
  const tournament = await access.getTournamentOrThrow(req.params.tournamentId);
  console.log(tournament);
  const target = Number(req.body?.count ?? tournament.number_of_teams);
  if (!Number.isInteger(target) || target < 0) throw httpError(400, 'count must be a non-negative integer');

  const registered = await many('SELECT id FROM participant_teams WHERE tournament_id = $1', [tournament.id]);
  const missing = Math.max(0, target - registered.length);
  const creatorId = req.user.id;
  for (let index = 0; index < missing; index += 1) {
    const number = registered.length + index + 1;
    await run(
      `INSERT INTO participant_teams
        (id, tournament_id, creator_id, name, slug, short_name, seed, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'registered')`,
      [id(), tournament.id, creatorId, `Team ${number}`, `auto-team-${tournament.id}-${number}`,
        `T${number}`, number],
    );
  }

  const rows = await many(`${participantJoinSql} WHERE pt.tournament_id = $1 ORDER BY pt.seed, pt.name`, [tournament.id]);
  res.status(201).json({ participantTeams: rows.map(map.participantTeam) });
});

const listParticipantTeams = asyncHandler(async (req, res) => {
  const tournament = await access.getTournamentOrThrow(req.params.tournamentId);
  await access.requireTournamentInspect(tournament, req.user);
  
  const rows = await many(
    `${participantJoinSql} WHERE pt.tournament_id = $1 ORDER BY pt.seed, pt.name`,
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
  if (!info) throw httpError(404, 'Participant team not found');
  res.status(204).end();
});

const playerJoinSql = `
  SELECT pp.*
  FROM participant_players pp
`;

const addParticipantPlayer = asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!String(body.name || '').trim()) throw httpError(400, 'name is required');
  validatePlayerFields(body);
  const ppId = id();
  try {
    await withTransaction(async (client) => {
      const roster = await lockTeamRoster(client, req.params.tournamentId, req.params.id);
      assertPlayerRegistrationStrategy(roster.settings, 'direct', req.user.role === 'admin');
      assertRosterCapacity(roster);
      await client.query(
        `INSERT INTO participant_players
          (id, participant_team_id, creator_id, name, slug, nickname, date_of_birth,
           nationality, position, preferred_foot, height_cm, shirt_number, role, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [ppId, req.params.id, req.user.id, body.name.trim(), body.slug || slugify(body.name),
          optionalValue(body.nickname), optionalValue(body.dateOfBirth),
          optionalValue(body.nationality), optionalValue(body.position),
          optionalValue(body.preferredFoot), optionalValue(body.heightCm),
          optionalValue(body.shirtNumber), body.role || 'player', body.status || 'active'],
      );
    });
  } catch (error) {
    if (error.code === '23505') throw httpError(409, 'A player with this name or slug already exists on this team');
    throw error;
  }
  const row = await one(`${playerJoinSql} WHERE pp.id = $1`, [ppId]);
  res.status(201).json({ participantPlayer: map.participantPlayer(row) });
});

const autoAddParticipantPlayers = asyncHandler(async (req, res) => {
  const target = Number(req.body?.count);
  if (!Number.isInteger(target) || target < 0) throw httpError(400, 'count must be a non-negative integer');

  await withTransaction(async (client) => {
    const roster = await lockTeamRoster(client, req.params.tournamentId, req.params.id);
    assertRosterCapacity(roster, target);
    const currentTeamCount = roster.count;
    const missing = Math.max(0, target - currentTeamCount);
    for (let index = 0; index < missing; index += 1) {
      const number = currentTeamCount + index + 1;
      let slug = `auto-player-${number}`;
      let suffix = number;
      while ((await client.query(
        'SELECT 1 FROM participant_players WHERE participant_team_id = $1 AND slug = $2',
        [req.params.id, slug],
      )).rowCount) {
        suffix += 1;
        slug = `auto-player-${suffix}`;
      }
      await client.query(
        `INSERT INTO participant_players
          (id, participant_team_id, creator_id, name, slug, nickname, position,
           shirt_number, role, status)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, 'player', 'active')`,
        [id(), req.params.id, req.user.id, `Player ${suffix}`, slug,
          `P${suffix}`, number],
      );
    }
  });

  const rows = await many(`${playerJoinSql} WHERE pp.participant_team_id = $1 ORDER BY pp.shirt_number`, [req.params.id]);
  res.status(201).json({ participantPlayers: rows.map(map.participantPlayer) });
});

const listParticipantPlayers = asyncHandler(async (req, res) => {
  const pt = await one('SELECT * FROM participant_teams WHERE id = $1', [req.params.id]);
  if (!pt) throw httpError(404, 'Participant team not found');
  if (pt.tournament_id !== req.params.tournamentId) throw httpError(404, 'Participant team not found');
  const tournament = await access.getTournamentOrThrow(pt.tournament_id);
  await access.requireTournamentInspect(tournament, req.user);
  const rows = await many(`${playerJoinSql} WHERE pp.participant_team_id = $1 ORDER BY pp.shirt_number`, [pt.id]);
  const reserved = await one(
    `SELECT COUNT(*) AS count FROM participant_player_invite_codes
     WHERE participant_team_id = $1 AND expires_at > NOW()`,
    [pt.id],
  );
  res.json({
    participantPlayers: rows.map(map.participantPlayer),
    reservedInviteCodes: Number(reserved.count),
  });
});

async function lockTeamLeaderRoster(client, tournamentId, teamId, userId) {
  const owned = await client.query(
    `SELECT pt.id FROM tournament_team_leaders ttl
     JOIN participant_teams pt ON pt.id = ttl.participant_team_id
     WHERE ttl.tournament_id = $1 AND ttl.user_id = $2 AND pt.id = $3
       AND pt.tournament_id = $1
     FOR UPDATE OF pt`,
    [tournamentId, userId, teamId],
  );
  if (!owned.rows[0]) throw httpError(403, 'You can manage only your own tournament team');
  return lockTeamRoster(client, tournamentId, teamId);
}

async function getInviteRoster(req, client, isTeamLeader) {
  if (isTeamLeader) {
    return lockTeamLeaderRoster(
      client,
      req.params.tournamentId,
      req.params.id,
      req.user.id,
    );
  }
  return lockTeamRoster(client, req.params.tournamentId, req.params.id);
}

const issuePlayerInviteCode = (isTeamLeader) => asyncHandler(async (req, res) => {
  await recordInviteAttempt(req.user.id, 'issue');
  const invite = await withTransaction(async (client) => {
    const roster = await getInviteRoster(req, client, isTeamLeader);
    assertPlayerRegistrationStrategy(roster.settings, 'invite_code');
    assertRosterCapacity(roster, roster.count + 1);
    await client.query(
      `DELETE FROM participant_player_invite_codes
       WHERE participant_team_id = $1 AND expires_at <= NOW()`,
      [req.params.id],
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = crypto.randomBytes(8).toString('hex');
      const result = await client.query(
        `INSERT INTO participant_player_invite_codes
          (id, code_hash, participant_team_id, tournament_id, creator_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days')
         ON CONFLICT (code_hash) DO NOTHING
         RETURNING id, created_at, expires_at`,
        [id(), inviteCodeHash(code), req.params.id, req.params.tournamentId, req.user.id],
      );
      if (result.rows[0]) return { ...result.rows[0], code };
    }
    throw httpError(503, 'Unable to generate a unique invite code. Please retry.');
  });
  res.status(201).json({
    inviteCode: {
      id: invite.id,
      code: invite.code,
      createdAt: invite.created_at,
      expiresAt: invite.expires_at,
    },
  });
});

const listPlayerInviteCodes = (isTeamLeader) => asyncHandler(async (req, res) => {
  const codes = await withTransaction(async (client) => {
    const roster = await getInviteRoster(req, client, isTeamLeader);
    assertPlayerRegistrationStrategy(roster.settings, 'invite_code');
    await client.query(
      `DELETE FROM participant_player_invite_codes
       WHERE participant_team_id = $1 AND expires_at <= NOW()`,
      [req.params.id],
    );
    const result = await client.query(
      `SELECT id, created_at, expires_at
       FROM participant_player_invite_codes
       WHERE participant_team_id = $1 AND tournament_id = $2 AND expires_at > NOW()
       ORDER BY created_at`,
      [req.params.id, req.params.tournamentId],
    );
    return result.rows;
  });
  res.json({
    inviteCodes: codes.map((code) => ({
      id: code.id,
      createdAt: code.created_at,
      expiresAt: code.expires_at,
    })),
  });
});

const revokePlayerInviteCode = (isTeamLeader) => asyncHandler(async (req, res) => {
  const result = await withTransaction(async (client) => {
    await getInviteRoster(req, client, isTeamLeader);
    return client.query(
      `DELETE FROM participant_player_invite_codes
       WHERE id = $1 AND participant_team_id = $2 AND tournament_id = $3`,
      [req.params.codeId, req.params.id, req.params.tournamentId],
    );
  });
  if (!result.rowCount) throw httpError(404, 'Invite code not found.');
  res.status(204).end();
});

const validatePlayerInviteCode = asyncHandler(async (req, res) => {
  await recordInviteAttempt(req.user.id, 'redeem');
  const code = normalizedInviteCode(req.body?.code);
  const details = await withTransaction(async (client) => {
    const candidate = await client.query(
      `SELECT participant_team_id, tournament_id FROM participant_player_invite_codes
       WHERE code_hash = $1 AND expires_at > NOW()`,
      [inviteCodeHash(code)],
    );
    if (!candidate.rows[0]) {
      throw httpError(400, 'This invite code is invalid, expired, revoked, or already used.');
    }
    const existingMembership = await client.query(
      `SELECT 1 FROM participant_players WHERE joined_by_user_id = $1`,
      [req.user.id],
    );
    if (existingMembership.rows[0]) {
      throw httpError(409, 'You have already joined a team and cannot redeem another invite code.');
    }
    const roster = await lockTeamRoster(
      client,
      candidate.rows[0].tournament_id,
      candidate.rows[0].participant_team_id,
    );
    const invite = await client.query(
      `SELECT ic.id, pt.id AS team_id, pt.name AS team_name, t.name AS tournament_name
       FROM participant_player_invite_codes ic
       JOIN participant_teams pt ON pt.id = ic.participant_team_id
       JOIN tournaments t ON t.id = ic.tournament_id
       WHERE ic.code_hash = $1 AND ic.expires_at > NOW()
       FOR UPDATE OF ic`,
      [inviteCodeHash(code)],
    );
    if (!invite.rows[0]) {
      throw httpError(400, 'This invite code is invalid, expired, revoked, or already used.');
    }
    assertPlayerRegistrationStrategy(roster.settings, 'invite_code');
    assertRosterCapacity(roster, roster.count + 1, Math.max(0, roster.reservedInviteCodes - 1));
    return {
      participantTeamId: invite.rows[0].team_id,
      teamName: invite.rows[0].team_name,
      tournamentName: invite.rows[0].tournament_name,
      maxPlayersPerTeam: roster.maximum,
    };
  });
  res.json(details);
});

const getPlayerInviteMembership = asyncHandler(async (req, res) => {
  const membership = await one(
    `SELECT pp.id AS player_id, pp.name AS player_name,
            pt.id AS participant_team_id, pt.name AS team_name,
            t.id AS tournament_id, t.name AS tournament_name
     FROM participant_players pp
     JOIN participant_teams pt ON pt.id = pp.participant_team_id
     JOIN tournaments t ON t.id = pt.tournament_id
     WHERE pp.joined_by_user_id = $1`,
    [req.user.id],
  );
  res.json({
    membership: membership ? {
      playerId: membership.player_id,
      playerName: membership.player_name,
      participantTeamId: membership.participant_team_id,
      teamName: membership.team_name,
      tournamentId: membership.tournament_id,
      tournamentName: membership.tournament_name,
    } : null,
  });
});

const redeemPlayerInviteCode = asyncHandler(async (req, res) => {
  await recordInviteAttempt(req.user.id, 'redeem');
  const code = normalizedInviteCode(req.body?.code);
  const body = req.body?.player;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'Player details are required.');
  }
  if (typeof body.name !== 'string' || !body.name.trim()) {
    throw httpError(400, 'name is required');
  }
  validatePlayerFields(body);
  const playerId = id();
  try {
    await withTransaction(async (client) => {
      const candidate = await client.query(
        `SELECT id, participant_team_id, tournament_id FROM participant_player_invite_codes
         WHERE code_hash = $1 AND expires_at > NOW()`,
        [inviteCodeHash(code)],
      );
      if (!candidate.rows[0]) {
        throw httpError(400, 'This invite code is invalid, expired, revoked, or already used.');
      }
      const roster = await lockTeamRoster(
        client,
        candidate.rows[0].tournament_id,
        candidate.rows[0].participant_team_id,
      );
      const invite = await client.query(
        `SELECT id FROM participant_player_invite_codes
         WHERE id = $1 AND code_hash = $2 AND expires_at > NOW()
         FOR UPDATE`,
        [candidate.rows[0].id, inviteCodeHash(code)],
      );
      if (!invite.rows[0]) {
        throw httpError(400, 'This invite code is invalid, expired, revoked, or already used.');
      }
      const existingMembership = await client.query(
        `SELECT 1 FROM participant_players WHERE joined_by_user_id = $1`,
        [req.user.id],
      );
      if (existingMembership.rows[0]) {
        throw httpError(409, 'You have already joined a team and cannot redeem another invite code.');
      }
      assertPlayerRegistrationStrategy(roster.settings, 'invite_code');
      assertRosterCapacity(roster, roster.count + 1, Math.max(0, roster.reservedInviteCodes - 1));
      await client.query(
        `INSERT INTO participant_players
          (id, participant_team_id, creator_id, joined_by_user_id, name, slug, nickname, date_of_birth,
           nationality, position, preferred_foot, height_cm, shirt_number, role, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [playerId, candidate.rows[0].participant_team_id, req.user.id, req.user.id,
          body.name.trim(), body.slug || slugify(body.name), optionalValue(body.nickname),
          optionalValue(body.dateOfBirth), optionalValue(body.nationality),
          optionalValue(body.position), optionalValue(body.preferredFoot),
          optionalValue(body.heightCm), optionalValue(body.shirtNumber),
          body.role || 'player', body.status || 'active'],
      );
      await client.query(
        'DELETE FROM participant_player_invite_codes WHERE id = $1',
        [candidate.rows[0].id],
      );
    });
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'idx_participant_players_joined_user') {
      throw httpError(409, 'You have already joined a team and cannot redeem another invite code.');
    }
    if (error.code === '23505') throw httpError(409, 'A player with this name or slug already exists on this team');
    throw error;
  }
  const row = await one(`${playerJoinSql} WHERE pp.id = $1`, [playerId]);
  res.status(201).json({ participantPlayer: map.participantPlayer(row) });
});

const updateParticipantPlayer = asyncHandler(async (req, res) => {
  const row = await one('SELECT * FROM participant_players WHERE id = $1', [req.params.id]);
  if (!row) throw httpError(404, 'Participant player not found');
  const pt = await one('SELECT tournament_id FROM participant_teams WHERE id = $1', [row.participant_team_id]);
  if (!pt || pt.tournament_id !== req.params.tournamentId) throw httpError(404, 'Participant player not found');
  const body = req.body || {};
  if (body.name !== undefined && !String(body.name).trim()) throw httpError(400, 'name cannot be empty');
  validatePlayerFields(body);
  try {
    await withTransaction(async (client) => {
      const roster = await lockTeamRoster(client, req.params.tournamentId, row.participant_team_id);
      assertRosterCapacity(roster, roster.count, 0);
      await client.query(
        `UPDATE participant_players
         SET name = $1, slug = $2, nickname = $3, date_of_birth = $4, nationality = $5,
             position = $6, preferred_foot = $7, height_cm = $8, shirt_number = $9,
             role = $10, status = $11, yellow_cards = $12, red_cards = $13, goals = $14, assists = $15
         WHERE id = $16 AND participant_team_id = $17`,
        [body.name === undefined ? row.name : body.name.trim(),
          body.slug === undefined ? row.slug : (body.slug || slugify(body.name ?? row.name)),
          body.nickname === undefined ? row.nickname : optionalValue(body.nickname),
          body.dateOfBirth === undefined ? row.date_of_birth : optionalValue(body.dateOfBirth),
          body.nationality === undefined ? row.nationality : optionalValue(body.nationality),
          body.position === undefined ? row.position : optionalValue(body.position),
          body.preferredFoot === undefined ? row.preferred_foot : optionalValue(body.preferredFoot),
          body.heightCm === undefined ? row.height_cm : optionalValue(body.heightCm),
          body.shirtNumber === undefined ? row.shirt_number : optionalValue(body.shirtNumber),
          body.role ?? row.role, body.status ?? row.status, body.yellowCards ?? row.yellow_cards,
          body.redCards ?? row.red_cards, body.goals ?? row.goals, body.assists ?? row.assists,
          row.id, row.participant_team_id],
      );
    });
  } catch (error) {
    if (error.code === '23505') throw httpError(409, 'A player with this name or slug already exists on this team');
    throw error;
  }
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
  if (!info) throw httpError(404, 'Participant player not found');
  res.status(204).end();
});

module.exports = {
  listTeams,
  getTeam,
  createTeam,
  updateTeam,
  removeTeam,
  addParticipantTeam,
  createTeamLeaderTeam,
  getTeamLeaderTeam,
  removeTeamLeaderTeam,
  addTeamLeaderPlayer,
  removeTeamLeaderPlayer,
  autoAddParticipantTeams,
  listParticipantTeams,
  updateParticipantTeam,
  removeParticipantTeam,
  addParticipantPlayer,
  autoAddParticipantPlayers,
  listParticipantPlayers,
  issuePlayerInviteCode: issuePlayerInviteCode(false),
  listPlayerInviteCodes: listPlayerInviteCodes(false),
  revokePlayerInviteCode: revokePlayerInviteCode(false),
  issueTeamLeaderPlayerInviteCode: issuePlayerInviteCode(true),
  listTeamLeaderPlayerInviteCodes: listPlayerInviteCodes(true),
  revokeTeamLeaderPlayerInviteCode: revokePlayerInviteCode(true),
  validatePlayerInviteCode,
  getPlayerInviteMembership,
  redeemPlayerInviteCode,
  updateParticipantPlayer,
  removeParticipantPlayer,
  playerRegistrationMode,
  assertPlayerRegistrationStrategy,
  assertRosterCapacity,
  normalizedInviteCode,
  inviteCodeHash,
};
