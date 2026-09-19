const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { id } = require('../utils/ids');
const { asyncHandler } = require('../utils/asyncHandler');
const { httpError } = require('../middleware/error');
const { userPublic } = require('../services/mappers');
const config = require('../config');

function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: '7d' });
}

const register = asyncHandler((req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password || !name) throw httpError(400, 'email, password and name are required');
  const allowed = ['user'];
  const chosen = role && allowed.includes(role) ? role : 'user';
  const userId = id();
  db.prepare(
    'INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, String(email).toLowerCase().trim(), bcrypt.hashSync(password, 10), name.trim(), chosen);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  res.status(201).json({ user: userPublic(user), token: tokenFor(user) });
});

const login = asyncHandler((req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw httpError(400, 'email and password are required');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    throw httpError(401, 'Invalid credentials');
  }
  res.json({ user: userPublic(user), token: tokenFor(user) });
});

const me = asyncHandler((req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: userPublic(user) });
});

const listUsers = asyncHandler((req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  res.json({ users: rows.map(userPublic) });
});

const updateRole = asyncHandler((req, res) => {
  const { role } = req.body || {};
  if (!['admin', 'user'].includes(role)) throw httpError(400, 'Invalid role');
  const info = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  if (!info.changes) throw httpError(404, 'User not found');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  res.json({ user: userPublic(user) });
});

module.exports = { register, login, me, listUsers, updateRole };
