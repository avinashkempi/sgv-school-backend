const { validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

const login = async (req, res) => {
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

    const { phone, password } = req.body;

    // Find user by phone
    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid phone number or password'
      });
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid phone number or password'
      });
    }

    if (user.isActive === false || user.isAdmitted === false || user.role === 'alumni') {
      return res.status(403).json({
        success: false,
        message: 'Account is inactive'
      });
    }

    // Generate a short-lived JWT token tied to the current DB-backed session version
    const token = jwt.sign(
      { userId: user._id, role: user.role, tokenVersion: user.tokenVersion ?? 0 },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    // Update last active
    await User.updateOne({ _id: user._id }, { lastActiveAt: new Date() });

    // Populate currentClass for login response
    await user.populate('currentClass', 'name branch');

    res.json({
      success: true,
      message: 'Login successful',
      token,
      expiresIn: '8h',
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        role: user.role,
        currentClass: user.currentClass,
        academicYear: user.academicYear,
        guardianName: user.guardianName,
        guardianPhone: user.guardianPhone,
        admissionDate: user.admissionDate,
        joiningDate: user.joiningDate,
        designation: user.designation,
        // Student profile fields
        gender: user.gender,
        dateOfBirth: user.dateOfBirth,
        address: user.address,
        phone2: user.phone2,
        bloodGroup: user.bloodGroup,
        regNo: user.regNo,
        satsNumber: user.satsNumber,
        penNumber: user.penNumber,
        apaarId: user.apaarId,
        mustChangePassword: user.mustChangePassword || false
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during login'
    });
  }
};

const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId)
      .select('-password')
      .populate('currentClass', 'name branch');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update last active asynchronously (no need to await since we don't depend on result)
    User.updateOne({ _id: req.user.userId }, { lastActiveAt: new Date() }).catch(err => console.error('Error updating lastActiveAt:', err));

    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        role: user.role,
        currentClass: user.currentClass,
        academicYear: user.academicYear,
        guardianName: user.guardianName,
        guardianPhone: user.guardianPhone,
        admissionDate: user.admissionDate,
        joiningDate: user.joiningDate,
        designation: user.designation,
        // Student profile fields
        gender: user.gender,
        dateOfBirth: user.dateOfBirth,
        address: user.address,
        phone2: user.phone2,
        bloodGroup: user.bloodGroup,
        regNo: user.regNo,
        satsNumber: user.satsNumber,
        penNumber: user.penNumber,
        apaarId: user.apaarId,
        mustChangePassword: user.mustChangePassword || false
      }
    });
  } catch (error) {
    console.error('Get Me error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};


const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'New password must be at least 8 characters long' });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (!user.mustChangePassword) {
      if (!currentPassword) {
        return res.status(400).json({ success: false, message: 'Current password is required' });
      }
      const isCurrentValid = await user.comparePassword(currentPassword);
      if (!isCurrentValid) {
        return res.status(401).json({ success: false, message: 'Current password is incorrect' });
      }
    }

    const samePassword = await bcrypt.compare(newPassword, user.password);
    if (samePassword) {
      return res.status(400).json({ success: false, message: 'New password must be different from the current password' });
    }

    user.password = newPassword;
    user.mustChangePassword = false;
    await user.save();

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ success: false, message: 'Server error changing password' });
  }
};

module.exports = {
  login,
  getMe,
  changePassword
};
