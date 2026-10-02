const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function runWithRequestContext(context, callback) {
  return storage.run(context, callback);
}

function getRequestContext() {
  return storage.getStore() || null;
}

module.exports = { runWithRequestContext, getRequestContext };
