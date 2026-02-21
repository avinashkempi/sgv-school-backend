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

    // New Student Fields
    if (req.body.gender) user.gender = req.body.gender;
    if (req.body.bloodGroup) user.bloodGroup = req.body.bloodGroup;
    if (req.body.dateOfBirth) user.dateOfBirth = req.body.dateOfBirth;
    if (req.body.address) user.address = req.body.address;
    if (req.body.phone2) user.phone2 = req.body.phone2;
    // IDs
    if (req.body.regNo) user.regNo = req.body.regNo;
    if (req.body.satsNumber) user.satsNumber = req.body.satsNumber;
    if (req.body.penNumber) user.penNumber = req.body.penNumber;
    if (req.body.apaarId) user.apaarId = req.body.apaarId;
    // Status
    if (req.body.isAdmitted !== undefined) user.isAdmitted = req.body.isAdmitted;


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

// Revert a wrongly promoted student back to their previous class in the current active year
const revertStudentPromotion = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user || user.role !== 'student') {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    const StudentHistory = require('../models/StudentHistory');
    const Class = require('../models/Class');

    // Find the most recent history record for this student
    const latestHistory = await StudentHistory.findOne({ student: id })
      .sort({ createdAt: -1 })
      .populate('class');

    if (!latestHistory || !latestHistory.class) {
      return res.status(400).json({ success: false, message: 'No promotion history found to revert.' });
    }

    // Now, we need to map the old class (from the archived year) to the equivalent class in the student's current year
    const oldClassName = latestHistory.class.name;
    const oldClassSection = latestHistory.class.section;
    const oldClassBranch = latestHistory.class.branch;

    // Find equivalent class in the current active year that the student is mapped to
    const targetClass = await Class.findOne({
      academicYear: user.academicYear,
      name: oldClassName,
      section: oldClassSection,
      branch: oldClassBranch
    });

    if (!targetClass) {
      return res.status(404).json({
        success: false,
        message: `Could not find an equivalent ${oldClassName} ${oldClassSection || ''} in the current year to revert them to.`
      });
    }

    // Process reversion
    user.currentClass = targetClass._id;
    user.isActive = true; // In case they were graduated/deactivated

    // If we're reverting, we must also remove the history record of them passing
    await StudentHistory.findByIdAndDelete(latestHistory._id);

    await user.save();

    res.json({
      success: true,
      message: `${user.name} has been reverted to ${oldClassName} ${oldClassSection || ''}.`
    });

  } catch (error) {
    console.error('Revert promotion error:', error);
    res.status(500).json({ success: false, message: 'Server error during reversion' });
  }
};

module.exports = {
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  searchUsers,
  revertStudentPromotion
};
