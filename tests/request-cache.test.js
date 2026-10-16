const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequestCache } = require('../frontend/public/js/request-cache');

test('request cache shares in-flight and completed values by key', async () => {
  const cache = createRequestCache();
  let calls = 0;
  let resolveLoad;
  const loader = () => {
    calls += 1;
    return new Promise((resolve) => { resolveLoad = resolve; });
  };

  const first = cache.getOrLoad('team-1', loader);
  const second = cache.getOrLoad('team-1', loader);
  assert.strictEqual(first, second);
  assert.equal(cache.isCurrent('team-1', first), true);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolveLoad({ players: [] });

  const [firstValue, secondValue] = await Promise.all([first, second]);
  assert.deepEqual(firstValue, { players: [] });
  assert.strictEqual(firstValue, secondValue);
  assert.strictEqual(cache.getOrLoad('team-1', loader), first);
  assert.equal(calls, 1);
});

test('request cache invalidation reloads only the affected key', async () => {
  const cache = createRequestCache();
  let firstKeyCalls = 0;
  let secondKeyCalls = 0;

  await cache.getOrLoad('team-1', async () => ({ value: ++firstKeyCalls }));
  await cache.getOrLoad('team-2', async () => ({ value: ++secondKeyCalls }));
  const cachedRequest = cache.getOrLoad('team-1', async () => ({ value: ++firstKeyCalls }));
  cache.delete('team-1');
  assert.equal(cache.isCurrent('team-1', cachedRequest), false);

  assert.deepEqual(await cache.getOrLoad('team-1', async () => ({ value: ++firstKeyCalls })), { value: 2 });
  assert.deepEqual(await cache.getOrLoad('team-2', async () => ({ value: ++secondKeyCalls })), { value: 1 });
  assert.equal(firstKeyCalls, 2);
  assert.equal(secondKeyCalls, 1);
});

test('failed requests are evicted so the next call can retry', async () => {
  const cache = createRequestCache();
  let calls = 0;

  await assert.rejects(
    cache.getOrLoad('team-1', async () => {
      calls += 1;
      throw new Error('temporary failure');
    }),
    /temporary failure/,
  );
  assert.deepEqual(
    await cache.getOrLoad('team-1', async () => {
      calls += 1;
      return { players: ['player-1'] };
    }),
    { players: ['player-1'] },
  );
  assert.equal(calls, 2);
});
