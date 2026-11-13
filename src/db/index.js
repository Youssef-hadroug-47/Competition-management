const fs = require('fs/promises');
const path = require('path');
const { Pool } = require('pg');
const config = require('../config');
const { getRequestContext, shouldLogPerformance } = require('../utils/requestContext');

const pool = new Pool({
  ...(config.databaseUrl ? { connectionString: config.databaseUrl } : {}),
  max: config.databasePoolMax,
  connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
  idleTimeoutMillis: config.databaseIdleTimeoutMs,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  ssl: config.databaseSsl
    ? { rejectUnauthorized: config.databaseSslRejectUnauthorized }
    : undefined,
});

let initialization;

function poolStats() {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

function observePool(context, stats = poolStats()) {
  if (!context) return;
  context.poolWaitingMax = Math.max(context.poolWaitingMax || 0, stats.waiting);
}

async function initialize() {
  if (!initialization) {
    initialization = fs
      .readFile(path.join(__dirname, 'schema.sql'), 'utf8')
      .then((schema) => pool.query(schema))
      .then(async () => {
        const { initializeBetterAuth } = require('../services/betterAuth');
        await initializeBetterAuth();
      });
  }
  return initialization;
}

async function query(text, values) {
  const startedAt = performance.now();
  const context = getRequestContext();
  if (context) context.queryCount += 1;
  observePool(context);
  try {
    return await pool.query(text, values);
  } finally {
    observePool(context);
    if (config.performanceLogging && shouldLogPerformance(context)) {
      const statement = String(text).replace(/\s+/g, ' ').trim().slice(0, 120);
      console.log(
        `[db] id=${context?.requestId || 'startup'} ` +
        `${Math.round(performance.now() - startedAt)}ms ${statement}`,
      );
    }
  }
}

async function withTransaction(callback) {
  const startedAt = performance.now();
  const waitStartedAt = performance.now();
  const context = getRequestContext();
  observePool(context);
  const client = await pool.connect();
  if (context) {
    const clientQuery = client.query.bind(client);
    client.query = (...args) => {
      context.queryCount += 1;
      return clientQuery(...args);
    };
  }
  if (context) {
    context.transactionCount = (context.transactionCount || 0) + 1;
    context.poolWaitMs = (context.poolWaitMs || 0) + (performance.now() - waitStartedAt);
  }
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
    if (config.performanceLogging && shouldLogPerformance(context)) {
      console.log(
        `[db-tx] id=${context?.requestId || 'startup'} ` +
        `${Math.round(performance.now() - startedAt)}ms ` +
        `poolWaitMs=${Math.round(context?.poolWaitMs || 0)}`,
      );
    }
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
  poolStats,
  initialize,
  query,
  withTransaction,
  now,
  parseJson,
};
