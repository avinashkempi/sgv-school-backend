const Vibe = require('../models/Vibe');
const VibeLike = require('../models/VibeLike');
const VibeComment = require('../models/VibeComment');
const VibeBookmark = require('../models/VibeBookmark');
const logger = require('../utils/logger');

// NOTE: Push notifications for Vibes are disabled for testing as requested.

/**
 * GET /api/vibes
 * List approved vibes with optional category filter, tags, pagination, and user interaction flags (isLiked, isBookmarked).
 */
exports.listVibes = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 15, 1), 50);
    const skip = (page - 1) * limit;
    const { category, tag, search } = req.query;

    const query = {
      status: 'approved',
      isActive: true
    };

    if (category && category !== 'all') {
      if (category === 'official') {
        query.postAs = 'school';
      } else if (['general', 'achievement', 'life', 'sports', 'arts'].includes(category)) {
        query.category = category;
      }
    }

    if (tag) {
      query.tags = tag.toLowerCase().replace('#', '');
    }

    if (search) {
      query.caption = { $regex: search.trim(), $options: 'i' };
    }

    const [vibes, total] = await Promise.all([
      Vibe.find(query)
        .sort({ isPinned: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('author', 'name role currentClass designation')
        .lean(),
      Vibe.countDocuments(query)
    ]);

    // Check interaction flags for logged-in users
    const currentUserId = req.user?.userId;
    let likedVibeIds = new Set();
    let bookmarkedVibeIds = new Set();

    if (currentUserId && vibes.length > 0) {
      const vibeIds = vibes.map(v => v._id);
      const [userLikes, userBookmarks] = await Promise.all([
        VibeLike.find({ vibe: { $in: vibeIds }, user: currentUserId }).select('vibe').lean(),
        VibeBookmark.find({ vibe: { $in: vibeIds }, user: currentUserId }).select('vibe').lean()
      ]);

      likedVibeIds = new Set(userLikes.map(l => l.vibe.toString()));
      bookmarkedVibeIds = new Set(userBookmarks.map(b => b.vibe.toString()));
    }

    const enhancedVibes = vibes.map(vibe => ({
      ...vibe,
      isLiked: likedVibeIds.has(vibe._id.toString()),
      isBookmarked: bookmarkedVibeIds.has(vibe._id.toString())
    }));

    res.status(200).json({
      success: true,
      data: enhancedVibes,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: skip + vibes.length < total
      }
    });
  } catch (error) {
    logger.error('Error listing vibes:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching vibes' });
  }
};

/**
 * GET /api/vibes/:id
 * Get a single vibe with interaction flags.
 */
exports.getVibe = async (req, res) => {
  try {
    const vibe = await Vibe.findOne({ _id: req.params.id, isActive: true })
      .populate('author', 'name role currentClass designation')
      .populate('reviewedBy', 'name role')
      .lean();

    if (!vibe) {
      return res.status(404).json({ success: false, message: 'Vibe not found' });
    }

    const currentUserId = req.user?.userId;
    let isLiked = false;
    let isBookmarked = false;

    if (currentUserId) {
      const [likeDoc, bookmarkDoc] = await Promise.all([
        VibeLike.findOne({ vibe: vibe._id, user: currentUserId }).lean(),
        VibeBookmark.findOne({ vibe: vibe._id, user: currentUserId }).lean()
      ]);
      isLiked = !!likeDoc;
      isBookmarked = !!bookmarkDoc;
    }

    res.status(200).json({
      success: true,
      data: {
        ...vibe,
        isLiked,
        isBookmarked
      }
    });
  } catch (error) {
    logger.error('Error fetching vibe:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching vibe' });
  }
};

/**
 * POST /api/vibes
 * Create a new vibe.
 * Admin/Super Admin -> Auto approved.
 * Student/Teacher/Staff -> Pending review.
 */
