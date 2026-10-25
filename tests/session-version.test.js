const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const dbPath = require.resolve('../src/db');
const configPath = require.resolve('../src/config');
const authPath = require.resolve('../src/middleware/auth');

const originalDb = require.cache[dbPath];
const originalConfig = require.cache[configPath];

let rows = [];

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { query: async () => ({ rows }) },
};
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: { jwtSecret: 'test-secret' },
};

const { authOptional } = require(authPath);

test.after(() => {
  delete require.cache[authPath];
  if (originalDb) require.cache[dbPath] = originalDb;
  else delete require.cache[dbPath];
  if (originalConfig) require.cache[configPath] = originalConfig;
  else delete require.cache[configPath];
});

function signed(claims) {
  return jwt.sign(claims, 'test-secret', { expiresIn: '1h' });
}

async function userFor(token) {
  const req = { headers: { authorization: `Bearer ${token}` } };
  await authOptional(req, {}, () => {});
  return req.user;
}

test('authenticate accepts a token matching the current version', async () => {
  rows = [{ id: 'user-1', role: 'user', token_version: 1 }];
  const user = await userFor(signed({ sub: 'user-1', role: 'user', tv: 1 }));
  assert.equal(user.id, 'user-1');
});

test('authenticate treats a missing version as zero', async () => {
  rows = [{ id: 'user-1', role: 'user', token_version: 0 }];
  const user = await userFor(signed({ sub: 'user-1', role: 'user' }));
  assert.equal(user.id, 'user-1');
});

test('authenticate rejects a token issued before a password reset', async () => {
  rows = [{ id: 'user-1', role: 'user', token_version: 1 }];
  const user = await userFor(signed({ sub: 'user-1', role: 'user', tv: 0 }));
  assert.equal(user, null);
});

test('authenticate rejects a token whose version is stale', async () => {
  rows = [{ id: 'user-1', role: 'user', token_version: 2 }];
  const user = await userFor(signed({ sub: 'user-1', role: 'user', tv: 1 }));
  assert.equal(user, null);
});
