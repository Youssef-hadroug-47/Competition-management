const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const configPath = require.resolve('../src/config');
const middlewarePath = require.resolve('../src/middleware/tournamentCreation');
const policyPath = require.resolve('../src/services/accessPolicy');

const originalConfig = require.cache[configPath];
const config = { tournamentCreation: '*' };

require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: config,
};

const { requireTournamentCreation } = require(middlewarePath);
const { canCreateTournament } = require(policyPath);

test.after(() => {
  delete require.cache[middlewarePath];
  delete require.cache[policyPath];
  if (originalConfig) require.cache[configPath] = originalConfig;
  else delete require.cache[configPath];
});

function run(req) {
  return new Promise((resolve) => {
    requireTournamentCreation(req, {}, (error) => resolve(error));
  });
}

const regularUser = { id: 'user-1', role: 'user' };
const adminUser = { id: 'admin-1', role: 'admin' };

test("'*' allows any authenticated user", async () => {
  config.tournamentCreation = '*';
  assert.equal(await run({ user: regularUser }), undefined);
  assert.equal(canCreateTournament(regularUser), true);
});

test("'admin' allows administrators", async () => {
  config.tournamentCreation = 'admin';
  assert.equal(await run({ user: adminUser }), undefined);
  assert.equal(canCreateTournament(adminUser), true);
});

test("'admin' rejects regular users with a stable code", async () => {
  config.tournamentCreation = 'admin';
  const error = await run({ user: regularUser });
  assert.equal(error.status, 403);
  assert.equal(error.details.code, 'TOURNAMENT_CREATION_FORBIDDEN');
  assert.equal(canCreateTournament(regularUser), false);
});

test('missing authentication returns 401', async () => {
  config.tournamentCreation = '*';
  const error = await run({});
  assert.equal(error.status, 401);
  assert.equal(error.details.code, 'AUTH_REQUIRED');
});

test('an invalid runtime mode returns 503', async () => {
  config.tournamentCreation = 'owner';
  const error = await run({ user: adminUser });
  assert.equal(error.status, 503);
  assert.equal(error.details.code, 'TOURNAMENT_CREATION_MISCONFIGURED');
  assert.equal(canCreateTournament(adminUser), false);
});

test('config rejects an invalid TOURNAMENT_CREATION value at startup', () => {
  const root = path.resolve(__dirname, '..');
  assert.throws(
    () => execFileSync(process.execPath, ['-e', "require('./src/config')"], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'test', TOURNAMENT_CREATION: 'owner' },
      stdio: 'pipe',
    }),
    (error) => error.status !== 0 && /TOURNAMENT_CREATION/.test(String(error.stderr)),
  );
});

test("config defaults an empty TOURNAMENT_CREATION to '*'", () => {
  const root = path.resolve(__dirname, '..');
  const output = execFileSync(
    process.execPath,
    ['-e', "process.stdout.write(require('./src/config').tournamentCreation)"],
    {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'test', TOURNAMENT_CREATION: '' },
      encoding: 'utf8',
      stdio: 'pipe',
    },
  );
  assert.equal(output.slice(-1), '*');
});
