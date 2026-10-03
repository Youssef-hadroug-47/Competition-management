const { createApp } = require('../src/app');
const { initialize } = require('../src/db');

const app = createApp();
let initialization;

module.exports = async function handler(req, res) {
  initialization ||= initialize();
  console.log(initialization);
  await initialization;
  return app(req, res);
};
