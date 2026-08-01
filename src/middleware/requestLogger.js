const logger = require('../utils/logger');

/**
 * Middleware to log HTTP request metadata and execution duration upon completion.
 * By default, only logs error responses (status >= 400) to keep server logs clean.
 */
const requestLogger = (req, res, next) => {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const end = process.hrtime.bigint();
    const durationMs = Number(end - start) / 1e6;

    const statusCode = res.statusCode;

    // Only log error responses (4xx/5xx) unless LOG_ALL_REQUESTS or LOG_LEVEL=info/debug is enabled
    const logAll = process.env.LOG_ALL_REQUESTS === 'true' ||
                   ['info', 'debug'].includes(process.env.LOG_LEVEL?.toLowerCase());

    if (statusCode < 400 && !logAll) {
      return;
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const userAgent = req.headers['user-agent'] || 'Unknown';
    const userId = req.user?.id || req.user?.userId || 'Anonymous';

    const logData = {
      requestId: req.id,
      method: req.method,
      url: req.originalUrl || req.url,
      status: statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      ip: clientIp,
      userId,
      userAgent
    };

    const message = `${req.method} ${logData.url} ${statusCode} - ${logData.durationMs}ms [ReqID: ${req.id}]`;

    if (statusCode >= 500) {
      logger.error(`HTTP 5xx Server Error: ${message}`, logData);
    } else if (statusCode >= 400) {
      logger.warn(`HTTP 4xx Client Error: ${message}`, logData);
    } else {
      logger.info(`HTTP ${message}`, logData);
    }
  });

  next();
};

module.exports = requestLogger;

