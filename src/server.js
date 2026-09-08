const { createApp } = require('./app');
const config = require('./config');
require('./db');

const app = createApp();
app.listen(config.port, () => {
  console.log(`Tournament API listening on http://localhost:${config.port}`);
});
