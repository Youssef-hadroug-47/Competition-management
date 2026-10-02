const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const databaseSsl = /^(1|true|yes)$/i.test(process.env.DATABASE_SSL || '');
const databaseSslRejectUnauthorized = !/^(0|false|no)$/i.test(
  process.env.DATABASE_SSL_REJECT_UNAUTHORIZED || '',
);

module.exports = {
  port: Number(process.env.PORT) || 3000,
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  databaseUrl: process.env.DATABASE_URL || '',
  databaseSsl,
  databaseSslRejectUnauthorized,
  databasePoolMax: Number(process.env.DATABASE_POOL_MAX) || 10,
};
