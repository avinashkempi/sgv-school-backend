const Labels = require('../models/Labels');

// In-memory cache for labels (static data, rarely changes)
let cachedLabels = null;
let cachedVersion = null;

/**
 * GET /api/labels
 * Returns all UI labels. Public endpoint (no auth required).
 * Supports conditional fetching via ?v= query param — if the client
 * already has the same version, returns 304 Not Modified.
 */
const getLabels = async (req, res) => {
  try {
    const clientVersion = parseInt(req.query.v, 10) || 0;

    // Return cached if available
    if (cachedLabels && cachedVersion) {
      // If client already has this version, skip the payload
      if (clientVersion === cachedVersion) {
        return res.status(304).end();
      }
      return res.status(200).json({
        success: true,
        data: cachedLabels,
        version: cachedVersion
      });
    }

    const labelsDoc = await Labels.findOne().lean();

    if (!labelsDoc) {
      return res.status(404).json({
        success: false,
        message: 'Labels not found. Run the seed script first.'
      });
    }

    // Populate cache
    cachedLabels = labelsDoc.labels;
    cachedVersion = labelsDoc.version;

    // Client version check
    if (clientVersion === cachedVersion) {
      return res.status(304).end();
    }

    res.status(200).json({
      success: true,
      data: cachedLabels,
      version: cachedVersion
    });
  } catch (error) {
    console.error('Error fetching labels:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching labels'
    });
  }
};

/**
 * Invalidate cache — call this if labels are ever updated programmatically.
 */
const invalidateLabelsCache = () => {
  cachedLabels = null;
  cachedVersion = null;
};

module.exports = {
  getLabels,
  invalidateLabelsCache
};
