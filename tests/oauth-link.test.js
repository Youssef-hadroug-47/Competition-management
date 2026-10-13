const test = require('node:test');
const assert = require('node:assert/strict');
const { linkGoogleUserToApplication } = require('../src/controllers/authController');

function createClient(initialUsers = [], initialLinks = []) {
  const users = initialUsers.map((user) => ({ ...user }));
  const links = new Map(initialLinks);
  const verificationTokens = new Set();
  return {
    users,
    links,
    verificationTokens,
    async query(sql, values) {
      if (sql.includes('FROM oauth_user_links l')) {
        const userId = links.get(values[0]);
        return { rows: users.filter((user) => user.id === userId) };
      }
      if (sql.startsWith('SELECT * FROM users WHERE lower(email)')) {
        const email = values[0];
        return { rows: users.filter((user) => user.email.toLowerCase() === email) };
      }
      if (sql.startsWith('INSERT INTO users')) {
        if (users.some((user) => user.email === values[1])) return { rows: [] };
        const user = {
          id: values[0],
          email: values[1],
          password_hash: null,
          name: values[2],
          role: 'user',
          email_verified: true,
        };
        users.push(user);
        return { rows: [user] };
      }
      if (sql.startsWith('UPDATE users SET email_verified')) {
        const user = users.find((entry) => entry.id === values[0]);
        if (!user) return { rows: [] };
        user.email_verified = true;
        return { rows: [user] };
      }
      if (sql.startsWith('DELETE FROM email_verification_tokens')) {
        verificationTokens.delete(values[0]);
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO oauth_user_links')) {
        if (!links.has(values[0])) links.set(values[0], values[1]);
        return { rows: [] };
      }
      if (sql.startsWith('SELECT app_user_id FROM oauth_user_links')) {
        const userId = links.get(values[0]);
        return { rows: userId ? [{ app_user_id: userId }] : [] };
      }
      throw new Error(`Unexpected SQL in OAuth link test: ${sql}`);
    },
  };
}

const verifiedGoogleUser = {
  id: 'google-user-1',
  email: ' PLAYER@example.com ',
  emailVerified: true,
  name: 'Player One',
};

test('provisions a verified Google identity as a normal application user', async () => {
  const client = createClient();
  const user = await linkGoogleUserToApplication(client, verifiedGoogleUser);

  assert.equal(user.email, 'player@example.com');
  assert.equal(user.password_hash, null);
  assert.equal(user.role, 'user');
  assert.equal(user.email_verified, true);
  assert.equal(client.links.get(verifiedGoogleUser.id), user.id);
});

test('links an existing account without changing its role and verifies it', async () => {
  const existingUser = {
    id: 'admin-1',
    email: 'player@example.com',
    name: 'Existing Admin',
    role: 'admin',
    email_verified: false,
    password_hash: 'existing-hash',
  };
  const client = createClient([existingUser]);
  client.verificationTokens.add(existingUser.id);

  const user = await linkGoogleUserToApplication(client, verifiedGoogleUser);

  assert.equal(user.id, existingUser.id);
  assert.equal(user.role, 'admin');
  assert.equal(user.email_verified, true);
  assert.equal(user.password_hash, 'existing-hash');
  assert.equal(client.verificationTokens.has(existingUser.id), false);
});

test('rejects an unverified Google identity before querying the database', async () => {
  const client = createClient();

  await assert.rejects(
    linkGoogleUserToApplication(client, { ...verifiedGoogleUser, emailVerified: false }),
    (error) => error.status === 401,
  );
  assert.equal(client.users.length, 0);
});

test('rejects a Google identity without a provider user ID', async () => {
  const client = createClient();

  await assert.rejects(
    linkGoogleUserToApplication(client, { ...verifiedGoogleUser, id: '' }),
    (error) => error.status === 400,
  );
  assert.equal(client.users.length, 0);
});

test('rejects a previously linked Google identity if its email changes', async () => {
  const linkedUser = {
    id: 'user-1',
    email: 'other@example.com',
    name: 'Existing User',
    role: 'user',
    email_verified: true,
    password_hash: null,
  };
  const client = createClient([linkedUser], [[verifiedGoogleUser.id, linkedUser.id]]);

  await assert.rejects(
    linkGoogleUserToApplication(client, verifiedGoogleUser),
    (error) => error.status === 409,
  );
});
