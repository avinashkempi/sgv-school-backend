const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    minlength: [3, 'Name must be at least 3 characters long'],
    maxlength: [50, 'Name cannot exceed 50 characters']
  },
  phone: {
    type: String,
    required: [false, 'Phone number is required'], // Made optional as some might use phone2 as primary
    unique: true,
    sparse: true, // Allow multiple nulls
    trim: true,
    match: [/^[6-9]\d{9}$/, 'Please enter a valid 10-digit Indian phone number (starting with 6-9)']
  },
  email: {
    type: String,
    required: false,
    lowercase: true,
    trim: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters long']
  },
  // Role field for access control
  role: {
    type: String,
    enum: ['student', 'teacher', 'staff', 'admin', 'super admin'], // Removed 'class teacher', added 'teacher'
    default: 'student'
  },

  // Student specific fields
  admissionDate: {
    type: Date
  },
  guardianName: {
    type: String,
    trim: true
  },
  guardianPhone: {
    type: String,
    trim: true,
    match: [/^[6-9]\d{9}$/, 'Please enter a valid 10-digit Indian phone number']
  },
  currentClass: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Class'
  },
  academicYear: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AcademicYear'
  },

  // NEW: Student Profile Fields
  gender: {
    type: String,
    enum: ['Boy', 'Girl', 'Other'],
    trim: true
  },
  dateOfBirth: {
    type: Date
  },
  address: {
    type: String,
    trim: true
  },
  phone2: {
    type: String,
    trim: true,
    match: [/^[6-9]\d{9}$/, 'Please enter a valid 10-digit Indian phone number']
  },
  remarks: {
    type: String,
    trim: true
  },

  // NEW: Student ID Fields
  regNo: {
    type: String,
    trim: true
  },
  satsNumber: {
    type: String,
    trim: true
  },
  penNumber: {
    type: String,
    trim: true
  },
  apaarId: {
    type: String,
    trim: true
  },

  // NEW: Admission Status
  isAdmitted: {
    type: Boolean,
    default: true
  },

  // Teacher specific fields
  joiningDate: {
    type: Date
  },
  designation: {
    type: String,
    trim: true
  },
  subjects: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subject'
  }],

  createdAt: {
    type: Date,
    default: Date.now
  },
  notificationPreferences: {
    homework: { type: Boolean, default: true },
    exam: { type: Boolean, default: true },
    fee: { type: Boolean, default: true },
    event: { type: Boolean, default: true },
    general: { type: Boolean, default: true }
  }
});

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Indexes for efficient queries
userSchema.index({ role: 1 });
userSchema.index({ currentClass: 1 });
userSchema.index({ academicYear: 1 });
userSchema.index({ name: 1 });
userSchema.index({ email: 1 });
userSchema.index({ phone: 1 });

module.exports = mongoose.model('User', userSchema);