exports.createVibe = async (req, res) => {
  try {
    const { caption, category = 'general', images, postAs = 'self', tags = [], location } = req.body;
    const user = req.user;

    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one photo or video is required' });
    }

    const isVideoMedia = (img) => {
      if (!img) return false;
      if (typeof img === 'object' && img.type === 'video') return true;
      const url = typeof img === 'string' ? img : (img.url || '');
      return /\.(mov|mp4|m4v|webm|avi|3gp|mkv|flv|wmv|qt)(\?.*)?$/i.test(url);
    };

    const hasVideo = images.some(img => isVideoMedia(img));

    // Rule: Only 1 video is allowed, OR up to 5 photos
    let sanitizedMedia = [];
    if (hasVideo) {
      const videoItem = images.find(img => isVideoMedia(img)) || images[0];
      const videoUrl = typeof videoItem === 'string' ? videoItem.trim() : (videoItem.url ? videoItem.url.trim() : '');
      const thumbUrl = typeof videoItem === 'object' && videoItem.thumbnailUrl ? videoItem.thumbnailUrl.trim() : '';
      sanitizedMedia = [{
        type: 'video',
        url: videoUrl,
        thumbnailUrl: thumbUrl,
        duration: typeof videoItem === 'object' ? Math.min(Math.max(Number(videoItem.duration) || 0, 0), 60) : 0,
        publicId: typeof videoItem === 'object' ? (videoItem.publicId || '') : '',
        width: typeof videoItem === 'object' && videoItem.width ? videoItem.width : 720,
        height: typeof videoItem === 'object' && videoItem.height ? videoItem.height : 1280,
        aspectRatio: typeof videoItem === 'object' && videoItem.aspectRatio ? videoItem.aspectRatio : 0.562
      }];
    } else {
      // Up to 5 photos
      sanitizedMedia = images.slice(0, 5).map(img => {
        if (typeof img === 'string') {
          return { type: 'image', url: img.trim(), width: 1080, height: 1080, aspectRatio: 1 };
        }
        return {
          type: 'image',
          url: img.url.trim(),
          publicId: img.publicId || '',
          width: img.width || 1080,
          height: img.height || 1080,
          aspectRatio: img.aspectRatio || (img.width && img.height ? Number((img.width / img.height).toFixed(3)) : 1)
        };
      });
    }

    const isAdmin = user.role === 'admin' || user.role === 'super admin';
    const postIdentity = isAdmin && postAs === 'school' ? 'school' : 'self';
    const initialStatus = isAdmin ? 'approved' : 'pending';

    // Extract hashtags from caption if not explicitly provided
    let extractedTags = Array.isArray(tags) ? [...tags] : [];
    if (caption) {
      const hashMatches = caption.match(/#[a-zA-Z0-9_]+/g);
      if (hashMatches) {
        const cleanedMatches = hashMatches.map(t => t.slice(1).toLowerCase());
        extractedTags = Array.from(new Set(extractedTags.concat(cleanedMatches)));
      }
    }

    const vibe = new Vibe({
      caption: caption ? caption.trim() : '',
      category: ['general', 'achievement', 'life', 'sports', 'arts', 'official'].includes(category) ? category : 'general',
      images: sanitizedMedia,
      author: user.userId,
      postAs: postIdentity,
      authorRole: user.role,
      status: initialStatus,
      tags: extractedTags,
      location: location ? location.trim() : '',
      reviewedBy: isAdmin ? user.userId : undefined,
      reviewedAt: isAdmin ? new Date() : undefined
    });

    await vibe.save();
    await vibe.populate('author', 'name role currentClass designation');

    // NOTE: Notifications intentionally bypassed for testing

    res.status(201).json({
      success: true,
      data: vibe.toObject(),
      message: initialStatus === 'approved'
        ? 'Vibe published successfully!'
        : 'Vibe submitted for admin approval!'
    });
  } catch (error) {
    logger.error('Error creating vibe:', error);
    res.status(500).json({ success: false, message: 'Server error while creating vibe' });
  }
};

/**
 * PUT /api/vibes/:id
 * Update vibe. Author or Admin only.
 */
exports.updateVibe = async (req, res) => {
  try {
    const { caption, category, tags, location } = req.body;
    const vibe = await Vibe.findOne({ _id: req.params.id, isActive: true });

    if (!vibe) {
      return res.status(404).json({ success: false, message: 'Vibe not found' });
    }

    const isAdmin = req.user.role === 'admin' || req.user.role === 'super admin';
    const isAuthor = vibe.author.toString() === req.user.userId;

    if (!isAdmin && !isAuthor) {
      return res.status(403).json({ success: false, message: 'Not authorized to edit this vibe' });
    }

    if (caption !== undefined) vibe.caption = caption.trim();
    if (category !== undefined && ['general', 'achievement', 'life', 'sports', 'arts', 'official'].includes(category)) {
      vibe.category = category;
    }
    if (tags !== undefined && Array.isArray(tags)) {
      vibe.tags = tags.map(t => t.toLowerCase().replace('#', ''));
    }
    if (location !== undefined) vibe.location = location.trim();

    await vibe.save();
    await vibe.populate('author', 'name role currentClass designation');

    res.status(200).json({
      success: true,
      data: vibe.toObject(),
      message: 'Vibe updated successfully'
    });
  } catch (error) {
    logger.error('Error updating vibe:', error);
    res.status(500).json({ success: false, message: 'Server error while updating vibe' });
  }
};

