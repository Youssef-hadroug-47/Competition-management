const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const databaseSsl = /^(1|true|yes)$/i.test(process.env.DATABASE_SSL || '');
const databaseSslRejectUnauthorized = !/^(0|false|no)$/i.test(
  process.env.DATABASE_SSL_REJECT_UNAUTHORIZED || '',
);
const smtpPort = Number(process.env.SMTP_PORT) || 587;
const googleClientId = process.env.GOOGLE_CLIENT_ID || '';
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
const betterAuthSecret = process.env.BETTER_AUTH_SECRET || '';
const betterAuthUrl = (process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '');
if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
  throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together.');
}
if (googleClientId && (!betterAuthSecret || !betterAuthUrl)) {
  throw new Error('BETTER_AUTH_SECRET and BETTER_AUTH_URL are required when Google OAuth is configured.');
}
if (betterAuthSecret && betterAuthSecret.length < 32) {
  throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters.');
}
const publicAppUrl = (
  process.env.PUBLIC_APP_URL || process.env.FRONTEND_ORIGIN || 'http://localhost:5173'
).replace(/\/+$/, '');
const frontendOrigin = (process.env.FRONTEND_ORIGIN || publicAppUrl).replace(/\/+$/, '');
try {
  const parsedFrontendOrigin = new URL(frontendOrigin);
  if (
    !['http:', 'https:'].includes(parsedFrontendOrigin.protocol)
    || parsedFrontendOrigin.origin !== frontendOrigin
  ) {
    throw new Error();
  }
} catch {
  throw new Error('FRONTEND_ORIGIN must be an HTTP(S) origin without a path.');
}
const configuredCorsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const corsOrigins = configuredCorsOrigins.length
  ? configuredCorsOrigins
  : process.env.NODE_ENV === 'production'
    ? []
    : ['http://localhost:5173', 'http://127.0.0.1:5173'];
let betterAuthOrigin = null;
if (
  googleClientId
  && process.env.NODE_ENV === 'production'
  && !corsOrigins.includes(frontendOrigin)
) {
  throw new Error('CORS_ORIGINS must include FRONTEND_ORIGIN when Google OAuth is enabled in production.');
}
if (
  googleClientId
  && process.env.NODE_ENV === 'production'
  && (!betterAuthUrl.startsWith('https://') || !frontendOrigin.startsWith('https://'))
) {
  throw new Error('Google OAuth requires HTTPS BETTER_AUTH_URL and FRONTEND_ORIGIN in production.');
}
if (betterAuthUrl) {
  try {
    const parsedAuthUrl = new URL(betterAuthUrl);
    if (
      !['http:', 'https:'].includes(parsedAuthUrl.protocol)
      || parsedAuthUrl.pathname !== '/'
      || parsedAuthUrl.origin !== betterAuthUrl
    ) {
      throw new Error();
    }
    betterAuthOrigin = parsedAuthUrl.origin;
  } catch {
    throw new Error('BETTER_AUTH_URL must be an HTTP(S) origin without a path.');
  }
}

console.log(`Server is listening to ${process.env.CORS_ORIGINS}`);
module.exports = {
  port: Number(process.env.PORT) || 3000,
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  databaseUrl: process.env.DATABASE_URL ||  '',
  databaseSsl,
  databaseSslRejectUnauthorized,
  databasePoolMax: Number(process.env.DATABASE_POOL_MAX) || 10,
  databaseConnectionTimeoutMs: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS) || 10000,
  databaseIdleTimeoutMs: Number(process.env.DATABASE_IDLE_TIMEOUT_MS) || 10000,
  performanceLogging: /^(1|true|yes)$/i.test(process.env.PERFORMANCE_LOGGING || ''),
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort,
  smtpSecure: /^(1|true|yes)$/i.test(process.env.SMTP_SECURE || '') || smtpPort === 465,
  smtpUser: process.env.SMTP_USER || '',
  smtpPassword: process.env.SMTP_PASSWORD || '',
  smtpFrom: process.env.SMTP_FROM || '',
  publicAppUrl,
  frontendOrigin,
  betterAuthSecret,
  betterAuthUrl,
  googleClientId,
  googleClientSecret,
  googleOAuthEnabled: Boolean(googleClientId && googleClientSecret),
  oauthTrustedOrigins: [...new Set([
    frontendOrigin,
    ...corsOrigins,
    ...(betterAuthOrigin ? [betterAuthOrigin] : []),
  ])],
  corsOrigins,
};
