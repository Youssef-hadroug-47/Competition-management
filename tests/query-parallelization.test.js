const test = require('node:test');
const assert = require('node:assert/strict');

function delayedQuery(respond) {
  let active = 0;
  let maximumActive = 0;
  const calls = [];
  const query = async (text, values = []) => {
    calls.push({ text, values });
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return respond(text, values);
    } finally {
      active -= 1;
    }
  };
  return {
    query,
    calls,
    get maximumActive() {
      return maximumActive;
    },
  };
}

test('standing query loads stages and groups concurrently and ranks all groups', async () => {
  const database = require('../src/db');
  const originalQuery = database.query;
  const groupTeams = {
    'group-1': [
      { id: 'team-1-a', points: 4, goals_for: 3, goals_against: 1 },
      { id: 'team-1-b', points: 4, goals_for: 1, goals_against: 3 },
    ],
    'group-2': [
      { id: 'team-2-a', points: 3, goals_for: 2, goals_against: 0 },
      { id: 'team-2-b', points: 1, goals_for: 0, goals_against: 2 },
    ],
  };
  const teamRows = Object.entries(groupTeams).flatMap(([groupId, teams]) => teams.map((team) => ({ ...team, ranking_group_id: groupId })));
  const matchRows = Object.entries(groupTeams).map(([groupId, teams]) => ({
    group_id: groupId,
    home: teams[0].id,
    away: teams[1].id,
    home_score: 2,
    away_score: 0,
  }));
  const fake = delayedQuery((text) => {
    if (text.includes('SELECT id FROM groups')) {
      return { rows: [{ id: 'group-1' }, { id: 'group-2' }] };
    }
    if (text.includes('SELECT settings FROM stages')) {
      return {
        rows: [{
          settings: JSON.stringify({
            tiebreakers: [
              { type: 'points', priority: 1 },
              { type: 'head_to_head', priority: 2 },
            ],
          }),
        }],
      };
    }
    if (text.includes('AS ranking_group_id')) {
      return { rows: teamRows };
    }
    if (text.includes('SELECT m.group_id')) {
      return { rows: matchRows };
    }
    throw new Error(`Unexpected query: ${text}`);
  });

  database.query = fake.query;
  const controllerPath = require.resolve('../src/controllers/tournamentController');
  delete require.cache[controllerPath];
  try {
    const controller = require(controllerPath);
    let response;
    let caughtError;
    await controller.getStanding(
      { params: { id: 'stage-1' } },
      { json: (body) => { response = body; } },
      (error) => { caughtError = error; },
    );

    assert.equal(caughtError, undefined);
    assert.equal(response.stageId, 'stage-1');
    assert.deepEqual(response.groups, [
      { groupId: 'group-1', order: ['team-1-a', 'team-1-b'] },
      { groupId: 'group-2', order: ['team-2-a', 'team-2-b'] },
    ]);
    assert.ok(fake.maximumActive >= 2, 'independent stage/group and group-ranking reads should overlap');
    assert.equal(
      fake.calls.filter((call) => call.text.includes('AS ranking_group_id')).length,
      1,
      'every group roster should be loaded in a single query, not one query per group',
    );
    assert.equal(
      fake.calls.filter((call) => call.text.includes('SELECT m.group_id')).length,
      1,
      'head-to-head matches should be fetched once for the stage, not once per group',
    );
    assert.equal(
      fake.calls.filter((call) => call.text.includes('LEFT JOIN LATERAL')).length,
      1,
      'card totals should be aggregated in the batched team query rather than fetched per group',
    );
  } finally {
    database.query = originalQuery;
    delete require.cache[controllerPath];
  }
});

test('vote creation and updates return changed rows without follow-up reads', async () => {
  const database = require('../src/db');
  const originalQuery = database.query;
  const fake = delayedQuery((text, values) => {
    if (text.includes('INSERT INTO vote')) {
      return { rows: [{ id: values[0], tournament_id: values[1], name: values[2], award: values[3], status: 'open' }] };
    }
    if (text.includes("SET status = 'finished'")) {
      return { rows: [{ id: values[0], tournament_id: values[1], name: 'Original', award: 'Award', status: 'finished' }] };
    }
    if (text.includes('UPDATE vote') && text.includes("status = 'open'")) {
      return { rows: [{ id: values[2], tournament_id: values[3], name: values[0] || 'Original', award: values[1] || 'Award', status: 'open' }] };
    }
    throw new Error(`Unexpected query: ${text}`);
  });
  database.query = fake.query;
  const servicePath = require.resolve('../src/services/voteService');
  delete require.cache[servicePath];
  try {
    const service = require(servicePath);
    const created = await service.createVote({ tournamentId: 't1', name: 'MVP', award: 'Player' });
    assert.equal(created.name, 'MVP');
    assert.equal(fake.calls.length, 1);

    const updated = await service.updateVote('v1', 't1', { name: 'Updated' });
    assert.equal(updated.name, 'Updated');
    assert.equal(fake.calls.length, 2);

    const finished = await service.finishVote('v1', 't1');
    assert.equal(finished.status, 'finished');
    assert.equal(fake.calls.length, 3);
    assert.ok(fake.calls.every((call) => call.text.includes('RETURNING')));
  } finally {
    database.query = originalQuery;
    delete require.cache[servicePath];
  }
});

test('nominee validation reads run concurrently and duplicate prevention relies on the unique constraint', async () => {
  const database = require('../src/db');
  const originalQuery = database.query;
  const fake = delayedQuery((text, values) => {
    if (text.includes('SELECT * FROM vote')) {
      return { rows: [{ id: values[0], tournament_id: values[1], status: 'open' }] };
    }
    if (text.includes('SELECT pp.id FROM participant_players')) return { rows: [{ id: values[0] }] };
    if (text.includes('INSERT INTO vote_nominees')) return { rows: [{ vote_id: values[0] }], rowCount: 1 };
    if (text.includes('SELECT vn.vote_id')) {
      return { rows: [{ vote_id: values[0], nominee_id: values[1], player_name: 'Player' }] };
    }
    throw new Error(`Unexpected query: ${text}`);
  });
  database.query = fake.query;
  const servicePath = require.resolve('../src/services/voteService');
  delete require.cache[servicePath];
  try {
    const service = require(servicePath);
    const nominee = await service.addNominee({
      voteId: 'vote-1',
      tournamentId: 'tournament-1',
      nomineeId: 'player-1',
    });
    assert.equal(nominee.nominee_id, 'player-1');
    assert.ok(fake.maximumActive >= 2, 'vote and player validation should run concurrently');
    assert.equal(fake.calls.length, 4);
    assert.equal(fake.calls.some((call) => call.text.includes('ON CONFLICT (vote_id, nominee_id) DO NOTHING')), true);
    assert.equal(fake.calls.some((call) => call.text.startsWith('SELECT vn.vote_id')), true);
    assert.equal(
      fake.calls.filter((call) => call.text.startsWith('SELECT vn.vote_id')).length,
      1,
      'must not pre-check for a nominee that the insert constraint can reject',
    );
  } finally {
    database.query = originalQuery;
    delete require.cache[servicePath];
  }
});

