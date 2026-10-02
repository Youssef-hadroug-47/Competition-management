const fs = require('fs/promises');
const path = require('path');
const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({
  ...(config.databaseUrl ? { connectionString: config.databaseUrl } : {}),
  max: config.databasePoolMax,
  ssl: config.databaseSsl
    ? { rejectUnauthorized: config.databaseSslRejectUnauthorized }
    : undefined,
});

let initialization;

async function initialize() {
  if (!initialization) {
    initialization = fs
      .readFile(path.join(__dirname, 'schema.sql'), 'utf8')
      .then((schema) => pool.query(schema));
  }
  return initialization;
}

async function query(text, values) {
  return pool.query(text, values);
}

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original transaction error.
    }
    throw error;
  } finally {
    client.release();
  }
}

function now() {
  return new Date().toISOString();
}

function parseJson(value, fallback = {}) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

module.exports = {
  pool,
  db: pool,
  initialize,
  query,
  withTransaction,
  now,
  parseJson,
};
