const { randomUUID } = require('crypto');

/**
 * Middleware that assigns or preserves a unique Request ID for tracing requests.
 * Sets req.id and response header 'X-Request-Id'.
 */
const requestId = (req, res, next) => {
  const incomingId = req.headers['x-request-id'];
  const reqId = incomingId || randomUUID();

  req.id = reqId;
  res.setHeader('X-Request-Id', reqId);

  next();
};

module.exports = requestId;
