const { createApp } = require('../src/app');
const { initialize } = require('../src/db');

const app = createApp();
let initialized;

module.exports = async function handler(req, res) {
  initialized ||= initialize();
  await initialized;
  return app(req, res);
};
