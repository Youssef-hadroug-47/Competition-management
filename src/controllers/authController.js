const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query, withTransaction } = require('../db');
const { id } = require('../utils/ids');
const { asyncHandler } = require('../utils/asyncHandler');
const { httpError } = require('../middleware/error');
const { userPublic } = require('../services/mappers');
const { sendVerificationEmail } = require('../services/emailService');
const config = require('../config');

const verificationLifetimeMs = 24 * 60 * 60 * 1000;
const resendCooldownMs = 60 * 1000;

function logVerificationDeliveryFailure(context, error) {
  console.error(`[email-verification] ${context} failed`, {
    code: error?.code || 'UNKNOWN',
    name: error?.name || 'Error',
    message: String(error?.message || 'No error message').slice(0, 300),
  });
}

function verificationDeliveryMessage(error) {
  if (error?.code === 'EMAIL_NOT_CONFIGURED') {
    return 'Email verification is not available right now. Please contact support.';
  }
  if (error?.code === 'EAUTH') {
    return 'The mail service rejected the verification email. Please contact support.';
  }
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ENOTFOUND'].includes(error?.code)) {
    return 'The email service could not be reached. Please try again in a few minutes.';
  }
  return 'The verification email could not be delivered. Please try again in a few minutes.';
}

function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: '7d' });
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function createVerificationToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return {
    token,
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + verificationLifetimeMs).toISOString(),
  };
}

async function storeVerificationToken(client, userId) {
  const token = createVerificationToken();
  await client.query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at, sent_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, sent_at = NOW()`,
    [userId, token.tokenHash, token.expiresAt],
  );
  return token.token;
}

async function releaseVerificationCooldown(userId, token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await query(
    `UPDATE email_verification_tokens
     SET sent_at = NOW() - INTERVAL '1 minute'
     WHERE user_id = $1 AND token_hash = $2`,
    [userId, tokenHash],
  );
}

const register = asyncHandler(async (req, res) => {
  const { email, password, name } = req.body || {};
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !password || !name) throw httpError(400, 'email, password and name are required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw httpError(400, 'Enter a valid email address');
  if (typeof password !== 'string' || password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
    throw httpError(400, 'Name must contain 1 to 120 characters');
  }
  const chosen = 'user';
  const userId = id();
  const { user, verificationToken } = await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO users (id, email, password_hash, name, role, email_verified)
       VALUES ($1, $2, $3, $4, $5, false)`,
      [userId, normalizedEmail, await bcrypt.hash(password, 10), name.trim(), chosen],
    );
    const result = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
    const verificationToken = await storeVerificationToken(client, userId);
    return { user: result.rows[0], verificationToken };
  });
  try {
    await sendVerificationEmail(user, verificationToken);
  } catch (error) {
    logVerificationDeliveryFailure('registration email', error);
    try {
      await releaseVerificationCooldown(user.id, verificationToken);
    } catch (cooldownError) {
      logVerificationDeliveryFailure('registration resend cooldown reset', cooldownError);
    }
    throw httpError(503, `Your account was created but is not verified. ${verificationDeliveryMessage(error)} Use “Resend verification email” to try again.`);
  }
  res.status(201).json({ message: 'Account created. Check your email for a verification link.' });
});

const verifyEmail = asyncHandler(async (req, res) => {
  const token = req.body?.token;
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    throw httpError(400, 'This verification link is invalid, expired, or already used. Request a new verification email and try again.');
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const result = await withTransaction(async (client) => {
    const verification = await client.query(
      `SELECT evt.user_id, u.email FROM email_verification_tokens evt
       JOIN users u ON u.id = evt.user_id
       WHERE evt.token_hash = $1 AND evt.expires_at > NOW()
       FOR UPDATE`,
      [tokenHash],
    );
    const row = verification.rows[0];
    if (!row) return false;
    await client.query('UPDATE users SET email_verified = true WHERE id = $1', [row.user_id]);
    await client.query('DELETE FROM email_verification_tokens WHERE user_id = $1', [row.user_id]);
    return row.email;
  });
  if (!result) {
    throw httpError(400, 'This verification link is invalid, expired, or already used. Request a new verification email and try again.');
  }
  res.json({ message: 'Email verified. You can now sign in.', email: result });
});

const resendVerification = asyncHandler(async (req, res) => {
  const normalizedEmail = normalizeEmail(req.body?.email);
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw httpError(400, 'Enter a valid email address');
  }
  const result = await withTransaction(async (client) => {
    const found = await client.query(
      'SELECT id, email, name, email_verified FROM users WHERE email = $1 FOR UPDATE',
      [normalizedEmail],
    );
    const user = found.rows[0];
    if (!user || user.email_verified) return null;
    const existing = await client.query(
      'SELECT sent_at FROM email_verification_tokens WHERE user_id = $1 FOR UPDATE',
      [user.id],
    );
    const sentAt = existing.rows[0]?.sent_at;
    if (sentAt && Date.now() - new Date(sentAt).getTime() < resendCooldownMs) {
      const retryAfterSeconds = Math.ceil(
        (resendCooldownMs - (Date.now() - new Date(sentAt).getTime())) / 1000,
      );
      res.set('Retry-After', String(retryAfterSeconds));
      throw httpError(429, `A verification email was sent recently. Try again in ${retryAfterSeconds} seconds.`);
    }
    return { user, verificationToken: await storeVerificationToken(client, user.id) };
  });
  if (result) {
    try {
      await sendVerificationEmail(result.user, result.verificationToken);
    } catch (error) {
      logVerificationDeliveryFailure('verification resend', error);
      try {
        await releaseVerificationCooldown(result.user.id, result.verificationToken);
      } catch (cooldownError) {
        logVerificationDeliveryFailure('resend cooldown reset', cooldownError);
      }
      throw httpError(503, `${verificationDeliveryMessage(error)} Please try again in a few minutes.`);
    }
  }
  res.status(202).json({
    message: 'Request processed. If this address needs verification and no email arrives, check your spam folder, confirm the address, or sign in if it is already verified. Resend requests are limited to one per minute.',
  });
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw httpError(400, 'email and password are required');
  const result = await query('SELECT * FROM users WHERE email = $1', [normalizeEmail(email)]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw httpError(401, 'Invalid credentials');
  }
  if (!user.email_verified) throw httpError(403, 'Verify your email address before signing in.');
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

module.exports = { register, verifyEmail, resendVerification, login, me, listUsers, updateRole };