test('automatic team and player filling use bulk inserts and avoid per-row slug queries', async () => {
  const database = require('../src/db');
  const originalQuery = database.query;
  const originalWithTransaction = database.withTransaction;
  const accessPath = require.resolve('../src/services/access');
  const originalAccessModule = require.cache[accessPath];
  const calls = [];
  const respond = async (text, values = []) => {
    calls.push({ text, values });
    if (text.includes('SELECT id FROM participant_teams')) return { rows: [] };
    if (text.includes('SELECT pt.id') && text.includes('FOR UPDATE OF pt')) {
      return { rows: [{ id: 'team-1' }] };
    }
    if (text.includes('SELECT t.settings')) {
      return {
        rows: [{
          settings: JSON.stringify({ maxPlayersPerTeam: 5 }),
          player_count: '2',
          invite_count: '0',
        }],
      };
    }
    if (text.includes('COUNT(*) AS count FROM participant_players')) return { rows: [{ count: '2' }] };
    if (text.includes('COUNT(*) AS count FROM participant_player_invite_codes')) return { rows: [{ count: '0' }] };
    if (text.includes('SELECT slug FROM participant_players')) {
      return { rows: [{ slug: 'auto-player-1' }, { slug: 'auto-player-4' }] };
    }
    if (text.includes('INSERT INTO participant_teams') && text.includes('FROM unnest')) {
      return { rowCount: values[2].length };
    }
    if (text.includes('INSERT INTO participant_players') && text.includes('FROM unnest')) {
      return { rowCount: values[2].length };
    }
    if (text.includes('FROM participant_teams pt WHERE pt.tournament_id')) return { rows: [] };
    if (text.includes('FROM participant_players pp') && text.includes('ORDER BY pp.shirt_number')) {
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${text}`);
  };
  database.query = respond;
  database.withTransaction = (callback) => callback({ query: respond });
  require.cache[accessPath] = {
    id: accessPath,
    filename: accessPath,
    loaded: true,
    exports: { getTournamentOrThrow: async () => ({ id: 'tournament-1', number_of_teams: 3 }) },
  };
  const controllerPath = require.resolve('../src/controllers/catalogController');
  delete require.cache[controllerPath];
  try {
    const controller = require(controllerPath);
    let teamResponse;
    let playerResponse;
    let caughtError;
    const teamRequest = {
      params: { tournamentId: 'tournament-1' },
      body: { count: 3 },
      user: { id: 'admin-1' },
    };
    await controller.autoAddParticipantTeams(
      teamRequest,
      { status() { return this; }, json(body) { teamResponse = body; } },
      (error) => { caughtError = error; },
    );
    assert.equal(caughtError, undefined);
    assert.deepEqual(teamResponse, { participantTeams: [] });
    const teamInsert = calls.find((call) => call.text.includes('INSERT INTO participant_teams'));
    assert.equal(teamInsert.values[2].length, 3);
    assert.equal(calls.filter((call) => call.text.includes('INSERT INTO participant_teams')).length, 1);

    calls.length = 0;
    await controller.autoAddParticipantPlayers(
      {
        params: { tournamentId: 'tournament-1', id: 'team-1' },
        body: { count: 4 },
        user: { id: 'admin-1' },
      },
      { status() { return this; }, json(body) { playerResponse = body; } },
      (error) => { caughtError = error; },
    );
    assert.equal(caughtError, undefined);
    assert.deepEqual(playerResponse, { participantPlayers: [] });
    const playerInsert = calls.find((call) => call.text.includes('INSERT INTO participant_players'));
    assert.deepEqual(playerInsert.values[5], ['P3', 'P5']);
    assert.deepEqual(playerInsert.values[6], [3, 4]);
    const lockIndex = calls.findIndex((call) => call.text.includes('FOR UPDATE OF pt'));
    assert.ok(lockIndex >= 0);
    assert.ok(calls[lockIndex + 1].text.includes('SELECT t.settings'));
    assert.equal(calls.filter((call) => call.text.includes('SELECT 1 FROM participant_players')).length, 0);
    assert.equal(calls.filter((call) => call.text.includes('INSERT INTO participant_players')).length, 1);
  } finally {
    database.query = originalQuery;
    database.withTransaction = originalWithTransaction;
    delete require.cache[controllerPath];
    if (originalAccessModule) require.cache[accessPath] = originalAccessModule;
    else delete require.cache[accessPath];
  }
});

test('match detail loads independent metadata together when its match row is already known', async () => {
  const database = require('../src/db');
  const originalQuery = database.query;
  const suspensionPath = require.resolve('../src/services/suspensionService');
  const originalSuspensionModule = require.cache[suspensionPath];
  const fake = delayedQuery((text, values) => {
    if (text.includes('FROM stages s') && text.includes('LEFT JOIN groups')) {
      return {
        rows: [{
          id: 'stage-1',
          tournament_id: 'tournament-1',
          type: 'league',
          settings: '{}',
          detail_group_id: 'group-1',
          detail_group_name: 'Group A',
        }],
      };
    }
    if (text.includes('SELECT pt.* FROM participant_teams')) {
      return { rows: [{ id: values[0], tournament_id: 'tournament-1', name: values[0] }] };
    }
    if (text.includes('SELECT pp.* FROM participant_players')) return { rows: [] };
    throw new Error(`Unexpected query: ${text}`);
  });
  database.query = fake.query;
  require.cache[suspensionPath] = {
    id: suspensionPath,
    filename: suspensionPath,
    loaded: true,
    exports: { getForMatch: async () => [] },
  };
  const servicePath = require.resolve('../src/services/matchService');
  delete require.cache[servicePath];
  try {
    const service = require(servicePath);
    const matchRow = {
      id: 'match-1',
      tournament_id: 'tournament-1',
      stage_id: 'stage-1',
      group_id: 'group-1',
      home_participant_team_id: 'team-home',
      away_participant_team_id: 'team-away',
      home_score: null,
      away_score: null,
    };
    const detail = await service.getMatchDetail('match-1', matchRow);
    assert.equal(detail.match.id, 'match-1');
    assert.deepEqual(detail.group, { id: 'group-1', name: 'Group A' });
    assert.equal(detail.homeTeam.id, 'team-home');
    assert.equal(detail.awayTeam.id, 'team-away');
    assert.ok(fake.maximumActive >= 5, 'independent metadata, squad, and team reads should overlap');
    assert.equal(fake.calls.some((call) => call.text.includes('FROM matches')), false);
  } finally {
    database.query = originalQuery;
    delete require.cache[servicePath];
    if (originalSuspensionModule) require.cache[suspensionPath] = originalSuspensionModule;
    else delete require.cache[suspensionPath];
  }
});

test('referee snapshots load the match and event timeline concurrently', async () => {
  const database = require('../src/db');
  const originalQuery = database.query;
  const fake = delayedQuery((text) => {
    if (text.includes('SELECT * FROM matches WHERE id = $1')) {
      return {
        rows: [{
          id: 'match-1',
          tournament_id: 'tournament-1',
          home_participant_team_id: 'team-home',
          away_participant_team_id: 'team-away',
        }],
      };
    }
    if (text.includes('FROM match_events e')) return { rows: [] };
    throw new Error(`Unexpected query: ${text}`);
  });
  database.query = fake.query;
  const servicePath = require.resolve('../src/services/refereeService');
  delete require.cache[servicePath];
  try {
    const service = require(servicePath);
    const snapshot = await service.snapshot('match-1', 'tournament-1');
    assert.equal(snapshot.match.id, 'match-1');
    assert.deepEqual(snapshot.events, []);
    assert.equal(fake.maximumActive, 2);
  } finally {
    database.query = originalQuery;
    delete require.cache[servicePath];
  }
});

test('private tournament access reads role and follow status together', async () => {
  const database = require('../src/db');
  const originalQuery = database.query;
  const fake = delayedQuery((text) => {
    if (text.includes('LEFT JOIN tournament_role') && text.includes('LEFT JOIN tournament_follows')) {
      return { rows: [{ role: null, follow_status: 'accepted' }] };
    }
    throw new Error(`Unexpected query: ${text}`);
  });
  database.query = fake.query;
  const accessPath = require.resolve('../src/services/access');
  const rolesPath = require.resolve('../src/services/tournamentRolesService');
  const originalAccessModule = require.cache[accessPath];
  const originalRolesModule = require.cache[rolesPath];
  delete require.cache[accessPath];
  delete require.cache[rolesPath];
  try {
    const access = require(accessPath);
    assert.equal(
      await access.canInspectTournament(
        { id: 'tournament-1', visibility: 'private', created_by: 'owner-1' },
        { id: 'viewer-1', role: 'user' },
      ),
      true,
    );
    assert.equal(fake.calls.length, 1);
  } finally {
    database.query = originalQuery;
    if (originalAccessModule) require.cache[accessPath] = originalAccessModule;
    else delete require.cache[accessPath];
    if (originalRolesModule) require.cache[rolesPath] = originalRolesModule;
    else delete require.cache[rolesPath];
  }
});

test('format loading batches league groups and knockout rounds across stages', async () => {
  const database = require('../src/db');
  const originalQuery = database.query;
  const fake = delayedQuery((text) => {
    if (text.includes('FROM tournaments WHERE id =')) {
      return {
        rows: [{
          id: 'tournament-1',
          name: 'Cup',
          visibility: 'public',
          created_by: 'viewer-1',
          settings: '{}',
        }],
      };
    }
    if (text.includes('FROM stages WHERE tournament_id')) {
      return {
        rows: [
          { id: 'league-1', tournament_id: 'tournament-1', type: 'league', sequence_order: 1, settings: '{}' },
          { id: 'knockout-1', tournament_id: 'tournament-1', type: 'knockout', sequence_order: 2, settings: '{}' },
        ],
      };
    }
    if (text.includes('FROM groups WHERE stage_id = ANY')) {
      return {
        rows: [{ id: 'group-1', stage_id: 'league-1', name: 'Group A', sequence_order: 1 }],
      };
    }
    if (text.includes('FROM rounds WHERE stage_id = ANY')) {
      return {
        rows: [{ id: 'round-1', stage_id: 'knockout-1', name: 'Final', sequence_order: 1 }],
      };
    }
    throw new Error(`Unexpected query: ${text}`);
  });
  database.query = fake.query;
  const accessPath = require.resolve('../src/services/access');
  const originalAccessModule = require.cache[accessPath];
  const controllerPath = require.resolve('../src/controllers/tournamentController');
  delete require.cache[controllerPath];
  require.cache[accessPath] = {
    id: accessPath,
    filename: accessPath,
    loaded: true,
    exports: {
      getTournamentOrThrow: async () => ({
        id: 'tournament-1',
        name: 'Cup',
        visibility: 'public',
        created_by: 'viewer-1',
        settings: '{}',
      }),
      requireTournamentInspect: async () => {},
    },
  };
  try {
    const controller = require(controllerPath);
    let response;
    let caughtError;
    await controller.getOne(
      { params: { tournamentId: 'tournament-1' }, user: { id: 'viewer-1', role: 'user' } },
      { json: (body) => { response = body; } },
      (error) => { caughtError = error; },
    );
    assert.equal(caughtError, undefined);
    assert.deepEqual(response.stages[0].groups.map((group) => group.name), ['Group A']);
    assert.deepEqual(response.stages[1].rounds.map((round) => round.name), ['Final']);
    assert.equal(fake.calls.filter((call) => call.text.includes('FROM groups WHERE stage_id')).length, 1);
    assert.equal(fake.calls.filter((call) => call.text.includes('FROM rounds WHERE stage_id')).length, 1);
    assert.ok(fake.maximumActive >= 2, 'league groups and knockout rounds should load concurrently');
  } finally {
    database.query = originalQuery;
    delete require.cache[controllerPath];
    if (originalAccessModule) require.cache[accessPath] = originalAccessModule;
    else delete require.cache[accessPath];
  }
});

test('draw pot options load groups, participants, and saved assignments concurrently', async () => {
  const database = require('../src/db');
  const originalQuery = database.query;
  const fake = delayedQuery((text) => {
    if (text.includes('FROM stages WHERE id = $1 AND tournament_id = $2')) {
      return { rows: [{ id: 'stage-1', type: 'league', sequence_order: 1 }] };
    }
    if (text.includes('FROM groups WHERE stage_id = $1')) {
      return {
        rows: [
          { id: 'group-1', name: 'A', number_teams: 2 },
          { id: 'group-2', name: 'B', number_teams: 2 },
        ],
      };
    }
    if (text.includes('FROM participant_teams WHERE tournament_id = $1')) {
      return {
        rows: [
          { id: 'team-1', name: 'One' },
          { id: 'team-2', name: 'Two' },
          { id: 'team-3', name: 'Three' },
          { id: 'team-4', name: 'Four' },
        ],
      };
    }
    if (text.includes('SELECT number_of_teams FROM tournaments')) {
      return { rows: [{ number_of_teams: 4 }] };
    }
    if (text.includes('FROM stage_draw_pot_assignments')) return { rows: [] };
    throw new Error(`Unexpected query: ${text}`);
  });
  database.query = fake.query;
  const servicePath = require.resolve('../src/services/drawService');
  const originalServiceModule = require.cache[servicePath];
  delete require.cache[servicePath];
  try {
    const draw = require(servicePath);
    const options = await draw.getDrawPotOptions('tournament-1', 'stage-1');
    assert.equal(options.eligible, true);
    assert.equal(options.groups.length, 2);
    assert.equal(options.teams.length, 4);
    assert.ok(fake.maximumActive >= 3, 'groups, participants, and saved assignments should overlap');
  } finally {
    database.query = originalQuery;
    if (originalServiceModule) require.cache[servicePath] = originalServiceModule;
    else delete require.cache[servicePath];
  }
});

test('suspension decision reads are concurrent and player sync uses batched queries', async () => {
  const database = require('../src/db');
  const originalQuery = database.query;
  const fake = delayedQuery((text, values) => {
    if (text.includes('FROM player_match_suspensions WHERE id=')) {
      return {
        rows: [{
          id: values[0],
          tournament_id: values[2],
          target_match_id: values[1],
          source_event_id: 'source-1',
          kind: 'red_card',
        }],
      };
    }
    if (text.includes('SELECT status FROM matches')) return { rows: [{ status: 'scheduled' }] };
    if (text.includes('UPDATE player_match_suspensions SET status=$1')) return { rowCount: 1, rows: [] };
    if (text.includes('SELECT m.id,m.tournament_id')) {
      return {
        rows: [{
          id: values[0],
          tournament_id: 'tournament-1',
          sequence_order: 1,
          status: 'scheduled',
        }],
      };
    }
    if (text.includes('SELECT settings FROM tournaments')) {
      return { rows: [{ settings: JSON.stringify({ suspensionSystem: { enabled: true } }) }] };
    }
    if (text.includes('SELECT pp.id FROM participant_players')) {
      return { rows: Array.from({ length: 10 }, (_, index) => ({ id: `player-${index}` })) };
    }
    if (text.includes('pp.id AS player_id')) return { rows: [] };
    if (text.includes('SELECT participant_player_id,source_event_id FROM player_match_suspensions')) {
      return { rows: [] };
    }
    if (text.includes('SELECT DISTINCT ON (pms.participant_player_id)')) return { rows: [] };
    if (text.includes('FROM player_match_suspensions pms')) return { rows: [] };
    throw new Error(`Unexpected query: ${text}`);
  });
  database.query = fake.query;
  const servicePath = require.resolve('../src/services/suspensionService');
  delete require.cache[servicePath];
  try {
    const suspension = require(servicePath);
    const suspensions = await suspension.decide({
      matchId: 'match-1',
      tournamentId: 'tournament-1',
      suspensionId: 'suspension-1',
      include: true,
      actorId: 'referee-1',
    });
    assert.deepEqual(suspensions, []);
    assert.ok(fake.maximumActive >= 2, 'suspension and match state reads should overlap');
    fake.calls.length = 0;
    await suspension.getForMatch('match-1', 'tournament-1');
    assert.equal(
      fake.calls.filter((call) => call.text.includes('pp.id AS player_id')).length,
      1,
      'prior matches for every player must load in one query, not one query per player',
    );
    assert.equal(
      fake.calls.filter((call) => call.text.includes('SELECT DISTINCT ON (pms.participant_player_id)')).length,
      1,
      'prior yellow decisions for every player must load in one query',
    );
    assert.equal(
      fake.calls.filter((call) => call.text.includes('participant_player_id = ANY') && call.text.includes("kind='red_card'")).length,
      1,
      'included red decisions for every player must load in one query',
    );
    assert.equal(
      fake.calls.filter((call) => call.text.includes('WHERE participant_player_id=$1')).length,
      0,
      'player synchronization must not issue per-player queries',
    );
  } finally {
    database.query = originalQuery;
    delete require.cache[servicePath];
  }
});

test('suspension sync derives every player decision from batched reads and one bulk insert', async () => {
  const database = require('../src/db');
  const originalQuery = database.query;
  const calls = [];
  const target = {
    id: 'match-2', tournament_id: 'tournament-1', sequence_order: 2, status: 'scheduled',
    matchday: null, created_at: '2026-01-02T00:00:00', finished_at: null,
    started_at: null, scheduled_at: '2026-01-03T00:00:00',
  };
  const priorMatch = (playerId, id) => ({
    player_id: playerId, id, tournament_id: 'tournament-1', status: 'finished',
    sequence_order: 1, matchday: 1, created_at: '2026-01-01T00:00:00',
    finished_at: '2026-01-01T12:00:00', started_at: '2026-01-01T10:00:00',
    scheduled_at: '2026-01-01T10:00:00',
  });
  const card = (id, playerId, matchId, color, createdAt, payload = '{}') => ({
    id, match_id: matchId, player_id: playerId, type: 'card', card: color, created_at: createdAt, payload,
  });
  const matchRows = [
    priorMatch('p1', 'match-1'),
    priorMatch('p2', 'match-0'),
    priorMatch('p2', 'match-1'),
    priorMatch('p3', 'match-1'),
    priorMatch('p4', 'match-1'),
  ];
  const cardRows = [
    card('red-1', 'p1', 'match-1', 'red', '2026-01-01T09:00:00'),
    card('y-1', 'p2', 'match-0', 'yellow', '2026-01-01T09:00:00'),
    card('y-2', 'p2', 'match-1', 'yellow', '2026-01-01T10:00:00'),
    card('y-3', 'p2', 'match-1', 'yellow', '2026-01-01T11:00:00'),
    card('red-2', 'p3', 'match-1', 'red', '2026-01-01T09:30:00', JSON.stringify({ automaticSecondYellow: true })),
    card('y-4', 'p3', 'match-1', 'yellow', '2026-01-01T10:00:00'),
    card('y-5', 'p3', 'match-1', 'yellow', '2026-01-01T11:00:00'),
    card('y-6', 'p4', 'match-1', 'yellow', '2026-01-01T10:00:00'),
  ];
  let insertValues;
  database.query = async (text, values = []) => {
    calls.push({ text, values });
    if (text.includes('SELECT m.id,m.tournament_id')) return { rows: [target] };
    if (text.includes('SELECT settings FROM tournaments')) {
      return { rows: [{ settings: JSON.stringify({ suspensionSystem: { enabled: true, yellowCardsForSuspension: 2 } }) }] };
    }
    if (text.includes('SELECT pp.id FROM participant_players')) {
      return { rows: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }] };
    }
    if (text.includes('pp.id AS player_id')) return { rows: matchRows };
    if (text.includes('FROM match_events')) return { rows: cardRows };
    if (text.includes('SELECT participant_player_id,source_event_id FROM player_match_suspensions')) {
      return { rows: [{ participant_player_id: 'p1', source_event_id: 'red-1' }] };
    }
    if (text.includes('SELECT DISTINCT ON (pms.participant_player_id)')) {
      return { rows: [{ participant_player_id: 'p2', source_event_id: 'y-1', source_created_at: '2026-01-01T09:00:00' }] };
    }
    if (text.includes('INSERT INTO player_match_suspensions')) {
      insertValues = values;
      return { rows: [], rowCount: values[2].length };
    }
    if (text.includes('FROM player_match_suspensions pms')) return { rows: [] };
    throw new Error(`Unexpected query: ${text}`);
  };
  const servicePath = require.resolve('../src/services/suspensionService');
  delete require.cache[servicePath];
  try {
    const suspension = require(servicePath);
    await suspension.getForMatch('match-2', 'tournament-1');

    assert.ok(insertValues, 'derived decisions must be written');
    assert.deepEqual(insertValues[2], ['p2', 'p3'], 'included red cards and sub-threshold yellows produce no decision');
    assert.deepEqual(insertValues[4], ['match-1', 'match-1'], 'sources resolve to prior matches');
    assert.deepEqual(insertValues[5], ['y-3', 'red-2'], 'yellow threshold counts only cards after the prior decision; second-yellow reds suppress yellow suspensions');
    assert.deepEqual(insertValues[6], ['yellow_threshold', 'red_card']);
    assert.deepEqual(insertValues[3], ['match-2', 'match-2']);
    assert.deepEqual(insertValues[1], ['tournament-1', 'tournament-1']);

    assert.equal(calls.filter((call) => call.text.includes('pp.id AS player_id')).length, 1);
    assert.equal(calls.filter((call) => call.text.includes('FROM match_events')).length, 1);
    assert.equal(calls.filter((call) => call.text.includes('SELECT DISTINCT ON (pms.participant_player_id)')).length, 1);
    assert.equal(calls.filter((call) => call.text.includes('INSERT INTO player_match_suspensions')).length, 1, 'all decisions must be inserted in one statement');
  } finally {
    database.query = originalQuery;
    delete require.cache[servicePath];
  }
});

test('simulation loads stage, teams, and opposing rosters concurrently', async () => {
  const database = require('../src/db');
  const originalQuery = database.query;
  const fake = delayedQuery((text, values) => {
    if (text.includes('SELECT * FROM matches WHERE id =')) {
      return {
        rows: [{
          id: values[0],
          tournament_id: 'tournament-1',
          stage_id: 'stage-1',
          status: 'scheduled',
          home_participant_team_id: 'home-1',
          away_participant_team_id: 'away-1',
          revision: 0,
        }],
      };
    }
    if (text.includes('SELECT * FROM stages WHERE id =')) {
      return { rows: [{ id: 'stage-1', type: 'league', settings: '{}' }] };
    }
    if (text.includes('SELECT * FROM participant_teams WHERE id =')) {
      return { rows: [{ id: values[0], seed: 1 }] };
    }
    if (text.includes('FROM participant_players pp')) return { rows: [] };
    if (text.includes('INSERT INTO match_events')) return { rowCount: 1 };
    throw new Error(`Unexpected query: ${text}`);
  });
  database.query = fake.query;
  const matchServicePath = require.resolve('../src/services/matchService');
  const refereeServicePath = require.resolve('../src/services/refereeService');
  const originalMatchServiceModule = require.cache[matchServicePath];
  const originalRefereeServiceModule = require.cache[refereeServicePath];
  require.cache[matchServicePath] = {
    id: matchServicePath,
    filename: matchServicePath,
    loaded: true,
    exports: {
      finishMatchRecord: async ({ matchRow }) => ({ match: { ...matchRow, status: 'finished' }, advance: null }),
      rebuildTournamentProjections: async () => {},
    },
  };
  require.cache[refereeServicePath] = {
    id: refereeServicePath,
    filename: refereeServicePath,
    loaded: true,
    exports: { getProjectedScore: async () => ({ home: 0, away: 0, extraHome: 0, extraAway: 0 }) },
  };
  const servicePath = require.resolve('../src/services/simulationService');
  delete require.cache[servicePath];
  try {
    const simulation = require(servicePath);
    const result = await simulation.simulateMatch('match-1');
    assert.equal(result.match.status, 'finished');
    assert.ok(fake.maximumActive >= 3, 'stage and both team lookups should overlap');
    assert.equal(fake.calls.filter((call) => call.text.includes('FROM participant_players pp')).length, 2);
  } finally {
    database.query = originalQuery;
    delete require.cache[servicePath];
    if (originalMatchServiceModule) require.cache[matchServicePath] = originalMatchServiceModule;
    else delete require.cache[matchServicePath];
    if (originalRefereeServiceModule) require.cache[refereeServicePath] = originalRefereeServiceModule;
    else delete require.cache[refereeServicePath];
  }
});

test('referee event eligibility validates player, match events, and linked goal concurrently', async () => {
  const database = require('../src/db');
  const originalQuery = database.query;
  const match = {
    id: 'match-1',
    tournament_id: 'tournament-1',
    status: 'live',
    phase: 'regulation',
    phase_started_at: null,
    revision: 1,
    referee_id: 'referee-1',
    home_participant_team_id: 'home-1',
    away_participant_team_id: 'away-1',
  };
  const fake = delayedQuery((text) => {
    if (text.includes('SELECT * FROM matches WHERE id = $1 AND tournament_id = $2')) {
      return { rows: [match] };
    }
    if (text.includes('SELECT * FROM matches WHERE id = $1')) return { rows: [match] };
    if (text.includes('SELECT id FROM participant_players')) return { rows: [{ id: 'assister-1' }] };
    if (text.includes('SELECT id, player_id, type, phase, team_id')) {
      return {
        rows: [{
          id: 'goal-1',
          player_id: 'scorer-1',
          type: 'goal',
          phase: 'regulation',
          team_id: 'home-1',
        }],
      };
    }
    if (text.includes('FROM match_events') && text.includes("type = 'card'")) return { rows: [] };
    if (text.includes('SELECT * FROM match_events WHERE match_id = $1')) return { rows: [] };
    if (text.includes('INSERT INTO match_events')) return { rowCount: 1 };
    if (text.includes('UPDATE matches SET revision = revision + 1')) return { rowCount: 1 };
    if (text.includes('UPDATE matches SET home_score =')) return { rowCount: 1 };
    if (text.includes('INSERT INTO match_audit')) return { rowCount: 1 };
    if (text.includes('FROM match_events e')) return { rows: [] };
    throw new Error(`Unexpected query: ${text}`);
  });
  database.query = fake.query;
  const matchServicePath = require.resolve('../src/services/matchService');
  const drawServicePath = require.resolve('../src/services/drawService');
  const originalMatchServiceModule = require.cache[matchServicePath];
  const originalDrawServiceModule = require.cache[drawServicePath];
  require.cache[matchServicePath] = {
    id: matchServicePath,
    filename: matchServicePath,
    loaded: true,
    exports: {
      assertRevision: () => {},
      rebuildTournamentProjections: async () => {},
    },
  };
  require.cache[drawServicePath] = {
    id: drawServicePath,
    filename: drawServicePath,
    loaded: true,
    exports: { reconcileStageOutputs: async () => null },
  };
  const servicePath = require.resolve('../src/services/refereeService');
  delete require.cache[servicePath];
  try {
    const referee = require(servicePath);
    const result = await referee.addEvent({
      matchId: 'match-1',
      tournamentId: 'tournament-1',
      refereeId: 'referee-1',
      type: 'assist',
      phase: 'regulation',
      payload: { teamId: 'home-1', playerId: 'assister-1', goalEventId: 'goal-1' },
      expectedRevision: 1,
    });
    assert.ok(result.eventId);
    assert.ok(fake.maximumActive >= 3, 'player ownership, event eligibility, and goal-link reads should overlap');
    assert.equal(
      fake.calls.filter((call) => call.text.includes('SELECT id, player_id, type, phase, team_id')).length,
      1,
      'goal-link validation should use one query',
    );
    assert.equal(
      fake.calls.filter((call) => call.text.includes('SELECT id FROM participant_players')).length,
      1,
      'assist ownership should be checked only once',
    );
  } finally {
    database.query = originalQuery;
    delete require.cache[servicePath];
    if (originalMatchServiceModule) require.cache[matchServicePath] = originalMatchServiceModule;
    else delete require.cache[matchServicePath];
    if (originalDrawServiceModule) require.cache[drawServicePath] = originalDrawServiceModule;
    else delete require.cache[drawServicePath];
  }
});

test('tournament roster batch loads every team roster in a constant number of queries', async () => {
  const database = require('../src/db');
  const originalQuery = database.query;
  const accessPath = require.resolve('../src/services/access');
  const originalAccessModule = require.cache[accessPath];
  const calls = [];
  database.query = async (text, values = []) => {
    calls.push({ text, values });
    if (text.includes('JOIN participant_teams pt')) {
      return {
        rows: [
          { id: 'player-1', participant_team_id: 'team-1', name: 'Alice', shirt_number: 10 },
          { id: 'player-2', participant_team_id: 'team-2', name: 'Bob', shirt_number: 7 },
        ],
      };
    }
    if (text.includes('participant_player_invite_codes') && text.includes('GROUP BY participant_team_id')) {
      return { rows: [{ participant_team_id: 'team-1', count: '2' }] };
    }
    throw new Error(`Unexpected query: ${text}`);
  };
  require.cache[accessPath] = {
    id: accessPath,
    filename: accessPath,
    loaded: true,
    exports: {
      getTournamentOrThrow: async () => ({ id: 'tournament-1' }),
      requireTournamentInspect: async () => {},
    },
  };
  const controllerPath = require.resolve('../src/controllers/catalogController');
  delete require.cache[controllerPath];
  try {
    const controller = require(controllerPath);
    let response;
    let caughtError;
    await controller.listTournamentParticipantPlayers(
      { params: { tournamentId: 'tournament-1' }, user: { id: 'user-1' } },
      { json: (body) => { response = body; } },
      (error) => { caughtError = error; },
    );
    assert.equal(caughtError, undefined);
    assert.equal(calls.length, 2, 'rosters and reserved counts must not fan out per team');
    assert.equal(response.participantPlayers.length, 2);
    assert.deepEqual(response.reservedInviteCodesByTeam, { 'team-1': 2 });
  } finally {
    database.query = originalQuery;
    delete require.cache[controllerPath];
    if (originalAccessModule) require.cache[accessPath] = originalAccessModule;
    else delete require.cache[accessPath];
  }
});

test('tournament invite-code batch purges and loads every team in a constant number of queries', async () => {
  const database = require('../src/db');
  const originalWithTransaction = database.withTransaction;
  const accessPath = require.resolve('../src/services/access');
  const originalAccessModule = require.cache[accessPath];
  const calls = [];
  database.withTransaction = async (callback) => callback({
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes('DELETE FROM participant_player_invite_codes')) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes('SELECT id, participant_team_id, created_at, expires_at')) {
        return {
          rows: [
            { id: 'code-1', participant_team_id: 'team-1', created_at: '2026-01-01', expires_at: '2026-01-08' },
            { id: 'code-2', participant_team_id: 'team-1', created_at: '2026-01-02', expires_at: '2026-01-09' },
            { id: 'code-3', participant_team_id: 'team-2', created_at: '2026-01-03', expires_at: '2026-01-10' },
          ],
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  });
  require.cache[accessPath] = {
    id: accessPath,
    filename: accessPath,
    loaded: true,
    exports: { getTournamentOrThrow: async () => ({ id: 'tournament-1' }) },
  };
  const controllerPath = require.resolve('../src/controllers/catalogController');
  delete require.cache[controllerPath];
  try {
    const controller = require(controllerPath);
    let response;
    let caughtError;
    await controller.listTournamentPlayerInviteCodes(
      { params: { tournamentId: 'tournament-1' }, user: { id: 'admin-1', role: 'admin' } },
      { json: (body) => { response = body; } },
      (error) => { caughtError = error; },
    );
    assert.equal(caughtError, undefined);
    assert.equal(calls.length, 2, 'purge and live-code select must run once for the whole tournament');
    assert.deepEqual(Object.keys(response.inviteCodesByTeam).sort(), ['team-1', 'team-2']);
    assert.equal(response.inviteCodesByTeam['team-1'].length, 2);
    assert.deepEqual(response.inviteCodesByTeam['team-2'][0], {
      id: 'code-3',
      createdAt: '2026-01-03',
      expiresAt: '2026-01-10',
    });
  } finally {
    database.withTransaction = originalWithTransaction;
    delete require.cache[controllerPath];
    if (originalAccessModule) require.cache[accessPath] = originalAccessModule;
    else delete require.cache[accessPath];
  }
});

test('votes list embeds every vote\'s nominees from a single batch query', async () => {
  const database = require('../src/db');
  const originalQuery = database.query;
  const accessPath = require.resolve('../src/services/access');
  const servicePath = require.resolve('../src/services/voteService');
  const originalAccessModule = require.cache[accessPath];
  const calls = [];
  database.query = async (text, values = []) => {
    calls.push({ text, values });
    if (text.includes('SELECT * FROM tournaments')) return { rows: [{ id: 'tournament-1' }] };
    if (text.includes('FROM vote v')) {
      return {
        rows: [
          { id: 'vote-1', tournament_id: 'tournament-1', name: 'MVP', award: 'A', status: 'open' },
          { id: 'vote-2', tournament_id: 'tournament-1', name: 'Best', award: 'B', status: 'open' },
        ],
      };
    }
    if (text.includes('FROM vote_nominees vn')) {
      return {
        rows: [
          { vote_id: 'vote-1', nominee_id: 'player-1', votes: '3', player_name: 'Alice', selected_by_viewer: 1 },
          { vote_id: 'vote-2', nominee_id: 'player-2', votes: '0', player_name: 'Bob', selected_by_viewer: 0 },
        ],
      };
    }
    throw new Error(`Unexpected query: ${text}`);
  };
  require.cache[accessPath] = {
    id: accessPath,
    filename: accessPath,
    loaded: true,
    exports: { requireTournamentInspect: async () => {} },
  };
  const controllerPath = require.resolve('../src/controllers/voteController');
  delete require.cache[servicePath];
  delete require.cache[controllerPath];
  try {
    const controller = require(controllerPath);
    let response;
    let caughtError;
    await controller.listVotes(
      { params: { tournamentId: 'tournament-1' }, user: { id: 'user-1' } },
      { json: (body) => { response = body; } },
      (error) => { caughtError = error; },
    );
    assert.equal(caughtError, undefined);
    assert.equal(response.votes.length, 2);
    assert.equal(response.votes[0].nominees[0].player.name, 'Alice');
    assert.equal(response.votes[0].nominees[0].selectedByViewer, true);
    assert.equal(response.votes[1].nominees[0].player.name, 'Bob');
    assert.equal(
      calls.filter((call) => call.text.includes('FROM vote_nominees vn')).length,
      1,
      'all nominees must be loaded in one query, not one per vote',
    );
  } finally {
    database.query = originalQuery;
    delete require.cache[servicePath];
    delete require.cache[controllerPath];
    if (originalAccessModule) require.cache[accessPath] = originalAccessModule;
    else delete require.cache[accessPath];
  }
});

test('tournament projection rebuild aggregates every projection with a constant number of queries', async () => {
  const database = require('../src/db');
  const originalWithTransaction = database.withTransaction;
  const servicePath = require.resolve('../src/services/matchService');
  const calls = [];
  const matches = [
    { id: 'match-1', stage_id: 'stage-1', home_participant_team_id: 'team-1', away_participant_team_id: 'team-2', type: 'league', settings: '{}' },
    { id: 'match-2', stage_id: 'stage-1', home_participant_team_id: 'team-1', away_participant_team_id: 'team-3', type: 'league', settings: '{}' },
  ];
  const events = [
    { match_id: 'match-1', type: 'goal', phase: 'regulation', team_id: 'team-1', player_id: 'p1', payload: '{}' },
    { match_id: 'match-1', type: 'goal', phase: 'regulation', team_id: 'team-2', player_id: 'p2', payload: '{}' },
    { match_id: 'match-1', type: 'card', phase: 'regulation', team_id: 'team-1', player_id: 'p1', card: 'yellow', payload: '{}' },
    { match_id: 'match-2', type: 'goal', phase: 'regulation', team_id: 'team-1', player_id: 'p1', payload: '{}' },
    { match_id: 'match-2', type: 'goal', phase: 'regulation', team_id: 'team-1', player_id: 'p1', payload: '{}' },
    { match_id: 'match-2', type: 'card', phase: 'regulation', team_id: 'team-3', player_id: 'p3', card: 'red', payload: '{}' },
  ];
  const client = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes('FROM match_events me')) return { rows: events };
      if (text.includes('FROM matches m JOIN stages s')) return { rows: matches };
      return { rows: [], rowCount: 0 };
    },
  };
  database.withTransaction = (callback) => callback(client);
  delete require.cache[servicePath];
  try {
    const service = require(servicePath);
    await service.rebuildTournamentProjections('tournament-1');

    const bulkMatch = calls.find((call) => call.text.includes('UPDATE matches m') && call.text.includes('unnest'));
    const bulkPlayers = calls.find((call) => call.text.includes('UPDATE participant_players pp') && call.text.includes('unnest'));
    const bulkTeams = calls.find((call) => call.text.includes('UPDATE participant_teams pt') && call.text.includes('unnest'));

    assert.deepEqual(bulkMatch.values[0], ['match-1', 'match-2']);
    assert.deepEqual(bulkMatch.values[1], [1, 2], 'home goals per match');
    assert.deepEqual(bulkMatch.values[2], [1, 0], 'away goals per match');

    const playerIndex = Object.fromEntries(bulkPlayers.values[0].map((id, i) => [id, i]));
    assert.equal(bulkPlayers.values[1][playerIndex.p1], 3, 'player goals aggregate across matches');
    assert.equal(bulkPlayers.values[1][playerIndex.p2], 1);
    assert.equal(bulkPlayers.values[3][playerIndex.p1], 1, 'yellow cards aggregate');
    assert.equal(bulkPlayers.values[4][playerIndex.p3], 1, 'red cards aggregate');

    const teamIndex = Object.fromEntries(bulkTeams.values[0].map((id, i) => [id, i]));
    const at = (row, id) => bulkTeams.values[row][teamIndex[id]];
    assert.equal(at(1, 'team-1'), 2, 'played');
    assert.equal(at(2, 'team-1'), 1, 'won');
    assert.equal(at(3, 'team-1'), 1, 'drawn');
    assert.equal(at(4, 'team-1'), 0, 'lost');
    assert.equal(at(5, 'team-1'), 3, 'goals for');
    assert.equal(at(6, 'team-1'), 1, 'goals against');
    assert.equal(at(7, 'team-1'), 4, 'points');
    assert.equal(at(7, 'team-2'), 1, 'draw points');
    assert.equal(at(7, 'team-3'), 0, 'loss points');
    assert.equal(at(4, 'team-3'), 1, 'losses');

    assert.equal(calls.filter((call) => call.text.includes('unnest')).length, 3, 'one bulk update each for matches, players, and teams');
    assert.equal(calls.filter((call) => call.text.includes('match_events')).length, 1, 'all events load in one query');
    assert.equal(calls.length, 7, 'total query count is constant regardless of matches, teams, players, or events');
  } finally {
    database.withTransaction = originalWithTransaction;
    delete require.cache[servicePath];
  }
});

test('impact confirmation counts every selected stage with a single grouped query', async () => {
  const database = require('../src/db');
  const originalQuery = database.query;
  const accessPath = require.resolve('../src/services/access');
  const originalAccessModule = require.cache[accessPath];
  const calls = [];
  database.query = async (text, values = []) => {
    calls.push({ text, values });
    if (text.includes('SELECT m.stage_id, m.revision')) return { rows: [{ stage_id: 'stage-1', revision: 1, sequence_order: 0 }] };
    if (text.includes('SELECT id FROM stages')) return { rows: [{ id: 'stage-2' }, { id: 'stage-3' }] };
    if (text.includes('COUNT(*) AS total')) {
      return { rows: [{ stage_id: 'stage-2', total: '0', started: '0' }, { stage_id: 'stage-3', total: '0', started: '0' }] };
    }
    throw new Error(`Unexpected query: ${text}`);
  };
  require.cache[accessPath] = {
    id: accessPath,
    filename: accessPath,
    loaded: true,
    exports: { getTournamentOrThrow: async () => ({ id: 'tournament-1' }) },
  };
  const controllerPath = require.resolve('../src/controllers/refereeController');
  delete require.cache[controllerPath];
  try {
    const controller = require(controllerPath);
    let response;
    let caughtError;
    await controller.applyImpact(
      {
        params: { id: 'match-1', tournamentId: 'tournament-1' },
        body: { revision: 1, stageIds: ['stage-2', 'stage-3'] },
        user: { id: 'ref-1' },
      },
      { json: (body) => { response = body; } },
      (error) => { caughtError = error; },
    );
    assert.equal(caughtError, undefined);
    assert.deepEqual(response.results, [
      { stageId: 'stage-2', action: 'none' },
      { stageId: 'stage-3', action: 'none' },
    ]);
    assert.equal(
      calls.filter((call) => call.text.includes('COUNT(*) AS total')).length,
      1,
      'selected stage states must be counted in one grouped query, not one per stage',
    );
    const countCall = calls.find((call) => call.text.includes('COUNT(*) AS total'));
    assert.deepEqual(countCall.values[1], ['stage-2', 'stage-3']);
  } finally {
    database.query = originalQuery;
    delete require.cache[controllerPath];
    if (originalAccessModule) require.cache[accessPath] = originalAccessModule;
    else delete require.cache[accessPath];
  }
});

test('tournament update skips invite-code cleanup when registration settings are unchanged', async () => {
  const database = require('../src/db');
  const originalQuery = database.query;
  const originalWithTransaction = database.withTransaction;
  const accessPath = require.resolve('../src/services/access');
  const originalAccessModule = require.cache[accessPath];
  const calls = [];
  const row = {
    id: 'tournament-1', name: 'T', slug: 't', status: 'draft', visibility: 'public',
    number_of_teams: 3, place: null, settings: '{}', revision: 0, created_by: 'admin-1',
  };
  const respond = async (text, values = []) => {
    calls.push({ text, values });
    if (text.startsWith('UPDATE tournaments')) return { rows: [], rowCount: 1 };
    if (text === 'SELECT * FROM tournaments WHERE id = $1') return { rows: [row] };
    throw new Error(`Unexpected query: ${text}`);
  };
  database.query = respond;
  database.withTransaction = (callback) => callback({ query: respond });
  require.cache[accessPath] = {
    id: accessPath,
    filename: accessPath,
    loaded: true,
    exports: {
      getTournamentOrThrow: async () => row,
      requireTournamentPermission: async () => {},
    },
  };
  const controllerPath = require.resolve('../src/controllers/tournamentController');
  delete require.cache[controllerPath];
  try {
    const controller = require(controllerPath);
    let caughtError;
    await controller.update(
      { params: { tournamentId: 'tournament-1' }, body: { name: 'T2' }, user: { id: 'admin-1' } },
      { json: () => {} },
      (error) => { caughtError = error; },
    );
    assert.equal(caughtError, undefined);
    assert.equal(
      calls.filter((call) => call.text.includes('participant_player_invite_codes')).length,
      0,
      'an unrelated update must not touch invite codes',
    );
    assert.equal(calls.filter((call) => call.text.includes('FOR UPDATE')).length, 0, 'teams should not be locked when registration settings are unchanged');
  } finally {
    database.query = originalQuery;
    database.withTransaction = originalWithTransaction;
    delete require.cache[controllerPath];
    if (originalAccessModule) require.cache[accessPath] = originalAccessModule;
    else delete require.cache[accessPath];
  }
});

test('tournament update reconciles invite codes with set-based queries when registration settings change', async () => {
  const database = require('../src/db');
  const originalQuery = database.query;
  const originalWithTransaction = database.withTransaction;
  const accessPath = require.resolve('../src/services/access');
  const originalAccessModule = require.cache[accessPath];
  const calls = [];
  const row = {
    id: 'tournament-1', name: 'T', slug: 't', status: 'draft', visibility: 'public',
    number_of_teams: 3, place: null, settings: '{}', revision: 0, created_by: 'admin-1',
  };
  const respond = async (text, values = []) => {
    calls.push({ text, values });
    if (text.startsWith('UPDATE tournaments')) return { rows: [], rowCount: 1 };
    if (text === 'SELECT * FROM tournaments WHERE id = $1') return { rows: [row] };
    if (text.includes('SELECT id FROM participant_teams') && text.includes('FOR UPDATE')) {
      return { rows: [{ id: 'team-1' }, { id: 'team-2' }] };
    }
    if (text.startsWith('DELETE FROM participant_player_invite_codes')) return { rows: [], rowCount: 0 };
    if (text.startsWith('WITH team_slots')) return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected query: ${text}`);
  };
  database.query = respond;
  database.withTransaction = (callback) => callback({ query: respond });
  require.cache[accessPath] = {
    id: accessPath,
    filename: accessPath,
    loaded: true,
    exports: {
      getTournamentOrThrow: async () => row,
      requireTournamentPermission: async () => {},
    },
  };
  const controllerPath = require.resolve('../src/controllers/tournamentController');
  delete require.cache[controllerPath];
  try {
    const controller = require(controllerPath);
    let caughtError;
    await controller.update(
      {
        params: { tournamentId: 'tournament-1' },
        body: { settings: { playerRegistrationMode: 'invite_code' } },
        user: { id: 'admin-1' },
      },
      { json: () => {} },
      (error) => { caughtError = error; },
    );
    assert.equal(caughtError, undefined);
    assert.equal(
      calls.filter((call) => call.text.includes('participant_team_id = $1')).length,
      0,
      'cleanup must not run one query per team',
    );
    assert.equal(
      calls.filter((call) => call.text.startsWith('WITH team_slots')).length,
      1,
      'excess invite codes must be pruned with a single set-based delete',
    );
  } finally {
    database.query = originalQuery;
    database.withTransaction = originalWithTransaction;
    delete require.cache[controllerPath];
    if (originalAccessModule) require.cache[accessPath] = originalAccessModule;
    else delete require.cache[accessPath];
  }
});