/**
 * DELETE /api/vibes/:id
 * Soft delete vibe. Author or Admin only.
 */
exports.deleteVibe = async (req, res) => {
  try {
    const vibe = await Vibe.findOne({ _id: req.params.id, isActive: true });

    if (!vibe) {
      return res.status(404).json({ success: false, message: 'Vibe not found' });
    }

    const isAdmin = req.user.role === 'admin' || req.user.role === 'super admin';
    const isAuthor = vibe.author.toString() === req.user.userId;

    if (!isAdmin && !isAuthor) {
      return res.status(403).json({ success: false, message: 'Not authorized to delete this vibe' });
    }

    vibe.isActive = false;
    await vibe.save();

    res.status(200).json({ success: true, message: 'Vibe deleted successfully' });
  } catch (error) {
    logger.error('Error deleting vibe:', error);
    res.status(500).json({ success: false, message: 'Server error while deleting vibe' });
  }
};

/**
 * POST /api/vibes/:id/like
 * Toggle like on a vibe with atomic count increment.
 */
exports.toggleLike = async (req, res) => {
  try {
    const vibeId = req.params.id;
    const userId = req.user.userId;

    const vibe = await Vibe.findOne({ _id: vibeId, isActive: true, status: 'approved' });
    if (!vibe) {
      return res.status(404).json({ success: false, message: 'Vibe not found or not approved' });
    }

    const existingLike = await VibeLike.findOne({ vibe: vibeId, user: userId });

    let isLiked = false;
    let updatedLikesCount = vibe.likesCount;

    if (existingLike) {
      await VibeLike.deleteOne({ _id: existingLike._id });
      const updated = await Vibe.findByIdAndUpdate(
        vibeId,
        { $inc: { likesCount: -1 } },
        { new: true }
      );
      updatedLikesCount = Math.max(updated ? updated.likesCount : 0, 0);
      isLiked = false;
    } else {
      try {
        await VibeLike.create({ vibe: vibeId, user: userId });
        const updated = await Vibe.findByIdAndUpdate(
          vibeId,
          { $inc: { likesCount: 1 } },
          { new: true }
        );
        updatedLikesCount = updated ? updated.likesCount : 1;
        isLiked = true;
      } catch (err) {
        if (err.code === 11000) {
          isLiked = true;
          updatedLikesCount = vibe.likesCount;
        } else {
          throw err;
        }
      }
    }

    res.status(200).json({
      success: true,
      data: {
        isLiked,
        likesCount: updatedLikesCount
      }
    });
  } catch (error) {
    logger.error('Error toggling vibe like:', error);
    res.status(500).json({ success: false, message: 'Server error while toggling like' });
  }
};

/**
 * GET /api/vibes/:id/likes
 * Get list of users who liked the vibe.
 */
exports.getVibeLikes = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
    const skip = (page - 1) * limit;

    const [likes, total] = await Promise.all([
      VibeLike.find({ vibe: req.params.id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('user', 'name role currentClass designation')
        .lean(),
      VibeLike.countDocuments({ vibe: req.params.id })
    ]);

    const users = likes.map(l => l.user).filter(Boolean);

    res.status(200).json({
      success: true,
      data: users,
      pagination: {
        page,
        limit,
        total,
        hasMore: skip + likes.length < total
      }
    });
  } catch (error) {
    logger.error('Error fetching vibe likes:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching likes' });
  }
};

/**
 * GET /api/vibes/:id/comments
 * Get comments for a vibe.
 */
exports.getVibeComments = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);
    const skip = (page - 1) * limit;

    const [comments, total] = await Promise.all([
      VibeComment.find({ vibe: req.params.id, isActive: true })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('user', 'name role currentClass designation')
        .lean(),
      VibeComment.countDocuments({ vibe: req.params.id, isActive: true })
    ]);

    res.status(200).json({
      success: true,
      data: comments,
      pagination: {
        page,
        limit,
        total,
        hasMore: skip + comments.length < total
      }
    });
  } catch (error) {
    logger.error('Error fetching comments:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching comments' });
  }
};

