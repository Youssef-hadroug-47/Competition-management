const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

const dir = path.dirname(path.resolve(config.dbPath));
fs.mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(path.resolve(config.dbPath));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
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

module.exports = { db, now, parseJson };
