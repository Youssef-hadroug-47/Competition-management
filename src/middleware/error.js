function notFound(req, res) {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err.status) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }

  if (err.code === '23505') {
    return res.status(409).json({ error: 'A record with that unique value already exists' });
  }
  if (err.code === '23503') {
    return res.status(400).json({ error: 'Invalid related resource' });
  }
  if (err.code === '23514' || err.code === '22P02') {
    return res.status(400).json({ error: 'Invalid database value' });
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
