const test = require('node:test');
const assert = require('node:assert/strict');
const map = require('../src/services/mappers');
const {
  playerRegistrationMode,
  assertPlayerRegistrationStrategy,
  assertRosterCapacity,
  normalizedInviteCode,
  inviteCodeHash,
} = require('../src/controllers/catalogController');

test('older tournament settings normalize to direct player registration', () => {
  assert.equal(map.defaultTournamentSettings().playerRegistrationMode, 'direct');
  assert.equal(
    map.tournament({ id: 'tournament-1', settings: '{}' }).playerRegistrationMode,
    'direct',
  );
});

test('registration mode defaults to direct and accepts only configured modes', () => {
  assert.equal(playerRegistrationMode({}), 'direct');
  assert.equal(playerRegistrationMode({ playerRegistrationMode: 'invite_code' }), 'invite_code');
  assert.equal(playerRegistrationMode({ playerRegistrationMode: 'invalid' }), 'direct');
});

test('registration policy rejects disabled entry paths and permits enabled strategies', () => {
  assert.throws(
    () => assertPlayerRegistrationStrategy({ playerRegistrationMode: 'invite_code' }, 'direct'),
    (error) => error.status === 403,
  );
  assert.throws(
    () => assertPlayerRegistrationStrategy({ playerRegistrationMode: 'direct' }, 'invite_code'),
    (error) => error.status === 403,
  );
  assert.doesNotThrow(
    () => assertPlayerRegistrationStrategy({ playerRegistrationMode: 'both' }, 'direct'),
  );
  assert.doesNotThrow(
    () => assertPlayerRegistrationStrategy({ playerRegistrationMode: 'both' }, 'invite_code'),
  );
  assert.doesNotThrow(
    () => assertPlayerRegistrationStrategy({ playerRegistrationMode: 'invite_code' }, 'direct', true),
  );
});

test('roster capacity counts reserved invite slots', () => {
  const roster = { count: 3, maximum: 6, reservedInviteCodes: 2 };
  assert.doesNotThrow(() => assertRosterCapacity(roster, 4));
  assert.throws(
    () => assertRosterCapacity(roster, 5),
    (error) => error.status === 409,
  );
  assert.doesNotThrow(() => assertRosterCapacity(roster, 5, 1));
});

test('invite codes require 16 hex characters and are hashed before storage', () => {
  const code = 'aBcD1234Ef567890';
  assert.equal(normalizedInviteCode(code), code.toLowerCase());
  assert.throws(() => normalizedInviteCode('abcd1234'), (error) => error.status === 400);
  assert.throws(() => normalizedInviteCode('abcdefghijklmnop'), (error) => error.status === 400);
  const hash = inviteCodeHash(code.toLowerCase());
  assert.match(hash, /^[a-f\d]{64}$/);
  assert.notEqual(hash, code.toLowerCase());
  assert.equal(inviteCodeHash(code.toLowerCase()), hash);
});
