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
  const fake = delayedQuery((text, values) => {
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
    if (text.includes('SELECT pt.*')) {
      return { rows: groupTeams[values[0]] };
    }
    if (text.includes('SELECT home_participant_team_id AS home')) {
      const [first, second] = groupTeams[values[0]].map((team) => team.id);
      return {
        rows: [{
          home: first,
          away: second,
          home_score: 2,
          away_score: 0,
        }],
      };
    }
    if (text.includes('FROM participant_players pp')) return { rows: [] };
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
      fake.calls.filter((call) => call.text.includes('SELECT home_participant_team_id AS home')).length,
      2,
      'head-to-head matches should be fetched once per group, not once per tie bucket',
    );
    assert.equal(
      fake.calls.filter((call) => call.text.includes('LEFT JOIN LATERAL')).length,
      2,
      'card totals should be aggregated into each group team query rather than fetched in a follow-up query',
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

test('suspension decision reads are concurrent and player sync is bounded', async () => {
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
    if (text.includes('JOIN participant_players pp')) return { rows: [] };
    if (text.includes('FROM player_match_suspensions WHERE participant_player_id=')) {
      return { rows: [] };
    }
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
    assert.ok(fake.maximumActive <= 8, 'suspension derivation should cap concurrent player work');
    assert.equal(fake.maximumActive, 8, 'independent player synchronization should fill one bounded batch');
    await suspension.getForMatch('match-1', 'tournament-1');
    assert.ok(fake.maximumActive >= 2, 'suspension derivation should process independent players concurrently');
    assert.ok(fake.maximumActive <= 8, 'suspension derivation should cap concurrent player work');
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
