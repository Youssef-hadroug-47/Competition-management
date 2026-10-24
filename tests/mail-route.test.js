const test = require('node:test');
const assert = require('node:assert/strict');

test('mail test route sends to the requested recipient and maps delivery failures', async () => {
  const originalConsoleError = console.error;
  const servicePath = require.resolve('../src/services/emailService');
  const originalService = require.cache[servicePath];
  const calls = [];
  let handler = async () => ({ messageId: 'test-message' });
  require.cache[servicePath] = {
    id: servicePath,
    filename: servicePath,
    loaded: true,
    exports: {
      sendTestEmail: async (to) => {
        calls.push(to);
        return handler(to);
      },
    },
  };
  const controllerPath = require.resolve('../src/controllers/mailController');
  delete require.cache[controllerPath];
  console.error = () => {};
  try {
    const controller = require(controllerPath);
    const invoke = async (req) => {
      let result;
      let error;
      await controller.sendTestEmail(
        req,
        { json: (body) => { result = body; } },
        (err) => { error = err; },
      );
      return { result, error };
    };

    let outcome = await invoke({ body: {}, user: { email: 'admin@example.com' } });
    assert.equal(outcome.error, undefined);
    assert.deepEqual(outcome.result, { ok: true, to: 'admin@example.com', messageId: 'test-message' });

    outcome = await invoke({ body: { to: ' someone@example.com ' }, user: { email: 'admin@example.com' } });
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.result.to, 'someone@example.com');

    outcome = await invoke({ body: { to: 'not-an-email' }, user: { email: 'admin@example.com' } });
    assert.equal(outcome.error.status, 400);
    assert.equal(calls.length, 2, 'invalid recipients must not reach the mail service');

    const failures = [
      ['EMAIL_NOT_CONFIGURED', 503],
      ['EAUTH', 502],
      ['ETIMEDOUT', 502],
      ['EUNKNOWN', 502],
    ];
    for (const [code, status] of failures) {
      handler = async () => {
        const error = new Error(code);
        error.code = code;
        throw error;
      };
      outcome = await invoke({ body: { to: 'admin@example.com' }, user: { email: 'admin@example.com' } });
      assert.equal(outcome.error.status, status, code);
    }
  } finally {
    console.error = originalConsoleError;
    delete require.cache[controllerPath];
    if (originalService) require.cache[servicePath] = originalService;
    else delete require.cache[servicePath];
  }
});
