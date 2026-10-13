const { pool } = require('../db');
const config = require('../config');

let authPromise;
let initialization;

function betterAuthOptions() {
  return {
    appName: 'Tournly',
    baseURL: config.betterAuthUrl,
    basePath: '/api/better-auth',
    secret: config.betterAuthSecret,
    database: pool,
    trustedOrigins: config.oauthTrustedOrigins,
    socialProviders: {
      google: {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        requireEmailVerification: true,
      },
    },
    advanced: {
      useSecureCookies: config.betterAuthUrl.startsWith('https://'),
      defaultCookieAttributes: {
        sameSite: config.betterAuthUrl.startsWith('https://') ? 'none' : 'lax',
        secure: config.betterAuthUrl.startsWith('https://'),
        httpOnly: true,
      },
    },
    user: { modelName: 'oauth_users' },
    session: {
      modelName: 'oauth_sessions',
      expiresIn: 60 * 60,
    },
    account: {
      modelName: 'oauth_accounts',
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        trustedProviders: ['google'],
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
      },
    },
    verification: { modelName: 'oauth_verifications' },
  };
}

async function loadModules() {
  return Promise.all([
    import('better-auth'),
    import('better-auth/node'),
    import('better-auth/db/migration'),
  ]);
}

function createAuth(modules, options) {
  const [betterAuthModule, nodeModule] = modules;
  const auth = betterAuthModule.betterAuth(options);
  return {
    auth,
    toNodeHandler: nodeModule.toNodeHandler,
    fromNodeHeaders: nodeModule.fromNodeHeaders,
  };
}

async function initializeBetterAuth() {
  if (!config.googleOAuthEnabled) return;
  if (!initialization) {
    initialization = (async () => {
      const modules = await loadModules();
      const options = betterAuthOptions();
      const migration = await modules[2].getMigrations(options);
      await migration.runMigrations();
      authPromise = Promise.resolve(createAuth(modules, options));
      return authPromise;
    })().catch((error) => {
      initialization = null;
      authPromise = null;
      throw error;
    });
  }
  await initialization;
}

async function getBetterAuth() {
  if (!config.googleOAuthEnabled) {
    throw new Error('Google OAuth is not configured.');
  }
  if (!authPromise) await initializeBetterAuth();
  return authPromise;
}

async function betterAuthHandler(req, res, next) {
  try {
    const { auth, toNodeHandler } = await getBetterAuth();
    await toNodeHandler(auth)(req, res);
  } catch (error) {
    if (!config.googleOAuthEnabled) {
      res.status(503).json({ error: 'Google sign-in is not configured on this server.' });
      return;
    }
    next(error);
  }
}

module.exports = { getBetterAuth, initializeBetterAuth, betterAuthHandler };
