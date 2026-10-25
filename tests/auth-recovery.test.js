const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const dbPath = require.resolve('../src/db');
const emailPath = require.resolve('../src/services/emailService');
const controllerPath = require.resolve('../src/controllers/authController');

let queryImpl = async () => ({ rows: [] });
let clientQueryImpl = async () => ({ rows: [] });
let sendImpl = async () => {};
const client = { query: (...args) => clientQueryImpl(...args) };

const originalDb = require.cache[dbPath];
const originalEmail = require.cache[emailPath];

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: (...args) => queryImpl(...args),
    withTransaction: (fn) => fn(client),
  },
};
require.cache[emailPath] = {
  id: emailPath,
  filename: emailPath,
  loaded: true,
  exports: { sendVerificationEmail: (...args) => sendImpl(...args) },
};

const controller = require(controllerPath);

test.after(() => {
  delete require.cache[controllerPath];
  if (originalDb) require.cache[dbPath] = originalDb;
  else delete require.cache[dbPath];
  if (originalEmail) require.cache[emailPath] = originalEmail;
  else delete require.cache[emailPath];
});

function invoke(handler, req) {
  return new Promise((resolve) => {
    const res = {
      headers: {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      set(key, value) {
        this.headers[key] = value;
        return this;
      },
      json(body) {
        resolve({ body, res: this });
      },
    };
    controller[handler](req, res, (error) => resolve({ error, res }));
  });
}

test('register rejects a duplicate without looking up verification state', async () => {
  clientQueryImpl = async () => {
    const error = new Error('duplicate key value violates unique constraint');
    error.code = '23505';
    throw error;
  };
  queryImpl = async () => {
    throw new Error('register must not query the existing account');
  };

  const { error } = await invoke('register', {
    body: { email: 'a@example.com', password: 'password123', name: 'A' },
  });

  assert.equal(error.status, 409);
  assert.equal(error.details.code, 'EMAIL_TAKEN');
  assert.match(error.message, /already exists/);
});

test('register reports a delivery failure with a stable code', async () => {
  clientQueryImpl = async (text) => {
    if (text.startsWith('INSERT INTO users')) return { rows: [] };
    if (text.includes('SELECT * FROM users')) {
      return { rows: [{ id: 'user-1', email: 'a@example.com', name: 'A' }] };
    }
    if (text.includes('INSERT INTO email_verification_tokens')) return { rows: [] };
    throw new Error(`Unexpected query: ${text}`);
  };
  queryImpl = async () => ({ rows: [] });
  sendImpl = async () => {
    const error = new Error('mail is not configured');
    error.code = 'EMAIL_NOT_CONFIGURED';
    throw error;
  };

  const { error } = await invoke('register', {
    body: { email: 'a@example.com', password: 'password123', name: 'A' },
  });

  assert.equal(error.status, 503);
  assert.equal(error.details.code, 'EMAIL_DELIVERY_FAILED');
});

test('login flags an unverified account with a stable code', async () => {
  queryImpl = async () => ({
    rows: [{
      id: 'user-1',
      email: 'a@example.com',
      password_hash: bcrypt.hashSync('password123', 4),
      role: 'user',
      email_verified: false,
    }],
  });

  const { error } = await invoke('login', {
    body: { email: 'a@example.com', password: 'password123' },
  });

  assert.equal(error.status, 403);
  assert.equal(error.details.code, 'EMAIL_NOT_VERIFIED');
});

test('resend reports the remaining cooldown in details and Retry-After', async () => {
  clientQueryImpl = async (text) => {
    if (text.includes('FROM users')) {
      return { rows: [{ id: 'user-1', email: 'a@example.com', name: 'A', email_verified: false }] };
    }
    if (text.includes('FROM email_verification_tokens')) {
      return { rows: [{ sent_at: new Date(Date.now() - 10_000).toISOString() }] };
    }
    throw new Error(`Unexpected query: ${text}`);
  };

  const { error, res } = await invoke('resendVerification', {
    body: { email: 'a@example.com' },
  });

  assert.equal(error.status, 429);
  assert.equal(error.details.code, 'VERIFICATION_COOLDOWN');
  assert.ok(error.details.retryAfterSeconds >= 49);
  assert.equal(Number(res.headers['Retry-After']), error.details.retryAfterSeconds);
});

test('resend stays generic for unknown addresses and sends nothing', async () => {
  clientQueryImpl = async () => ({ rows: [] });
  let sent = 0;
  sendImpl = async () => {
    sent += 1;
  };

  const { body, error } = await invoke('resendVerification', {
    body: { email: 'missing@example.com' },
  });

  assert.equal(error, undefined);
  assert.match(body.message, /Request processed/);
  assert.equal(sent, 0);
});
