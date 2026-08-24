const SchoolInfo = require('../models/SchoolInfo');

// Helper to normalize photo URLs into an array of strings
const normalizePhotos = (data) => {
  if (!data) return [];
  const raw = data.photoUrl ?? data.photoUrls ?? data.photourls ?? [];
  if (Array.isArray(raw)) {
    return raw.map(p => (typeof p === 'string' ? p.trim() : (p?.url || ''))).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(p => (typeof p === 'string' ? p.trim() : (p?.url || ''))).filter(Boolean);
      }
    } catch {
      // Not JSON, continue to delimiter split
    }
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
};

// Get school info (public endpoint)
const getSchoolInfo = async (req, res) => {
  try {
    // Always query MongoDB directly to ensure pull-to-refresh gets fresh updates immediately
    const schoolInfo = await SchoolInfo.findOne().lean();

    if (!schoolInfo) {
      return res.status(404).json({
        success: false,
        message: 'School information not found'
      });
    }

    // Normalize photos so photoUrl and photoUrls are always valid arrays
    const photos = normalizePhotos(schoolInfo);
    schoolInfo.photoUrl = photos;
    schoolInfo.photoUrls = photos;

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
    const updateData = { ...req.body };

    if (updateData.photoUrl !== undefined || updateData.photoUrls !== undefined) {
      const photos = normalizePhotos(updateData);
      updateData.photoUrl = photos;
      updateData.photoUrls = photos;
    }

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

    const responseData = schoolInfo.toObject ? schoolInfo.toObject() : schoolInfo;
    const photos = normalizePhotos(responseData);
    responseData.photoUrl = photos;
    responseData.photoUrls = photos;

    res.status(200).json({
      success: true,
      data: responseData,
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

