const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query, withTransaction } = require('../db');
const { id } = require('../utils/ids');
const { asyncHandler } = require('../utils/asyncHandler');
const { httpError } = require('../middleware/error');
const { userPublic } = require('../services/mappers');
const {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
} = require('../services/emailService');
const { getBetterAuth } = require('../services/betterAuth');
const config = require('../config');

const verificationLifetimeMs = 24 * 60 * 60 * 1000;
const resendCooldownMs = 60 * 1000;
const passwordResetLifetimeMs = 30 * 60 * 1000;
const passwordResetCooldownMs = 60 * 1000;
const passwordResetMessage = 'If an account exists for that address, a password reset link has been sent. Check your inbox and spam folder.';

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
  return jwt.sign(
    { sub: user.id, role: user.role, tv: Number(user.token_version) || 0 },
    config.jwtSecret,
    { expiresIn: '7d' },
  );
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

function createPasswordResetToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return {
    token,
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + passwordResetLifetimeMs).toISOString(),
  };
}

async function storePasswordResetToken(client, userId) {
  const reset = createPasswordResetToken();
  await client.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, sent_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, sent_at = NOW()`,
    [userId, reset.tokenHash, reset.expiresAt],
  );
  return reset.token;
}

async function releasePasswordResetToken(userId, token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await query(
    'DELETE FROM password_reset_tokens WHERE user_id = $1 AND token_hash = $2',
    [userId, tokenHash],
  );
}

function validPassword(password) {
  return typeof password === 'string'
    && password.length >= 8
    && Buffer.byteLength(password, 'utf8') <= 72;
}

async function linkGoogleUserToApplication(client, googleUser) {
  if (!googleUser?.emailVerified) throw httpError(401, 'A verified Google sign-in is required.');
  if (typeof googleUser.id !== 'string' || !googleUser.id) {
    throw httpError(400, 'Google did not provide a usable account identifier.');
  }
  const email = normalizeEmail(googleUser.email);
  const name = String(googleUser.name || '').trim();
  if (!email || !name) throw httpError(400, 'Google did not provide a usable account profile.');

  const linked = await client.query(
    `SELECT u.* FROM oauth_user_links l
     JOIN users u ON u.id = l.app_user_id
     WHERE l.better_auth_user_id = $1
     FOR UPDATE OF l`,
    [googleUser.id],
  );
  if (linked.rows[0]) {
    if (normalizeEmail(linked.rows[0].email) !== email) {
      throw httpError(409, 'The Google account email changed. Contact support to secure your account.');
    }
    return linked.rows[0];
  }

  let appUser = (await client.query(
    'SELECT * FROM users WHERE lower(email) = $1 FOR UPDATE',
    [email],
  )).rows[0];
  if (!appUser) {
    const inserted = await client.query(
      `INSERT INTO users (id, email, password_hash, name, role, email_verified)
       VALUES ($1, $2, NULL, $3, 'user', true)
       ON CONFLICT (email) DO NOTHING
       RETURNING *`,
      [id(), email, name],
    );
    appUser = inserted.rows[0] || (await client.query(
      'SELECT * FROM users WHERE lower(email) = $1 FOR UPDATE',
      [email],
    )).rows[0];
  }
  if (!appUser) throw httpError(409, 'Unable to create or locate the application account.');
  if (!appUser.email_verified) {
    const verified = await client.query(
      'UPDATE users SET email_verified = true WHERE id = $1 RETURNING *',
      [appUser.id],
    );
    appUser = verified.rows[0];
    await client.query('DELETE FROM email_verification_tokens WHERE user_id = $1', [appUser.id]);
  }

  await client.query(
    `INSERT INTO oauth_user_links (better_auth_user_id, app_user_id)
     VALUES ($1, $2)
     ON CONFLICT (better_auth_user_id) DO NOTHING`,
    [googleUser.id, appUser.id],
  );
  const finalLink = await client.query(
    'SELECT app_user_id FROM oauth_user_links WHERE better_auth_user_id = $1',
    [googleUser.id],
  );
  if (finalLink.rows[0]?.app_user_id !== appUser.id) {
    throw httpError(409, 'This Google identity is already linked to another application account.');
  }
  return appUser;
}

function oauthRequestOriginAllowed(req) {
  return config.oauthTrustedOrigins.includes(req.get('Origin'));
}

function validatedOAuthNext(value) {
  if (value == null || value === '') return '/index';
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    throw httpError(400, 'The post-sign-in destination must be a same-origin path.');
  }
  let destination;
  try {
    destination = new URL(value, config.frontendOrigin);
  } catch {
    throw httpError(400, 'The post-sign-in destination is invalid.');
  }
  if (destination.origin !== new URL(config.frontendOrigin).origin) {
    throw httpError(400, 'The post-sign-in destination must be a same-origin path.');
  }
  return `${destination.pathname}${destination.search}${destination.hash}`;
}

const googleOAuthProviders = (req, res) => {
  res.json({ google: config.googleOAuthEnabled });
};

const startGoogleOAuth = asyncHandler(async (req, res) => {
  if (!config.googleOAuthEnabled) {
    throw httpError(503, 'Google sign-in is not configured on this server.');
  }
  if (!oauthRequestOriginAllowed(req)) {
    throw httpError(403, 'Google sign-in can only be started from the configured application origin.');
  }
  const next = validatedOAuthNext(req.body?.next);
  const callbackURL = new URL('/api/oauth/google/complete', config.betterAuthUrl);
  callbackURL.searchParams.set('next', next);
  const errorCallbackURL = new URL('/oauth-callback', config.frontendOrigin);
  errorCallbackURL.hash = new URLSearchParams({ error: 'google', next }).toString();

  const { auth } = await getBetterAuth();
  const authResponse = await auth.handler(new Request(
    new URL('/api/better-auth/sign-in/social', config.betterAuthUrl),
    {
      method: 'POST',
      headers: {
        Origin: config.betterAuthUrl,
        'Content-Type': 'application/json',
        'User-Agent': req.get('User-Agent') || '',
      },
      body: JSON.stringify({
        provider: 'google',
        callbackURL: callbackURL.toString(),
        errorCallbackURL: errorCallbackURL.toString(),
      }),
    },
  ));
  const cookies = authResponse.headers.getSetCookie?.()
    || [authResponse.headers.get('set-cookie')].filter(Boolean);
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  const result = await authResponse.json().catch(() => null);
  if (!authResponse.ok) {
    throw httpError(authResponse.status, result?.message || 'Unable to start Google sign-in.');
  }
  if (typeof result?.url !== 'string' || !result.url) {
    throw httpError(502, 'Better Auth did not return a Google authorization URL.');
  }
  res.redirect(303, result.url);
});

function redirectOAuthCallback(res, next, error) {
  const callback = new URL('/oauth-callback', config.frontendOrigin);
  callback.hash = new URLSearchParams({ error, next }).toString();
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.redirect(303, callback.toString());
}

const completeGoogleOAuth = asyncHandler(async (req, res) => {
  if (!config.googleOAuthEnabled) {
    throw httpError(503, 'Google sign-in is not configured on this server.');
  }
  const next = validatedOAuthNext(req.query.next);
  const { auth, fromNodeHeaders } = await getBetterAuth();
  const betterSession = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  const googleUser = betterSession?.user;
  if (!googleUser || !googleUser.emailVerified) {
    redirectOAuthCallback(res, next, 'unverified');
    return;
  }

  const exchangeCode = crypto.randomBytes(32).toString('base64url');
  const exchangeHash = crypto.createHash('sha256').update(exchangeCode).digest('hex');
  let user;
  try {
    user = await withTransaction(async (client) => {
      const appUser = await linkGoogleUserToApplication(client, googleUser);
      await client.query('DELETE FROM oauth_exchange_codes WHERE expires_at <= NOW()');
      await client.query(
        `INSERT INTO oauth_exchange_codes (code_hash, user_id, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '2 minutes')`,
        [exchangeHash, appUser.id],
      );
      return appUser;
    });
  } catch (error) {
    if (error.code === '23505') {
      redirectOAuthCallback(res, next, 'account');
      return;
    }
    if (error.status === 409) {
      redirectOAuthCallback(res, next, 'account');
      return;
    }
    throw error;
  }

  const callback = new URL('/oauth-callback', config.frontendOrigin);
  callback.hash = new URLSearchParams({ code: exchangeCode, next }).toString();
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.redirect(303, callback.toString());
});

const register = asyncHandler(async (req, res) => {
  const { email, password, name } = req.body || {};
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !password || !name) throw httpError(400, 'email, password and name are required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw httpError(400, 'Enter a valid email address');
  if (!validPassword(password)) throw httpError(400, 'Password must be at least 8 characters and at most 72 bytes');
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
    throw httpError(400, 'Name must contain 1 to 120 characters');
  }
  const chosen = 'user';
  const userId = id();
  let user;
  let verificationToken;
  try {
    ({ user, verificationToken } = await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO users (id, email, password_hash, name, role, email_verified)
         VALUES ($1, $2, $3, $4, $5, false)`,
        [userId, normalizedEmail, await bcrypt.hash(password, 10), name.trim(), chosen],
      );
      const result = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
      const verificationToken = await storeVerificationToken(client, userId);
      return { user: result.rows[0], verificationToken };
    }));
  } catch (error) {
    if (error?.code === '23505') {
      throw httpError(
        409,
        'An account with this email address already exists. Sign in instead.',
        { code: 'EMAIL_TAKEN' },
      );
    }
    throw error;
  }
  try {
    await sendVerificationEmail(user, verificationToken);
  } catch (error) {
    logVerificationDeliveryFailure('registration email', error);
    try {
      await releaseVerificationCooldown(user.id, verificationToken);
    } catch (cooldownError) {
      logVerificationDeliveryFailure('registration resend cooldown reset', cooldownError);
    }
    throw httpError(503, `Your account was created but is not verified. ${verificationDeliveryMessage(error)} Sign in with your password to resend the verification email.`, { code: 'EMAIL_DELIVERY_FAILED' });
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
      throw httpError(429, `A verification email was sent recently. Try again in ${retryAfterSeconds} seconds.`, {
        code: 'VERIFICATION_COOLDOWN',
        retryAfterSeconds,
      });
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
      throw httpError(503, `${verificationDeliveryMessage(error)} Please try again in a few minutes.`, { code: 'EMAIL_DELIVERY_FAILED' });
    }
  }
  res.status(202).json({
    message: 'Request processed. If this address needs verification and no email arrives, check your spam folder, confirm the address, or sign in if it is already verified. Resend requests are limited to one per minute.',
  });
});

