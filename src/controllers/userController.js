const { validationResult } = require('express-validator');
const User = require('../models/User');

// Get all users (admin only)
// Get all users (admin only)
// Get all users (admin only)
const getAllUsers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const { role, search, sortBy, order } = req.query;

    // Build query filter
    const filter = {};

    // Role filter
    if (role && role !== 'all') {
      filter.role = role;
    }

    // Search filter (name, email, phone)
    if (search) {
      const searchRegex = { $regex: search, $options: 'i' };
      filter.$or = [
        { name: searchRegex },
        { email: searchRegex },
        { phone: searchRegex }
      ];
    }

    // Build sort object
    let sort = { createdAt: -1 }; // Default sort
    if (sortBy) {
      const sortOrder = order === 'asc' ? 1 : -1;
      sort = { [sortBy]: sortOrder };
    }

    // Parallel Execution: Fetch users and total count
    const [users, total] = await Promise.all([
      User.find(filter, '-password')
        .populate('currentClass', 'name section')
        .populate('academicYear', 'name')
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter)
    ]);

    // Map _id to id for frontend compatibility
    const usersWithId = users.map(user => ({
      ...user,
      id: user._id
    }));

    // Return paginated response
    res.json({
      success: true,
      data: usersWithId,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total,
        limit
      }
    });
  } catch (error) {
    console.error('Get all users error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving users'
    });
  }
};

// Get user by ID
const getUserById = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id, '-password').lean(); // Exclude password field

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Ensure id property exists
    user.id = user._id;

    res.json({
      success: true,
      user
    });
  } catch (error) {
    console.error('Get user by ID error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving user'
    });
  }
};

// Create new user (admin only)
const createUser = async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const {
      name, phone, email, password, role,
      // Student fields
      admissionDate, guardianName, guardianPhone, currentClass, academicYear,
      // Teacher fields
      joiningDate, designation, subjects
    } = req.body;

    // Check if user already exists by phone
    const existingUserByPhone = await User.findOne({ phone });
    if (existingUserByPhone) {
      return res.status(400).json({
        success: false,
        message: 'User with this phone number already exists'
      });
    }

    // Create new user
    const user = new User({
      name, phone, email, password, role,
      admissionDate, guardianName, guardianPhone, currentClass, academicYear,
      joiningDate, designation, subjects
    });
    await user.save();

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      user: {
        _id: user._id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Create user error:', error);

    // Handle specific error types
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: Object.values(error.errors).map(err => err.message)
      });
    }

    if (error.code === 11000) {
      // Duplicate key error
      const field = Object.keys(error.keyValue)[0];
      return res.status(400).json({
        success: false,
        message: `${field} already exists`
      });
    }

    // For other errors, return 500
    res.status(500).json({
      success: false,
      message: 'Server error creating user'
    });
  }
};

// Update user (admin only or self)
const updateUser = async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { id } = req.params;
    const {
      name, email, role,
      // Student fields
      admissionDate, guardianName, guardianPhone, currentClass, academicYear,
      // Teacher fields
      joiningDate, designation, subjects
    } = req.body;

    // Find user
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if updating email conflicts with existing users (only if email provided)
    if (email && email !== user.email) {
      const existingEmail = await User.findOne({ email, _id: { $ne: id } });
      if (existingEmail) {
        return res.status(400).json({
          success: false,
          message: 'Email already in use'
        });
      }
    }

    // Update fields
    if (name) user.name = name;
    if (email) user.email = email;
    if (role) user.role = role;

    // Update student fields
    if (admissionDate) user.admissionDate = admissionDate;
    if (guardianName) user.guardianName = guardianName;
    if (guardianPhone) user.guardianPhone = guardianPhone;
    if (currentClass) user.currentClass = currentClass;
    if (academicYear) user.academicYear = academicYear;

    // Update teacher fields
    if (joiningDate) user.joiningDate = joiningDate;
    if (designation) user.designation = designation;
    if (subjects) user.subjects = subjects;

    await user.save();

    res.json({
      success: true,
      message: 'User updated successfully',
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error updating user'
    });
  }
};

// Delete user (admin only)
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findByIdAndDelete(id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error deleting user'
    });
  }
};

// Search users by name or phone
const searchUsers = async (req, res) => {
  try {
    const { query, role } = req.query;

    if (!query || query.trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: 'Search query must be at least 2 characters'
      });
    }

    // Build search filter
    const filter = {
      $or: [
        { name: { $regex: query, $options: 'i' } }, // Case-insensitive name search
        { phone: { $regex: query, $options: 'i' } } // Phone search
      ]
    };

    // Add role filter if provided
    if (role) {
      filter.role = role;
    }

    // Add class filter if provided
    if (req.query.classId) {
      filter.currentClass = req.query.classId;
    }

    // Add academic year filter if provided
    if (req.query.academicYearId) {
      filter.academicYear = req.query.academicYearId;
    }

    const users = await User.find(filter, '-password')
      .populate('currentClass', 'name section')
      .populate('academicYear', 'name')
      .limit(20) // Limit results to 20
      .sort({ name: 1 }) // Sort by name
      .lean();

    // Map _id to id
    const usersWithId = users.map(user => ({
      ...user,
      id: user._id
    }));

    res.json(usersWithId);
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error searching users'
    });
  }
};

module.exports = {
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  searchUsers
};
