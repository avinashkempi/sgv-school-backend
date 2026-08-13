const jwt = require('jsonwebtoken');
const User = require('../models/User');

const allowedUserRoles = User.schema.path('role').enumValues;
const TOKEN_EXPIRED_OR_INVALID_MESSAGE = 'Invalid or expired token. Please log in again.';
const TOKEN_REQUIRED_MESSAGE = 'Access token required. Please log in.';

// In-memory cache for validated users (reduces per-request DB queries)
const userValidationCache = new Map();
const USER_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const MAX_USER_CACHE_SIZE = 1000;

const invalidateUserCache = (userId) => {
  if (userId) {
    userValidationCache.delete(userId.toString());
  } else {
    userValidationCache.clear();
  }
};

const sanitizeUserForRequest = (user) => ({
  id: user._id.toString(),
  userId: user._id.toString(),
  name: user.name,
  role: user.role,
  currentClass: user.currentClass ? user.currentClass.toString() : null
});

const isTokenIssuedBeforePasswordChange = (payload, user) => {
  if (!payload.iat || !user.passwordChangedAt) return false;

  const passwordChangedAtSeconds = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
  return payload.iat < (passwordChangedAtSeconds - 1);
};

const loadAndValidateTokenUser = async (payload) => {
  if (!payload?.userId || payload.tokenVersion === undefined || !payload.role) {
    return null;
  }

  const userIdStr = payload.userId.toString();

  // Check in-memory cache first
  const cached = userValidationCache.get(userIdStr);
  if (
    cached &&
    (Date.now() - cached.ts < USER_CACHE_TTL_MS) &&
    cached.tokenVersion === payload.tokenVersion &&
    cached.role === payload.role
  ) {
    return cached.sanitizedUser;
  }

  const user = await User.findById(payload.userId)
    .select('name role tokenVersion passwordChangedAt isActive currentClass')
    .lean();

  if (!user) {
    userValidationCache.delete(userIdStr);
    return null;
  }

  const isKnownRole = allowedUserRoles.includes(user.role);
  const tokenRoleStillMatchesDb = payload.role === user.role;
  const tokenVersionStillCurrent = payload.tokenVersion === (user.tokenVersion ?? 0);
  const passwordWasChangedAfterTokenIssue = isTokenIssuedBeforePasswordChange(payload, user);
  const isInactive = user.isActive === false;
  const isAlumni = user.role === 'alumni';

  if (
    !isKnownRole ||
    !tokenRoleStillMatchesDb ||
    !tokenVersionStillCurrent ||
    passwordWasChangedAfterTokenIssue ||
    isInactive ||
    isAlumni
  ) {
    userValidationCache.delete(userIdStr);
    return null;
  }

  const sanitizedUser = sanitizeUserForRequest(user);

  // Store in cache
  if (userValidationCache.size >= MAX_USER_CACHE_SIZE) {
    const oldestKey = userValidationCache.keys().next().value;
    userValidationCache.delete(oldestKey);
  }
  userValidationCache.set(userIdStr, {
    sanitizedUser,
    tokenVersion: user.tokenVersion ?? 0,
    role: user.role,
    ts: Date.now()
  });

  return sanitizedUser;
};

const verifyToken = (token) => new Promise((resolve, reject) => {
  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) return reject(err);
    resolve(payload);
  });
});

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: TOKEN_REQUIRED_MESSAGE
    });
  }

  try {
    const payload = await verifyToken(token);
    const user = await loadAndValidateTokenUser(payload);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: TOKEN_EXPIRED_OR_INVALID_MESSAGE
      });
    }

    req.user = user;
    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: TOKEN_EXPIRED_OR_INVALID_MESSAGE
    });
  }
};

// Optional authentication middleware - sets req.user if token is valid, else null
const optionalAuthenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const payload = await verifyToken(token);
    req.user = await loadAndValidateTokenUser(payload);
  } catch (error) {
    req.user = null;
  }

  return next();
};

// Middleware to allow only admin or super admin users
const requireAdmin = (req, res, next) => {
  // Ensure token was verified and req.user exists
  if (!req.user) {
    return res.status(401).json({ success: false, message: TOKEN_REQUIRED_MESSAGE });
  }

  const { role } = req.user;
  if (role === 'admin' || role === 'super admin') return next();

  return res.status(403).json({ success: false, message: 'Admin privileges required' });
};

// Middleware to allow specific roles
const checkRole = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: TOKEN_REQUIRED_MESSAGE });
    }
    if (roles.includes(req.user.role)) {
      return next();
    }
    return res.status(403).json({ success: false, message: 'Forbidden: Insufficient privileges' });
  };
};

// Middleware for finance/fee access
// Admins: Full access
// Teachers: NO access
// Students: Own data only (must be handled by controller logic using req.user.id)
const requireFinanceAccess = (req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, message: TOKEN_REQUIRED_MESSAGE });

  const allowedRoles = ['admin', 'super admin', 'student'];
  if (allowedRoles.includes(req.user.role)) {
    return next();
  }

  return res.status(403).json({
    message: 'Access Denied: You do not have permission to view financial records.'
  });
};

module.exports = {
  authenticateToken,
  optionalAuthenticateToken,
  requireAdmin,
  checkRole,
  requireFinanceAccess,
  invalidateUserCache
};