/**
 * POST /api/vibes/:id/comments
 * Post a comment on a vibe.
 */
exports.addVibeComment = async (req, res) => {
  try {
    const { text, postAs = 'self', parentComment } = req.body;
    const user = req.user;

    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, message: 'Comment cannot be empty' });
    }

    const vibe = await Vibe.findOne({ _id: req.params.id, isActive: true, status: 'approved' });
    if (!vibe) {
      return res.status(404).json({ success: false, message: 'Vibe not found' });
    }

    const isAdmin = user.role === 'admin' || user.role === 'super admin';
    const commentIdentity = isAdmin && postAs === 'school' ? 'school' : 'self';

    const comment = new VibeComment({
      vibe: vibe._id,
      user: user.userId,
      text: text.trim(),
      postAs: commentIdentity,
      parentComment: parentComment || null
    });

    await comment.save();
    await Vibe.findByIdAndUpdate(vibe._id, { $inc: { commentsCount: 1 } });
    await comment.populate('user', 'name role currentClass designation');

    res.status(201).json({
      success: true,
      data: comment.toObject(),
      message: 'Comment added'
    });
  } catch (error) {
    logger.error('Error adding comment:', error);
    res.status(500).json({ success: false, message: 'Server error while adding comment' });
  }
};

/**
 * DELETE /api/vibes/comments/:commentId
 * Delete a comment. Author or Admin only.
 */
exports.deleteVibeComment = async (req, res) => {
  try {
    const comment = await VibeComment.findOne({ _id: req.params.commentId, isActive: true });
    if (!comment) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }

    const isAdmin = req.user.role === 'admin' || req.user.role === 'super admin';
    const isAuthor = comment.user.toString() === req.user.userId;

    if (!isAdmin && !isAuthor) {
      return res.status(403).json({ success: false, message: 'Not authorized to delete comment' });
    }

    comment.isActive = false;
    await comment.save();
    await Vibe.findByIdAndUpdate(comment.vibe, { $inc: { commentsCount: -1 } });

    res.status(200).json({ success: true, message: 'Comment deleted successfully' });
  } catch (error) {
    logger.error('Error deleting comment:', error);
    res.status(500).json({ success: false, message: 'Server error while deleting comment' });
  }
};

/**
 * POST /api/vibes/:id/bookmark
 * Toggle bookmark / save vibe for current user.
 */
exports.toggleBookmark = async (req, res) => {
  try {
    const vibeId = req.params.id;
    const userId = req.user.userId;

    const existingBookmark = await VibeBookmark.findOne({ vibe: vibeId, user: userId });

    let isBookmarked = false;
    if (existingBookmark) {
      await VibeBookmark.deleteOne({ _id: existingBookmark._id });
      isBookmarked = false;
    } else {
      await VibeBookmark.create({ vibe: vibeId, user: userId });
      isBookmarked = true;
    }

    res.status(200).json({
      success: true,
      data: { isBookmarked },
      message: isBookmarked ? 'Saved to bookmarks' : 'Removed from bookmarks'
    });
  } catch (error) {
    logger.error('Error toggling bookmark:', error);
    res.status(500).json({ success: false, message: 'Server error while saving vibe' });
  }
};

/**
 * GET /api/vibes/user/my-vibes
 * Get current user's submitted vibes (Pending, Approved, Rejected).
 */
exports.getMyVibes = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 15, 1), 50);
    const skip = (page - 1) * limit;
    const { status } = req.query;

    const query = {
      author: req.user.userId,
      isActive: true
    };

    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      query.status = status;
    }

    const [vibes, total, statusCounts] = await Promise.all([
      Vibe.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('author', 'name role')
        .populate('reviewedBy', 'name role')
        .lean(),
      Vibe.countDocuments(query),
      Vibe.aggregate([
        { $match: { author: req.user.userId, isActive: true } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ])
    ]);

    const counts = {
      pending: 0,
      approved: 0,
      rejected: 0
    };
    statusCounts.forEach(c => {
      if (counts[c._id] !== undefined) counts[c._id] = c.count;
    });

    res.status(200).json({
      success: true,
      data: vibes,
      counts,
      pagination: {
        page,
        limit,
        total,
        hasMore: skip + vibes.length < total
      }
    });
  } catch (error) {
    logger.error('Error fetching my vibes:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching your vibes' });
  }
};

/**
 * GET /api/vibes/user/saved
 * Get current user's bookmarked vibes.
 */
