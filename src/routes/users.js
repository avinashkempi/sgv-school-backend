const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { userValidation } = require('../validations/user');
const {
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  searchUsers,
  revertStudentPromotion
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
router.get('/search', (req, res, next) => {
  if (['admin', 'super admin', 'teacher'].includes(req.user.role)) {
    return next();
  }
  return res.status(403).json({ success: false, message: 'Forbidden: Insufficient privileges to search users' });
}, searchUsers);

// Get all users (admin only, except teachers can get students)
router.get('/', (req, res, next) => {
  // Allow teachers to access if they're filtering by role=student
  if (req.query.role === 'student' && req.user.role === 'teacher') {
    return next();
  }
  // Otherwise require admin
  return requireAdmin(req, res, next);
}, getAllUsers);

// Get user by ID
router.get('/:id', (req, res, next) => {
  // Allow access to own profile
  if (req.user.userId === req.params.id) {
    return next();
  }
  // Allow admins and teachers to view other profiles
  if (['admin', 'super admin', 'teacher'].includes(req.user.role)) {
    return next();
  }
  return res.status(403).json({ success: false, message: 'Forbidden: Cannot access other user profiles' });
}, getUserById);

// Create new user (admin only)
router.post('/', requireAdmin, userValidation, createUser);

// Update user (admin only)
router.put('/:id', requireAdmin, userValidation, updateUser);

// Delete user (admin only)
router.delete('/:id', requireAdmin, deleteUser);

// Revert a student's promotion back to their old class in the active year (super admin / admin only)
router.put('/:id/revert-promotion', requireAdmin, revertStudentPromotion);

module.exports = router;
