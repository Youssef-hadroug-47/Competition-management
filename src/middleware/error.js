function notFound(req, res) {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err.status) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }

  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({ error: 'A record with that unique value already exists' });
  }
  if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return res.status(400).json({ error: 'Invalid related resource' });
  }

  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}

function httpError(status, message, details) {
  const err = new Error(message);
  err.status = status;
  err.details = details;
  return err;
}

module.exports = { notFound, errorHandler, httpError };