exports.getMySavedVibes = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 15, 1), 50);
    const skip = (page - 1) * limit;

    const bookmarks = await VibeBookmark.find({ user: req.user.userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({
        path: 'vibe',
        match: { isActive: true, status: 'approved' },
        populate: { path: 'author', select: 'name role currentClass designation' }
      })
      .lean();

    const vibes = bookmarks.map(b => b.vibe).filter(Boolean).map(v => ({
      ...v,
      isBookmarked: true
    }));

    const total = await VibeBookmark.countDocuments({ user: req.user.userId });

    res.status(200).json({
      success: true,
      data: vibes,
      pagination: {
        page,
        limit,
        total,
        hasMore: skip + bookmarks.length < total
      }
    });
  } catch (error) {
    logger.error('Error fetching saved vibes:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching saved vibes' });
  }
};

// ─────────────────────────────────────────────────────────────
// ADMIN MODERATION CONTROLLERS
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/vibes/admin/pending
 * List all pending vibes requiring review. Admin / Super Admin only.
 */
exports.listPendingVibes = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
    const skip = (page - 1) * limit;

    const [pendingVibes, total] = await Promise.all([
      Vibe.find({ status: 'pending', isActive: true })
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .populate('author', 'name role currentClass designation phone email')
        .lean(),
      Vibe.countDocuments({ status: 'pending', isActive: true })
    ]);

    res.status(200).json({
      success: true,
      data: pendingVibes,
      pendingCount: total,
      pagination: {
        page,
        limit,
        total,
        hasMore: skip + pendingVibes.length < total
      }
    });
  } catch (error) {
    logger.error('Error listing pending vibes:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching pending vibes' });
  }
};

/**
 * PATCH /api/vibes/admin/:id/review
 * Approve or Reject a vibe. Admin / Super Admin only.
 */
exports.reviewVibe = async (req, res) => {
  try {
    const { action, reason } = req.body;
    const vibeId = req.params.id;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Action must be "approve" or "reject"' });
    }

    const vibe = await Vibe.findOne({ _id: vibeId, isActive: true }).populate('author', 'name role');
    if (!vibe) {
      return res.status(404).json({ success: false, message: 'Vibe not found' });
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    vibe.status = newStatus;
    vibe.reviewedBy = req.user.userId;
    vibe.reviewedAt = new Date();
    if (action === 'reject') {
      vibe.rejectionReason = reason ? reason.trim() : 'Does not follow school community guidelines';
    } else {
      vibe.rejectionReason = undefined;
    }

    await vibe.save();

    // NOTE: Notifications intentionally bypassed for testing

    res.status(200).json({
      success: true,
      data: vibe.toObject(),
      message: action === 'approve' ? 'Vibe approved and live!' : 'Vibe rejected.'
    });
  } catch (error) {
    logger.error('Error reviewing vibe:', error);
    res.status(500).json({ success: false, message: 'Server error while reviewing vibe' });
  }
};

/**
 * PATCH /api/vibes/admin/:id/pin
 * Toggle pin status. Admin / Super Admin only.
 */
exports.togglePinVibe = async (req, res) => {
  try {
    const vibe = await Vibe.findOne({ _id: req.params.id, isActive: true });
    if (!vibe) {
      return res.status(404).json({ success: false, message: 'Vibe not found' });
    }

    vibe.isPinned = !vibe.isPinned;
    await vibe.save();

    res.status(200).json({
      success: true,
      data: { isPinned: vibe.isPinned },
      message: vibe.isPinned ? 'Vibe pinned to top' : 'Vibe unpinned'
    });
  } catch (error) {
    logger.error('Error toggling pin:', error);
    res.status(500).json({ success: false, message: 'Server error while toggling pin' });
  }
};

/**
 * PATCH /api/vibes/admin/:id/spotlight
 * Toggle spotlight status. Admin / Super Admin only.
 */
exports.toggleSpotlightVibe = async (req, res) => {
  try {
    const vibe = await Vibe.findOne({ _id: req.params.id, isActive: true });
    if (!vibe) {
      return res.status(404).json({ success: false, message: 'Vibe not found' });
    }

    vibe.isSpotlight = !vibe.isSpotlight;
    await vibe.save();

    res.status(200).json({
      success: true,
      data: { isSpotlight: vibe.isSpotlight },
      message: vibe.isSpotlight ? 'Vibe set as Home Spotlight' : 'Spotlight removed'
    });
  } catch (error) {
    logger.error('Error toggling spotlight:', error);
    res.status(500).json({ success: false, message: 'Server error while toggling spotlight' });
  }
};

