const util = require('util');

const SENSITIVE_KEYS = [
  'password',
  'oldpassword',
  'newpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'authorization',
  'auth',
  'creditcard',
  'cardnumber',
  'cvv'
];

/**
 * Recursively clone and scrub sensitive keys from objects before logging
 */
const sanitize = (data, depth = 0) => {
  if (data === null || data === undefined) return data;
  if (depth > 5) return '[Max Depth Exceeded]';

  if (typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitize(item, depth + 1));
  }

  if (data instanceof Error) {
    return {
      name: data.name,
      message: data.message,
      stack: data.stack
    };
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.some((sensitive) => lowerKey.includes(sensitive))) {
      cleaned[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      cleaned[key] = sanitize(value, depth + 1);
    } else {
      cleaned[key] = value;
    }
  }

  return cleaned;
};

const formatMeta = (meta) => {
  if (!meta || (typeof meta === 'object' && Object.keys(meta).length === 0)) {
    return '';
  }
  const sanitized = sanitize(meta);
  if (process.env.NODE_ENV === 'production') {
    return JSON.stringify(sanitized);
  }
  return util.inspect(sanitized, { colors: true, depth: 4, compact: true });
};

const getTimestamp = () => new Date().toISOString();

const logger = {
  info: (message, meta) => {
    const metaStr = formatMeta(meta);
    console.log(`[${getTimestamp()}] ℹ️  INFO: ${message} ${metaStr}`.trim());
  },

  warn: (message, meta) => {
    const metaStr = formatMeta(meta);
    console.warn(`[${getTimestamp()}] ⚠️  WARN: ${message} ${metaStr}`.trim());
  },

  error: (message, errorOrMeta, extraMeta) => {
    let errObj = null;
    let meta = extraMeta || {};

    if (errorOrMeta instanceof Error) {
      errObj = errorOrMeta;
    } else if (typeof errorOrMeta === 'object' && errorOrMeta !== null) {
      meta = { ...errorOrMeta, ...meta };
    } else if (errorOrMeta !== undefined) {
      meta = { detail: errorOrMeta, ...meta };
    }

    if (errObj) {
      meta.error = {
        name: errObj.name,
        message: errObj.message,
        stack: errObj.stack
      };
    }

    const metaStr = formatMeta(meta);
    console.error(`[${getTimestamp()}] ❌ ERROR: ${message} ${metaStr}`.trim());
  },

  debug: (message, meta) => {
    if (process.env.NODE_ENV === 'production' && !process.env.DEBUG) return;
    const metaStr = formatMeta(meta);
    console.log(`[${getTimestamp()}] 🔍 DEBUG: ${message} ${metaStr}`.trim());
  },

  sanitize
};

module.exports = logger;
