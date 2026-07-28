const jwt = require('jsonwebtoken');
const User = require('../models/User');

const allowedUserRoles = User.schema.path('role').enumValues;
const TOKEN_EXPIRED_OR_INVALID_MESSAGE = 'Invalid or expired token. Please log in again.';
const TOKEN_REQUIRED_MESSAGE = 'Access token required. Please log in.';

const sanitizeUserForRequest = (user) => ({
  id: user._id.toString(),
  userId: user._id.toString(),
  name: user.name,
  role: user.role
});

const isTokenIssuedBeforePasswordChange = (payload, user) => {
  if (!payload.iat || !user.passwordChangedAt) return false;

  const passwordChangedAtSeconds = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
  return payload.iat < passwordChangedAtSeconds;
};

const loadAndValidateTokenUser = async (payload) => {
  if (!payload?.userId || payload.tokenVersion === undefined || !payload.role) {
    return null;
  }

  const user = await User.findById(payload.userId)
    .select('name role tokenVersion passwordChangedAt isActive')
    .lean();

  if (!user) return null;

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
    return null;
  }

  return sanitizeUserForRequest(user);
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
  requireFinanceAccess
};
