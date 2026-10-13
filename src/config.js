const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const databaseSsl = /^(1|true|yes)$/i.test(process.env.DATABASE_SSL || '');
const databaseSslRejectUnauthorized = !/^(0|false|no)$/i.test(
  process.env.DATABASE_SSL_REJECT_UNAUTHORIZED || '',
);
const smtpPort = Number(process.env.SMTP_PORT) || 587;

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
  publicAppUrl: (process.env.PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};
