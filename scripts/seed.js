const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { initialize, pool, withTransaction } = require('../src/db');
const { id } = require('../src/utils/ids');

async function upsertUser(client, email, name, role, password) {
  const existing = await client.query('SELECT * FROM users WHERE email = $1', [email]);
  if (existing.rows[0]) return existing.rows[0];
  const userId = id();
  await client.query(
    'INSERT INTO users (id, email, password_hash, name, role) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await bcrypt.hash(password, 10), name, role]
  );
  const created = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
  return created.rows[0];
}

async function main() {
  await initialize();
  await withTransaction(async (client) => {
    await upsertUser(client, 'admin@tournament.local', 'Admin', 'admin', 'admin123');
    await upsertUser(client, 'user@tournament.local', 'Fan', 'user', 'user123');
    await upsertUser(client, 'referee@tournament.local', 'Referee', 'user', 'referee123');
  });
  await pool.end();
  console.log('Seed complete.');
  console.log('Admin:   admin@tournament.local / admin123');
  console.log('User:    user@tournament.local / user123');
  console.log('Referee: referee@tournament.local / referee123');
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exitCode = 1;
});
