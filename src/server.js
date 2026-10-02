const { createApp } = require('./app');
const config = require('./config');
const { initialize, pool } = require('./db');

const app = createApp();

async function start() {
  await initialize();
  const server = app.listen(config.port, () => {
    console.log(`Tournament API listening on http://localhost:${config.port}`);
  });

  const shutdown = async () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error('Unable to initialize the database', error);
  process.exitCode = 1;
});