const forgotPassword = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const normalizedEmail = normalizeEmail(req.body?.email);
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw httpError(400, 'Enter a valid email address');
  }

  let delivery = null;
  try {
    delivery = await withTransaction(async (client) => {
      const found = await client.query(
        'SELECT id, email, name FROM users WHERE email = $1 FOR UPDATE',
        [normalizedEmail],
      );
      const user = found.rows[0];
      if (!user) return null;

      const existing = await client.query(
        'SELECT sent_at FROM password_reset_tokens WHERE user_id = $1 FOR UPDATE',
        [user.id],
      );
      const sentAt = existing.rows[0]?.sent_at;
      if (sentAt && Date.now() - new Date(sentAt).getTime() < passwordResetCooldownMs) {
        return null;
      }

      await client.query('DELETE FROM password_reset_tokens WHERE expires_at <= NOW()');
      return { user, token: await storePasswordResetToken(client, user.id) };
    });
  } catch (error) {
    logVerificationDeliveryFailure('password reset token creation', error);
  }

  if (delivery) {
    try {
      await sendPasswordResetEmail(delivery.user, delivery.token);
    } catch (error) {
      logVerificationDeliveryFailure('password reset email', error);
      try {
        await releasePasswordResetToken(delivery.user.id, delivery.token);
      } catch (cleanupError) {
        logVerificationDeliveryFailure('password reset token cleanup', cleanupError);
      }
    }
  }

  res.status(202).json({ message: passwordResetMessage });
});

