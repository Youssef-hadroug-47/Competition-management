const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createActivityTracker } = require('../frontend/public/js/page-activity');

test('activity tracker keeps the page busy until every request settles', () => {
  const updates = [];
  const tracker = createActivityTracker((state) => updates.push(state));

  const finishLoad = tracker.begin('GET');
  assert.deepEqual(tracker.snapshot(), { count: 1, processing: 0 });
  const finishSave = tracker.begin('POST');
  assert.deepEqual(tracker.snapshot(), { count: 2, processing: 1 });

  finishLoad();
  assert.deepEqual(tracker.snapshot(), { count: 1, processing: 1 });
  finishLoad();
  assert.deepEqual(tracker.snapshot(), { count: 1, processing: 1 });
  finishSave();
  assert.deepEqual(tracker.snapshot(), { count: 0, processing: 0 });
  assert.deepEqual(updates.map(({ count }) => count), [1, 2, 1, 0]);
});

test('activity tracker releases failed requests and classifies reads separately', async () => {
  const updates = [];
  const tracker = createActivityTracker((state) => updates.push(state));

  await assert.rejects(
    tracker.run('PATCH', async () => {
      throw new Error('request failed');
    }),
    /request failed/,
  );

  assert.deepEqual(tracker.snapshot(), { count: 0, processing: 0 });
  assert.deepEqual(updates.at(-1), { count: 0, processing: 0 });

  let resolveRead;
  const read = tracker.run('OPTIONS', () => new Promise((resolve) => { resolveRead = resolve; }));
  assert.deepEqual(tracker.snapshot(), { count: 1, processing: 0 });
  await Promise.resolve();
  resolveRead('complete');
  assert.equal(await read, 'complete');
  assert.deepEqual(tracker.snapshot(), { count: 0, processing: 0 });
});

test('every API-backed frontend page installs activity blocking before the API client', () => {
  const publicDirectory = path.join(__dirname, '../frontend/public');
  const pages = fs.readdirSync(publicDirectory).filter((file) => file.endsWith('.html'));
  const apiPages = pages.filter((file) => {
    const html = fs.readFileSync(path.join(publicDirectory, file), 'utf8');
    return html.includes('/js/api.js');
  });

  assert.ok(apiPages.length > 0);
  for (const page of apiPages) {
    const html = fs.readFileSync(path.join(publicDirectory, page), 'utf8');
    assert.ok(
      html.indexOf('/js/page-activity.js') >= 0
        && html.indexOf('/js/page-activity.js') < html.indexOf('/js/api.js'),
      `${page} must install the activity blocker before the API client`,
    );
  }
});
