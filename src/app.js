const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const config = require('./config');
const routes = require('./routes');
const { notFound, errorHandler } = require('./middleware/error');
const crypto = require('crypto');
const { runWithRequestContext } = require('./utils/requestContext');
const { betterAuthHandler } = require('./services/betterAuth');

function createApp({ staticDir } = {}) {
  const app = express();
  app.use(cors(config.corsOrigins.length
    ? { origin: config.corsOrigins }
    : undefined));
  app.use(morgan('dev'));
  if (config.performanceLogging) {
    app.use((req, res, next) => {
      const context = {
        requestId: crypto.randomUUID(),
        startedAt: performance.now(),
        queryCount: 0,
      };
      res.setHeader('X-Request-Id', context.requestId);
      runWithRequestContext(context, () => {
        res.once('finish', () => {
          console.log(
            `[request] id=${context.requestId} ${req.method} ${req.originalUrl} ` +
            `${res.statusCode} ${Math.round(performance.now() - context.startedAt)}ms ` +
            `queries=${context.queryCount}`,
          );
        });
        next();
      });
    });
  }
  app.all('/api/better-auth/*', betterAuthHandler);
  app.use(express.urlencoded({ extended: false, limit: '1kb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', routes);
  if (staticDir) app.use(express.static(staticDir));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