const resetPassword = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const token = req.body?.token;
  const password = req.body?.password;
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    throw httpError(400, 'This password reset link is invalid or has expired. Request a new one.', {
      code: 'INVALID_RESET_TOKEN',
    });
  }
  if (!validPassword(password)) {
    throw httpError(400, 'Password must be at least 8 characters and at most 72 bytes', {
      code: 'INVALID_PASSWORD',
    });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const updatedUser = await withTransaction(async (client) => {
    const found = await client.query(
      `SELECT prt.user_id, u.email, u.name
       FROM password_reset_tokens prt
       JOIN users u ON u.id = prt.user_id
       WHERE prt.token_hash = $1 AND prt.expires_at > NOW()
       FOR UPDATE OF prt`,
      [tokenHash],
    );
    const reset = found.rows[0];
    if (!reset) return null;

    await client.query(
      `UPDATE users
       SET password_hash = $2, email_verified = true, token_version = token_version + 1
       WHERE id = $1`,
      [reset.user_id, passwordHash],
    );
    await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [reset.user_id]);
    await client.query('DELETE FROM email_verification_tokens WHERE user_id = $1', [reset.user_id]);
    await client.query('DELETE FROM oauth_exchange_codes WHERE user_id = $1', [reset.user_id]);
    return { id: reset.user_id, email: reset.email, name: reset.name };
  });

  if (!updatedUser) {
    throw httpError(400, 'This password reset link is invalid or has expired. Request a new one.', {
      code: 'INVALID_RESET_TOKEN',
    });
  }

  try {
    await sendPasswordChangedEmail(updatedUser);
  } catch (error) {
    logVerificationDeliveryFailure('password changed notification', error);
  }

  res.json({ message: 'Password updated. Sign in with your new password.' });
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw httpError(400, 'email and password are required');
  const result = await query('SELECT * FROM users WHERE email = $1', [normalizeEmail(email)]);
  const user = result.rows[0];
  if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
    throw httpError(401, 'Invalid credentials');
  }
  if (!user.email_verified) {
    throw httpError(403, 'Verify your email address before signing in.', { code: 'EMAIL_NOT_VERIFIED' });
  }
  res.json({ user: userPublic(user), token: tokenFor(user) });
});

