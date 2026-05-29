const jwt = require('jsonwebtoken');
const User = require('../models/User');

const buildRequestUser = (user, payload = {}) => ({
  userId: user._id.toString(),
  id: user._id.toString(),
  name: user.name,
  role: user.role,
  tokenIat: payload.iat,
  tokenExp: payload.exp
});

const verifyToken = (token) => new Promise((resolve, reject) => {
  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) return reject(err);
    resolve(payload);
  });
});

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access token required'
      });
    }

    const payload = await verifyToken(token);
    const userId = payload.userId || payload.id;
    if (!userId) {
      return res.status(403).json({ success: false, message: 'Invalid token payload' });
    }

    const user = await User.findById(userId).select('name role').lean();
    if (!user) {
      return res.status(403).json({ success: false, message: 'User no longer exists or access was revoked' });
    }

    // Always use the current DB-backed role. This prevents stale long-lived tokens
    // from retaining privileges after a demotion or role change.
    req.user = buildRequestUser(user, payload);
    next();
  } catch (_err) {
    return res.status(403).json({
      success: false,
      message: 'Invalid or expired token'
    });
  }
};

// Optional authentication middleware - sets req.user if token is valid and user still exists, else null
const optionalAuthenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      req.user = null;
      return next();
    }

    const payload = await verifyToken(token);
    const userId = payload.userId || payload.id;
    const user = userId ? await User.findById(userId).select('name role').lean() : null;
    req.user = user ? buildRequestUser(user, payload) : null;
    next();
  } catch (_err) {
    req.user = null;
    next();
  }
};

// Middleware to allow only admin or super admin users
const requireAdmin = (req, res, next) => {
  // Ensure token was verified and req.user exists
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Access token required' });
  }

  const { role } = req.user;
  if (role === 'admin' || role === 'super admin') return next();

  return res.status(403).json({ success: false, message: 'Admin privileges required' });
};

// Middleware to allow specific roles
const checkRole = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Access token required' });
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
  if (!req.user) return res.status(401).json({ message: 'Unauthorized' });

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
