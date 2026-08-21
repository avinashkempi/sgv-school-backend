const Labels = require('../models/Labels');
const DEFAULT_LABELS = require('../constants/defaultLabels');

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

    let labelsDoc = null;
    try {
      labelsDoc = await Labels.findOne().lean();
    } catch (dbErr) {
      console.warn('Could not query Labels from DB, falling back to defaults:', dbErr.message);
    }

    if (!labelsDoc) {
      // Auto-seed to DB in background if connection is active
      try {
        const created = await Labels.create({
          labels: DEFAULT_LABELS,
          version: 1
        });
        cachedLabels = created.labels;
        cachedVersion = created.version;
      } catch (_seedErr) {
        // Fallback to in-memory defaults
        cachedLabels = DEFAULT_LABELS;
        cachedVersion = 1;
      }
    } else {
      // Populate cache
      cachedLabels = labelsDoc.labels;
      cachedVersion = labelsDoc.version;
    }

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
    console.error('Error in labels controller, serving default fallback:', error);
    res.status(200).json({
      success: true,
      data: DEFAULT_LABELS,
      version: 1
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
