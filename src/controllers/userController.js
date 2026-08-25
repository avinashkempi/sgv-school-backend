const { validationResult } = require('express-validator');
const User = require('../models/User');
const { invalidateUserCache } = require('../middleware/auth');

const MAX_PAGE_LIMIT = 100;
const ALLOWED_SORT_FIELDS = new Set(['createdAt', 'name', 'role', 'phone', 'email']);

const parsePagination = (query) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const requestedLimit = parseInt(query.limit, 10) || 20;
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_PAGE_LIMIT);
  return { page, limit, skip: (page - 1) * limit };
};

const escapeRegex = (value) => value.toString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ensureCanAssignRole = async (requestUser, targetRole, existingUser = null) => {
  if (targetRole === 'super admin' && requestUser.role !== 'super admin') {
    return 'Only super admins can create or promote super admins';
  }

  if (existingUser?.role === 'super admin' && requestUser.role !== 'super admin') {
    return 'Only super admins can modify super admin accounts';
  }

  if (existingUser?.role === 'super admin' && targetRole && targetRole !== 'super admin') {
    const superAdminCount = await User.countDocuments({ role: 'super admin' });
    if (superAdminCount <= 1) {
      return 'Cannot demote the last super admin';
    }
  }

  return null;
};

// Get all users (admin only)
const getAllUsers = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);

    const { role, search, sortBy, order } = req.query;

    // Build query filter
    const filter = {};

    // Role filter
    if (role && role !== 'all') {
      filter.role = role;
    }

    // Apply Academic Year context for students
    if (filter.role === 'student' || role === 'student') {
      if (req.academicYearContext) {
        filter.academicYear = req.academicYearContext;
      }
    } else if (!role || role === 'all') {
      // If returning all roles, only include students from the context year, but keep all other global users
      if (req.academicYearContext) {
        filter.$or = [
          { role: { $ne: 'student' } },
          { role: 'student', academicYear: req.academicYearContext }
        ];
      }
    }

    // Search filter (name, email, phone)
    if (search) {
      const searchRegex = { $regex: escapeRegex(search), $options: 'i' };
      const searchOr = [
        { name: searchRegex },
        { email: searchRegex },
        { phone: searchRegex }
      ];

      // If $or filter is already constructed for role selection, combine them using $and
      if (filter.$or) {
        filter.$and = [
          { $or: filter.$or },
          { $or: searchOr }
        ];
        delete filter.$or;
      } else {
        filter.$or = searchOr;
      }
    }

    // Build sort object
    let sort = { createdAt: -1 }; // Default sort
    if (sortBy) {
      if (!ALLOWED_SORT_FIELDS.has(sortBy)) {
        return res.status(400).json({ success: false, message: 'Invalid sort field' });
      }
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
        page,
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

    const roleError = await ensureCanAssignRole(req.user, role);
    if (roleError) {
      return res.status(403).json({ success: false, message: roleError });
    }

    // Check if user already exists by phone
    const existingUserByPhone = await User.findOne({ phone });
    if (existingUserByPhone) {
      return res.status(400).json({
        success: false,
        message: 'User with this phone number already exists'
      });
    }

    const loginPhone = phone || req.body.phone2;
    const defaultPassword = loginPhone ? `${loginPhone}@123` : password;

    const sanitizeOptional = (val) => (typeof val === 'string' && val.trim() === '') ? undefined : val;

    // Create new user
    const user = new User({
      name,
      phone: sanitizeOptional(phone),
      email: sanitizeOptional(email),
      password: defaultPassword,
      role,
      admissionDate: sanitizeOptional(admissionDate),
      guardianName,
      guardianPhone: sanitizeOptional(guardianPhone),
      currentClass: sanitizeOptional(currentClass),
      academicYear: sanitizeOptional(academicYear),
      gender: sanitizeOptional(req.body.gender),
      bloodGroup: sanitizeOptional(req.body.bloodGroup),
      dateOfBirth: sanitizeOptional(req.body.dateOfBirth),
      address: sanitizeOptional(req.body.address),
      phone2: sanitizeOptional(req.body.phone2),
      regNo: sanitizeOptional(req.body.regNo),
      satsNumber: sanitizeOptional(req.body.satsNumber),
      penNumber: sanitizeOptional(req.body.penNumber),
      apaarId: sanitizeOptional(req.body.apaarId),
      remarks: sanitizeOptional(req.body.remarks),
      joiningDate: sanitizeOptional(joiningDate),
      designation: sanitizeOptional(designation),
      subjects,
      profilePhoto: sanitizeOptional(req.body.profilePhoto),
      profilePhotoPublicId: sanitizeOptional(req.body.profilePhotoPublicId),
      mustChangePassword: true
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

    const roleError = await ensureCanAssignRole(req.user, role, user);
    if (roleError) {
      return res.status(403).json({ success: false, message: roleError });
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

    const sanitizeOptional = (val) => (typeof val === 'string' && val.trim() === '') ? undefined : val;

    // Update fields
    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = sanitizeOptional(email);
    if (role !== undefined) user.role = role;

    // Update student fields
    if (admissionDate !== undefined) user.admissionDate = sanitizeOptional(admissionDate);
    if (guardianName !== undefined) user.guardianName = guardianName;
    if (guardianPhone !== undefined) user.guardianPhone = sanitizeOptional(guardianPhone);
    if (currentClass !== undefined) user.currentClass = sanitizeOptional(currentClass);
    if (academicYear !== undefined) user.academicYear = sanitizeOptional(academicYear);

    // New Student Fields
    if (req.body.gender !== undefined) user.gender = sanitizeOptional(req.body.gender);
    if (req.body.bloodGroup !== undefined) user.bloodGroup = sanitizeOptional(req.body.bloodGroup);
    if (req.body.dateOfBirth !== undefined) user.dateOfBirth = sanitizeOptional(req.body.dateOfBirth);
    if (req.body.address !== undefined) user.address = sanitizeOptional(req.body.address);
    if (req.body.phone2 !== undefined) user.phone2 = sanitizeOptional(req.body.phone2);
    if (req.body.remarks !== undefined) user.remarks = sanitizeOptional(req.body.remarks);
    // IDs
    if (req.body.regNo !== undefined) user.regNo = sanitizeOptional(req.body.regNo);
    if (req.body.satsNumber !== undefined) user.satsNumber = sanitizeOptional(req.body.satsNumber);
    if (req.body.penNumber !== undefined) user.penNumber = sanitizeOptional(req.body.penNumber);
    if (req.body.apaarId !== undefined) user.apaarId = sanitizeOptional(req.body.apaarId);

    // Update teacher fields
    if (joiningDate !== undefined) user.joiningDate = sanitizeOptional(joiningDate);
    if (designation !== undefined) user.designation = sanitizeOptional(designation);
    if (subjects !== undefined) user.subjects = subjects;

    // Profile photo
    if (req.body.profilePhoto !== undefined) user.profilePhoto = sanitizeOptional(req.body.profilePhoto) || null;
    if (req.body.profilePhotoPublicId !== undefined) user.profilePhotoPublicId = sanitizeOptional(req.body.profilePhotoPublicId) || null;

    await user.save();

    // Clear auth cache for this user so changes take effect immediately
    invalidateUserCache(user._id);

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

    // Clear auth cache for deleted user
    invalidateUserCache(id);

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
    const filter = {};

    const searchOr = [
      { name: { $regex: escapeRegex(query), $options: 'i' } }, // Case-insensitive name search
      { phone: { $regex: escapeRegex(query), $options: 'i' } } // Phone search
    ];

    // Add role filter if provided
    if (role) {
      filter.role = role;
    }

    // Apply Academic Year context
    const targetYearId = req.query.academicYearId || req.academicYearContext;
    let yearFilterOr = null;

    if (targetYearId) {
      if (role === 'student') {
        filter.academicYear = targetYearId;
      } else if (!role || role === 'all') {
        // Only return students of targetYearId, but allow all other roles globally
        yearFilterOr = [
          { role: { $ne: 'student' } },
          { role: 'student', academicYear: targetYearId }
        ];
      }
    }

    // Combine search query and year filter context into $and
    if (yearFilterOr) {
      filter.$and = [
        { $or: searchOr },
        { $or: yearFilterOr }
      ];
    } else {
      filter.$or = searchOr;
    }

    // Add class filter if provided
    if (req.query.classId) {
      filter.currentClass = req.query.classId;
    }

    const { page, limit, skip } = parsePagination(req.query);

    const users = await User.find(filter, '-password')
      .populate('currentClass', 'name section')
      .populate('academicYear', 'name')
      .sort({ name: 1 }) // Sort by name
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await User.countDocuments(filter);

    // Map _id to id
    const usersWithId = users.map(user => ({
      ...user,
      id: user._id
    }));

    res.json({
      success: true,
      data: usersWithId,
      pagination: {
        page,
        pages: Math.ceil(total / limit),
        total,
        limit
      }
    });
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

