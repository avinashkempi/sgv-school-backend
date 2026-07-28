const logger = require('../utils/logger');

/**
 * Global Express Error Handling Middleware.
 * Categorizes errors, logs full diagnostic stack traces, and returns clean structured JSON error responses.
 */
const errorHandler = (err, req, res, next) => {
  let statusCode = err.status || err.statusCode || 500;
  let message = err.message || 'Internal Server Error';
  let errorDetails = null;

  // Handle Mongoose Validation Errors
  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = 'Validation Error';
    errorDetails = Object.values(err.errors || {}).map((e) => ({
      field: e.path,
      message: e.message
    }));
  }

  // Handle Mongoose Cast Errors (Invalid ObjectId)
  else if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid format for field '${err.path}'`;
  }

  // Handle MongoDB Duplicate Key Error (Code 11000)
  else if (err.code === 11000) {
    statusCode = 409;
    const keyPattern = Object.keys(err.keyPattern || {}).join(', ');
    message = keyPattern ? `Duplicate entry for: ${keyPattern}` : 'Duplicate key entry error';
  }

  // Handle JWT Verification & Expiration Errors
  else if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Invalid or expired token. Please log in again.';
  }

  // Build context object for log recording
  const logContext = {
    requestId: req.id,
    method: req.method,
    url: req.originalUrl || req.url,
    statusCode,
    userId: req.user?.id || req.user?.userId || 'Anonymous',
    query: logger.sanitize(req.query),
    body: logger.sanitize(req.body),
    errorName: err.name,
    errorMessage: err.message
  };

  if (statusCode >= 500) {
    logger.error(`Unhandled API Error: ${err.message}`, err, logContext);
  } else {
    logger.warn(`API Exception [${statusCode}]: ${message}`, logContext);
  }

  const responsePayload = {
    success: false,
    message,
    requestId: req.id
  };

  if (errorDetails) {
    responsePayload.errors = errorDetails;
  }

  if (process.env.NODE_ENV !== 'production' && err.stack) {
    responsePayload.stack = err.stack;
  }

  res.status(statusCode).json(responsePayload);
};

module.exports = errorHandler;
