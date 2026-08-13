const SchoolInfo = require('../models/SchoolInfo');

// In-memory cache for school info (static data)
let cachedSchoolInfo = null;

// Get school info (public endpoint)
const getSchoolInfo = async (req, res) => {
  try {
    // Return cached document if available
    if (cachedSchoolInfo) {
      return res.status(200).json({
        success: true,
        data: cachedSchoolInfo
      });
    }

    // Get the first (and likely only) school info document
    const schoolInfo = await SchoolInfo.findOne().lean();

    if (!schoolInfo) {
      return res.status(404).json({
        success: false,
        message: 'School information not found'
      });
    }

    cachedSchoolInfo = schoolInfo;

    res.status(200).json({
      success: true,
      data: schoolInfo
    });
  } catch (error) {
    console.error('Error fetching school info:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching school information'
    });
  }
};

// Create or update school info (admin only)
const createOrUpdateSchoolInfo = async (req, res) => {
  try {
    const updateData = req.body;

    // Find existing school info or create new one
    let schoolInfo = await SchoolInfo.findOne();

    if (schoolInfo) {
      // Update existing
      Object.assign(schoolInfo, updateData);
      await schoolInfo.save();
    } else {
      // Create new
      schoolInfo = new SchoolInfo(updateData);
      await schoolInfo.save();
    }

    // Invalidate and refresh cache
    cachedSchoolInfo = schoolInfo.toObject ? schoolInfo.toObject() : schoolInfo;

    res.status(200).json({
      success: true,
      data: schoolInfo,
      message: schoolInfo.isNew ? 'School info created successfully' : 'School info updated successfully'
    });
  } catch (error) {
    console.error('Error creating/updating school info:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while saving school information'
    });
  }
};

module.exports = {
  getSchoolInfo,
  createOrUpdateSchoolInfo
};

