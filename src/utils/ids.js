const crypto = require('crypto');

function id() {
  return crypto.randomUUID();
}

function slugify(value) {
  const base = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'item';
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

module.exports = { id, slugify };
