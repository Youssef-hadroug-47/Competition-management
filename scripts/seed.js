const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { db } = require('../src/db');
const { id } = require('../src/utils/ids');

function upsertUser(email, name, role, password) {
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) return existing;
  const userId = id();
  db.prepare(
    'INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, email, bcrypt.hashSync(password, 10), name, role);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

upsertUser('admin@tournament.local', 'Admin', 'admin', 'admin123');
upsertUser('referee@tournament.local', 'Referee', 'referee', 'referee123');
upsertUser('user@tournament.local', 'Fan', 'user', 'user123');



console.log('Seed complete.');
console.log('Admin:   admin@tournament.local / admin123');
console.log('Referee: referee@tournament.local / referee123');
console.log('User:    user@tournament.local / user123');