/**
 * GET /api/vibes/highlights
 * Returns grouped highlights for the Home Page Stories Tray:
 * - Official announcements
 * - Achievements
 * - Recent campus stories (grouped by author)
 */
exports.getVibeHighlights = async (req, res) => {
  try {
    const [officialVibes, achievementVibes, recentCampusVibes] = await Promise.all([
      // Official / School broadcasts
      Vibe.find({
        status: 'approved',
        isActive: true,
        $or: [{ postAs: 'school' }, { category: 'official' }]
      })
        .sort({ isSpotlight: -1, isPinned: -1, createdAt: -1 })
        .limit(5)
        .populate('author', 'name role')
        .lean(),

      // Achievements
      Vibe.find({
        status: 'approved',
        isActive: true,
        category: 'achievement'
      })
        .sort({ isSpotlight: -1, isPinned: -1, createdAt: -1 })
        .limit(5)
        .populate('author', 'name role')
        .lean(),

      // Recent campus vibes from students & teachers
      Vibe.find({
        status: 'approved',
        isActive: true,
        postAs: 'self'
      })
        .sort({ createdAt: -1 })
        .limit(15)
        .populate('author', 'name role profilePhoto designation currentClass')
        .lean(),
    ]);

    // Group recent campus vibes by unique author for circular story bubbles
    const authorStoriesMap = new Map();
    for (const vibe of recentCampusVibes) {
      const authorId = vibe.author?._id?.toString() || 'unknown';
      if (!authorStoriesMap.has(authorId)) {
        authorStoriesMap.set(authorId, {
          author: vibe.author,
          latestVibeId: vibe._id,
          latestImage: vibe.images?.[0]?.thumbnailUrl || vibe.images?.[0]?.url || '',
          captionPreview: vibe.caption || '',
          category: vibe.category,
          storyCount: 1,
          createdAt: vibe.createdAt
        });
      } else {
        const item = authorStoriesMap.get(authorId);
        item.storyCount += 1;
      }
    }

    const recentAuthorStories = Array.from(authorStoriesMap.values()).slice(0, 10);

    res.status(200).json({
      success: true,
      data: {
        official: officialVibes,
        achievements: achievementVibes,
        stories: recentAuthorStories,
        totalActiveStories: recentCampusVibes.length + officialVibes.length + achievementVibes.length
      }
    });
  } catch (error) {
    logger.error('Error fetching vibe highlights:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching highlights' });
  }
};

/**
 * GET /api/vibes/spotlight
 * Returns the top spotlighted/pinned vibe for the Home Page hero banner.
 */
exports.getSpotlightVibe = async (req, res) => {
  try {
    let spotlight = await Vibe.findOne({
      status: 'approved',
      isActive: true,
      isSpotlight: true
    })
      .populate('author', 'name role currentClass designation')
      .lean();

    // Fallback: If no vibe is explicitly marked spotlight, pick top pinned vibe
    if (!spotlight) {
      spotlight = await Vibe.findOne({
        status: 'approved',
        isActive: true,
        isPinned: true
      })
        .sort({ createdAt: -1 })
        .populate('author', 'name role currentClass designation')
        .lean();
    }

    // Secondary fallback: Most recent official or achievement vibe
    if (!spotlight) {
      spotlight = await Vibe.findOne({
        status: 'approved',
        isActive: true,
        $or: [{ postAs: 'school' }, { category: 'achievement' }]
      })
        .sort({ createdAt: -1 })
        .populate('author', 'name role currentClass designation')
        .lean();
    }

    res.status(200).json({
      success: true,
      data: spotlight || null
    });
  } catch (error) {
    logger.error('Error fetching spotlight vibe:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching spotlight vibe' });
  }
};

/**
 * GET /api/vibes/user/:userId
 * Returns approved vibes for a specific author (for Profile and UserDetailModal).
 */
exports.getUserVibes = async (req, res) => {
  try {
    const { userId } = req.params;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
    const skip = (page - 1) * limit;

    const query = {
      author: userId,
      status: 'approved',
      isActive: true
    };

    const [vibes, total] = await Promise.all([
      Vibe.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('author', 'name role currentClass designation')
        .lean(),
      Vibe.countDocuments(query)
    ]);

    res.status(200).json({
      success: true,
      data: vibes,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: skip + vibes.length < total
      }
    });
  } catch (error) {
    logger.error('Error fetching user vibes:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching user vibes' });
  }
};
