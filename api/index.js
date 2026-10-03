const { createApp } = require('../src/app');
const { initialize } = require('../src/db');

const app = createApp();
let initialization;

module.exports = async function handler(req, res) {
  console.log("hello");
  initialization ||= initialize();
  await initialization;
  console.log(initialization);
  return app(req, res);
};