const exchangeGoogleCode = asyncHandler(async (req, res) => {
  if (!config.googleOAuthEnabled) {
    throw httpError(503, 'Google sign-in is not configured on this server.');
  }
  if (!oauthRequestOriginAllowed(req)) {
    throw httpError(403, 'Google sign-in exchange is allowed only from the configured application origin.');
  }
  const code = req.body?.code;
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) {
    throw httpError(400, 'The Google sign-in code is invalid or expired. Please sign in again.');
  }
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const user = await withTransaction(async (client) => {
    const found = await client.query(
      `SELECT user_id FROM oauth_exchange_codes
       WHERE code_hash = $1 AND expires_at > NOW()
       FOR UPDATE`,
      [codeHash],
    );
    if (!found.rows[0]) throw httpError(401, 'The Google sign-in code is invalid or expired. Please sign in again.');
    await client.query('DELETE FROM oauth_exchange_codes WHERE code_hash = $1', [codeHash]);
    const appUser = await client.query('SELECT * FROM users WHERE id = $1', [found.rows[0].user_id]);
    if (!appUser.rows[0]) throw httpError(401, 'The application account for this Google sign-in no longer exists.');
    return appUser.rows[0];
  });
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

module.exports = {
  register,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPassword,
  login,
  googleOAuthProviders,
  startGoogleOAuth,
  completeGoogleOAuth,
  exchangeGoogleCode,
  me,
  listUsers,
  updateRole,
  linkGoogleUserToApplication,
};
