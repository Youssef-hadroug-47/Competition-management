const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, withTransaction } = require('../db');
const { id } = require('../utils/ids');
const { asyncHandler } = require('../utils/asyncHandler');
const { httpError } = require('../middleware/error');
const { userPublic } = require('../services/mappers');
const config = require('../config');

function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: '7d' });
}

const register = asyncHandler(async (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password || !name) throw httpError(400, 'email, password and name are required');
  const allowed = ['user'];
  const chosen = role && allowed.includes(role) ? role : 'user';
  const userId = id();
  const user = await withTransaction(async (client) => {
    await client.query(
      'INSERT INTO users (id, email, password_hash, name, role) VALUES ($1, $2, $3, $4, $5)',
      [userId, String(email).toLowerCase().trim(), await bcrypt.hash(password, 10), name.trim(), chosen],
    );
    const result = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
    return result.rows[0];
  });
  res.status(201).json({ user: userPublic(user), token: tokenFor(user) });
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw httpError(400, 'email and password are required');
  const result = await query('SELECT * FROM users WHERE email = $1', [String(email).toLowerCase().trim()]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw httpError(401, 'Invalid credentials');
  }
  res.json({ user: userPublic(user), token: tokenFor(user) });
});

const me = asyncHandler(async (req, res) => {
  const result = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const user = result.rows[0];
  res.json({ user: userPublic(user) });
});

const listUsers = asyncHandler(async (req, res) => {
  const result = await query('SELECT * FROM users ORDER BY created_at DESC');
  const rows = result.rows;
  res.json({ users: rows.map(userPublic) });
});

const updateRole = asyncHandler(async (req, res) => {
  const { role } = req.body || {};
  if (!['admin', 'user'].includes(role)) throw httpError(400, 'Invalid role');
  const info = await query('UPDATE users SET role = $1 WHERE id = $2', [role, req.params.id]);
  if (!info.rowCount) throw httpError(404, 'User not found');
  const result = await query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const user = result.rows[0];
  res.json({ user: userPublic(user) });
});

module.exports = { register, login, me, listUsers, updateRole };
