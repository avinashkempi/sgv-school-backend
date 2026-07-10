const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { yearContext } = require('../middleware/yearContext');
const { userCreateValidation, userUpdateValidation } = require('../validations/user');
const User = require('../models/User');
const { isAdminRole, canAccessStudent } = require('../middleware/accessControl');
const {
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  searchUsers,
  revertStudentPromotion,
  resetUserPassword
} = require('../controllers/userController');

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Get current user's info
router.get('/me', async (req, res) => {
  try {
    const User = require('../models/User');
    const user = await User.findById(req.user.userId).select('-password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    console.error('Error fetching current user:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Search users by name or phone
router.get('/search', yearContext, (req, res, next) => {
  if (['admin', 'super admin', 'teacher'].includes(req.user.role)) {
    return next();
  }
  return res.status(403).json({ success: false, message: 'Forbidden: Insufficient privileges to search users' });
}, searchUsers);

// Get all users (admin only, except teachers can get students)
router.get('/', yearContext, (req, res, next) => {
  // Allow teachers to access if they're filtering by role=student
  if (req.query.role === 'student' && req.user.role === 'teacher') {
    return next();
  }
  // Otherwise require admin
  return requireAdmin(req, res, next);
}, getAllUsers);

// Get user by ID
router.get('/:id', async (req, res, next) => {
  try {
    // Allow access to own profile
    if (req.user.userId === req.params.id) {
      return next();
    }
    if (isAdminRole(req.user.role)) {
      return next();
    }
    if (req.user.role === 'teacher') {
      const target = await User.findById(req.params.id).select('role').lean();
      if (target?.role === 'student' && await canAccessStudent(req.user, req.params.id)) {
        return next();
      }
    }
    return res.status(403).json({ success: false, message: 'Forbidden: Cannot access other user profiles' });
  } catch (error) {
    console.error('User profile access check failed:', error);
    return res.status(500).json({ success: false, message: 'Authorization check failed' });
  }
}, getUserById);

// Create new user (admin only)
router.post('/', requireAdmin, userCreateValidation, createUser);

// Update user (admin only)
router.put('/:id', requireAdmin, userUpdateValidation, updateUser);

// Delete user (admin only)
router.delete('/:id', requireAdmin, deleteUser);

// Revert a student's promotion back to their old class in the active year (super admin / admin only)
router.put('/:id/revert-promotion', requireAdmin, revertStudentPromotion);

// Reset user password (admin only)
router.put('/:id/reset-password', requireAdmin, resetUserPassword);

module.exports = router;
