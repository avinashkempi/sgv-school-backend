const mongoose = require('mongoose');
const Vibe = require('../models/Vibe');
const VibeLike = require('../models/VibeLike');
const VibeComment = require('../models/VibeComment');
const VibeBookmark = require('../models/VibeBookmark');
const VibeView = require('../models/VibeView');
const Notification = require('../models/Notification');
const { sendTargetedNotification } = require('../services/notificationService');
const { VIBE_CATEGORIES } = require('../constants/vibeCategories');
const logger = require('../utils/logger');

const isValidObjectId = (id) => Boolean(id && id !== 'undefined' && id !== 'null' && mongoose.Types.ObjectId.isValid(id));

/**
 * GET /api/vibes/categories
 * Fetch available vibe categories.
 */
exports.getCategories = async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      data: VIBE_CATEGORIES
    });
  } catch (error) {
    logger.error('Error fetching vibe categories:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching categories' });
  }
};

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
        query.$or = [{ postAs: 'school' }, { category: 'official' }];
      } else {
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
        .populate({
          path: "author",
          select: "name role profilePhoto currentClass designation",
          populate: {
            path: "currentClass",
            select: "label name section",
          },
        })
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
      likesCount: Math.max(0, Number(vibe.likesCount) || 0),
      commentsCount: Math.max(0, Number(vibe.commentsCount) || 0),
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
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid vibe ID' });
    }

    const vibe = await Vibe.findOne({ _id: req.params.id, isActive: true })
      .populate({
        path: 'author',
        select: 'name role profilePhoto currentClass designation',
        populate: { path: 'currentClass', select: 'label name section' }
      })
      .populate('reviewedBy', 'name role profilePhoto')
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
        likesCount: Math.max(0, Number(vibe.likesCount) || 0),
        commentsCount: Math.max(0, Number(vibe.commentsCount) || 0),
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
    const { caption, category = 'general', images, postAs = 'self', tags = [], location, isSpotlight = false } = req.body;
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
      let thumbUrl = typeof videoItem === 'object' && videoItem.thumbnailUrl ? videoItem.thumbnailUrl.trim() : '';

      // Auto-generate Cloudinary poster thumbnail if omitted
      if (!thumbUrl && videoUrl && videoUrl.includes('cloudinary.com')) {
        thumbUrl = videoUrl
          .replace(/\/video\/upload\/(?:[^/]+\/)?/, '/video/upload/so_0,w_720,q_auto,f_auto/')
          .replace(/\.(mp4|mov|webm|m4v|avi|3gp|mkv|flv|wmv|qt)(\?.*)?$/i, '.jpg');
      }

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

    const rawCat = (category && typeof category === 'string') ? category.trim() : 'general';
    const finalCategory = isAdmin
      ? ((postIdentity === 'school' || rawCat === 'official') ? 'official' : (rawCat || 'general'))
      : (rawCat === 'official' ? 'general' : (rawCat || 'general'));

    const vibe = new Vibe({
      caption: caption ? caption.trim() : '',
      category: finalCategory,
      images: sanitizedMedia,
      author: user.userId,
      postAs: postIdentity,
      authorRole: user.role,
      status: initialStatus,
      tags: extractedTags,
      location: location ? location.trim() : '',
      isSpotlight: isAdmin ? Boolean(isSpotlight) : false,
      reviewedBy: isAdmin ? user.userId : undefined,
      reviewedAt: isAdmin ? new Date() : undefined
    });

    await vibe.save();
    await vibe.populate({
      path: 'author',
      select: 'name role profilePhoto currentClass designation',
      populate: { path: 'currentClass', select: 'label name section' }
    });

    // Notify administrators if a non-admin user submitted a vibe for approval
    if (!isAdmin) {
      (async () => {
        try {
          const authorName = user.name || 'A community member';
          const title = '✨ New Vibe Submitted for Review';
          const message = `${authorName} submitted a new vibe: "${(caption || '').slice(0, 60)}"`;

          await Notification.create({
            title,
            message,
            type: 'General',
            category: 'general',
            targetRole: 'admin',
            actionType: 'navigate',
            actionData: '/admin/vibe-approvals'
          }).catch(() => {});

          await sendTargetedNotification('admin', null, {
            title,
            message,
            type: 'General'
          }).catch(() => {});
        } catch (notifErr) {
          logger.error('[Create Vibe] Admin notification error:', notifErr);
        }
      })();
    }

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
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid vibe ID' });
    }

    const { caption, category, images, postAs, tags, location, isSpotlight } = req.body;
    const vibe = await Vibe.findOne({ _id: req.params.id, isActive: true });

    if (!vibe) {
      return res.status(404).json({ success: false, message: 'Vibe not found' });
    }

    const isAdmin = req.user.role === 'admin' || req.user.role === 'super admin';
    const isAuthor = vibe.author.toString() === req.user.userId;

    if (!isAdmin && !isAuthor) {
      return res.status(403).json({ success: false, message: 'Not authorized to edit this vibe' });
    }

    if (caption !== undefined) {
      vibe.caption = caption ? caption.trim() : '';
      if (tags === undefined) {
        const hashMatches = vibe.caption.match(/#[a-zA-Z0-9_]+/g);
        if (hashMatches) {
          vibe.tags = Array.from(new Set(hashMatches.map(t => t.slice(1).toLowerCase())));
        } else {
          vibe.tags = [];
        }
      }
    }

    if (tags !== undefined && Array.isArray(tags)) {
      vibe.tags = Array.from(new Set(tags.map(t => t.toLowerCase().replace('#', '').trim()).filter(Boolean)));
    }

    if (isAdmin && postAs !== undefined) {
      vibe.postAs = postAs === 'school' ? 'school' : 'self';
    }

    if (isAdmin) {
      if (category !== undefined) {
        const rawCat = (typeof category === 'string') ? category.trim() : 'general';
        vibe.category = (vibe.postAs === 'school' || rawCat === 'official') ? 'official' : rawCat;
      } else if (vibe.postAs === 'school') {
        vibe.category = 'official';
      }
      if (isSpotlight !== undefined) {
        vibe.isSpotlight = Boolean(isSpotlight);
      }
    } else {
      // Non-admin cannot post as official or change spotlight
      if (category !== undefined) {
        const rawCat = (typeof category === 'string') ? category.trim() : 'general';
        vibe.category = rawCat === 'official' ? 'general' : rawCat;
      }
      vibe.isSpotlight = false;

      // Reset status to pending for moderation when edited by non-admin
      vibe.status = 'pending';
      vibe.reviewedBy = undefined;
      vibe.reviewedAt = undefined;
      vibe.rejectionReason = undefined;
    }

    if (location !== undefined) vibe.location = location ? location.trim() : '';

    if (images !== undefined && Array.isArray(images) && images.length > 0) {
      const isVideoMedia = (img) => {
        if (!img) return false;
        if (typeof img === 'object' && img.type === 'video') return true;
        const url = typeof img === 'string' ? img : (img.url || '');
        return /\.(mov|mp4|m4v|webm|avi|3gp|mkv|flv|wmv|qt)(\?.*)?$/i.test(url);
      };

      const hasVideo = images.some(img => isVideoMedia(img));

      if (hasVideo) {
        const videoItem = images.find(img => isVideoMedia(img)) || images[0];
        const videoUrl = typeof videoItem === 'string' ? videoItem.trim() : (videoItem.url ? videoItem.url.trim() : '');
        let thumbUrl = typeof videoItem === 'object' && videoItem.thumbnailUrl ? videoItem.thumbnailUrl.trim() : '';

        if (!thumbUrl && videoUrl && videoUrl.includes('cloudinary.com')) {
          thumbUrl = videoUrl
            .replace(/\/video\/upload\/(?:[^/]+\/)?/, '/video/upload/so_0,w_720,q_auto,f_auto/')
            .replace(/\.(mp4|mov|webm|m4v|avi|3gp|mkv|flv|wmv|qt)(\?.*)?$/i, '.jpg');
        }

        vibe.images = [{
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
        vibe.images = images.slice(0, 5).map(img => {
          if (typeof img === 'string') {
            return { type: 'image', url: img.trim(), width: 1080, height: 1080, aspectRatio: 1 };
          }
          return {
            type: 'image',
            url: img.url ? img.url.trim() : '',
            publicId: img.publicId || '',
            width: img.width || 1080,
            height: img.height || 1080,
            aspectRatio: img.aspectRatio || (img.width && img.height ? Number((img.width / img.height).toFixed(3)) : 1)
          };
        });
      }
    }

    await vibe.save();
    await vibe.populate({
      path: 'author',
      select: 'name role profilePhoto currentClass designation',
      populate: { path: 'currentClass', select: 'label name section' }
    });

    // Notify administrators if a non-admin user updated a vibe and sent it for review
    if (!isAdmin) {
      (async () => {
        try {
          const authorName = req.user.name || 'A community member';
          const title = '✨ Edited Vibe Submitted for Review';
          const message = `${authorName} updated their vibe: "${(vibe.caption || '').slice(0, 60)}"`;

          await Notification.create({
            title,
            message,
            type: 'General',
            category: 'general',
            targetRole: 'admin',
            actionType: 'navigate',
            actionData: '/admin/vibe-approvals'
          }).catch(() => {});

          await sendTargetedNotification('admin', null, {
            title,
            message,
            type: 'General'
          }).catch(() => {});
        } catch (notifErr) {
          logger.error('[Update Vibe] Admin notification error:', notifErr);
        }
      })();
    }

    res.status(200).json({
      success: true,
      data: vibe.toObject(),
      message: isAdmin ? 'Vibe updated successfully' : 'Vibe updated and submitted for admin review!'
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
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid vibe ID' });
    }

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
    vibe.isSpotlight = false;
    vibe.isPinned = false;
    await vibe.save();

    // Clean up associated bookmarks, likes, views, and comments
    await Promise.all([
      VibeBookmark.deleteMany({ vibe: vibe._id }),
      VibeLike.deleteMany({ vibe: vibe._id }),
      VibeView.deleteMany({ vibe: vibe._id }),
      VibeComment.updateMany({ vibe: vibe._id }, { isActive: false })
    ]).catch(() => {});

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
    if (!isValidObjectId(vibeId)) {
      return res.status(400).json({ success: false, message: 'Invalid vibe ID' });
    }

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
        [
          {
            $set: {
              likesCount: {
                $max: [0, { $subtract: [{ $ifNull: ["$likesCount", 1] }, 1] }]
              }
            }
          }
        ],
        { new: true }
      );
      updatedLikesCount = updated ? Math.max(0, Number(updated.likesCount) || 0) : 0;
      isLiked = false;
    } else {
      try {
        await VibeLike.create({ vibe: vibeId, user: userId });
        const updated = await Vibe.findByIdAndUpdate(
          vibeId,
          { $inc: { likesCount: 1 } },
          { new: true }
        );
        updatedLikesCount = updated ? Math.max(0, Number(updated.likesCount) || 0) : 1;
        isLiked = true;

        // Trigger notification to vibe author if liked by another user
        if (vibe.author && vibe.author.toString() !== userId) {
          (async () => {
            try {
              const likerName = req.user.name || 'Someone';
              const title = '❤️ New Like on your Vibe';
              const message = `${likerName} liked your vibe.`;

              await Notification.create({
                title,
                message,
                type: 'General',
                category: 'general',
                recipient: vibe.author,
                actionType: 'navigate',
                actionData: '/vibes'
              }).catch(() => {});

              await sendTargetedNotification('user', vibe.author, {
                title,
                message,
                type: 'General'
              }).catch(() => {});
            } catch (notifErr) {
              logger.error('[Vibe Like] Notification error:', notifErr);
            }
          })();
        }
      } catch (err) {
        if (err.code === 11000) {
          isLiked = true;
          updatedLikesCount = Math.max(0, Number(vibe.likesCount) || 0);
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
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid vibe ID' });
    }

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
    const skip = (page - 1) * limit;

    const [likes, total] = await Promise.all([
      VibeLike.find({ vibe: req.params.id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('user', 'name role profilePhoto currentClass designation')
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
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid vibe ID' });
    }

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);
    const skip = (page - 1) * limit;

    const currentUserId = req.user?.userId;

    const [comments, total] = await Promise.all([
      VibeComment.find({ vibe: req.params.id, isActive: true })
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .populate('user', 'name role profilePhoto currentClass designation')
        .populate({
          path: 'parentComment',
          select: 'text user postAs',
          populate: { path: 'user', select: 'name' }
        })
        .lean(),
      VibeComment.countDocuments({ vibe: req.params.id, isActive: true })
    ]);

    const enhancedComments = comments.map(c => ({
      ...c,
      likesCount: Math.max(0, Number(c.likesCount) || (Array.isArray(c.likes) ? c.likes.length : 0)),
      isLiked: Boolean(currentUserId && Array.isArray(c.likes) && c.likes.some(u => u.toString() === currentUserId))
    }));

    res.status(200).json({
      success: true,
      data: enhancedComments,
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
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid vibe ID' });
    }

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
      parentComment: (parentComment && isValidObjectId(parentComment)) ? parentComment : null
    });

    await comment.save();
    const updatedVibe = await Vibe.findByIdAndUpdate(
      vibe._id,
      { $inc: { commentsCount: 1 } },
      { new: true }
    );
    await comment.populate('user', 'name role profilePhoto currentClass designation');
    if (comment.parentComment) {
      await comment.populate({
        path: 'parentComment',
        select: 'text user postAs',
        populate: { path: 'user', select: 'name' }
      });
    }

    // Trigger notification to vibe author (if commenter !== author)
    if (vibe.author && vibe.author.toString() !== user.userId) {
      (async () => {
        try {
          const commenterName = commentIdentity === 'school' ? 'SGV School' : (user.name || 'A community member');
          const title = '💬 New Comment on your Vibe';
          const message = `${commenterName}: "${text.slice(0, 80)}"`;

          await Notification.create({
            title,
            message,
            type: 'General',
            category: 'general',
            recipient: vibe.author,
            actionType: 'navigate',
            actionData: '/vibes'
          }).catch(() => {});

          await sendTargetedNotification('user', vibe.author, {
            title,
            message,
            type: 'General'
          }).catch(() => {});
        } catch (notifErr) {
          logger.error('[Vibe Comment] Notification error:', notifErr);
        }
      })();
    }

    const resComment = comment.toObject();
    resComment.likesCount = 0;
    resComment.isLiked = false;

    res.status(201).json({
      success: true,
      data: resComment,
      commentsCount: updatedVibe ? Math.max(0, Number(updatedVibe.commentsCount) || 0) : 1,
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
    if (!isValidObjectId(req.params.commentId)) {
      return res.status(400).json({ success: false, message: 'Invalid comment ID' });
    }

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
    const updatedVibe = await Vibe.findByIdAndUpdate(
      comment.vibe,
      [
        {
          $set: {
            commentsCount: {
              $max: [0, { $subtract: [{ $ifNull: ["$commentsCount", 1] }, 1] }]
            }
          }
        }
      ],
      { new: true }
    );

    res.status(200).json({
      success: true,
      commentsCount: updatedVibe ? Math.max(0, Number(updatedVibe.commentsCount) || 0) : 0,
      message: 'Comment deleted successfully'
    });
  } catch (error) {
    logger.error('Error deleting comment:', error);
    res.status(500).json({ success: false, message: 'Server error while deleting comment' });
  }
};

/**
 * POST /api/vibes/comments/:commentId/like
 * Toggle like on a specific comment.
 */
exports.toggleCommentLike = async (req, res) => {
  try {
    const { commentId } = req.params;
    if (!isValidObjectId(commentId)) {
      return res.status(400).json({ success: false, message: 'Invalid comment ID' });
    }

    const userId = req.user.userId;
    const comment = await VibeComment.findOne({ _id: commentId, isActive: true });
    if (!comment) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }

    if (!Array.isArray(comment.likes)) {
      comment.likes = [];
    }

    const userObjId = new mongoose.Types.ObjectId(userId);
    const existingIndex = comment.likes.findIndex(id => id.toString() === userId);
    let isLiked = false;

    if (existingIndex > -1) {
      comment.likes.splice(existingIndex, 1);
      comment.likesCount = Math.max(0, (comment.likesCount || 1) - 1);
      isLiked = false;
    } else {
      comment.likes.push(userObjId);
      comment.likesCount = (comment.likesCount || 0) + 1;
      isLiked = true;
    }

    await comment.save();

    res.status(200).json({
      success: true,
      data: {
        isLiked,
        likesCount: comment.likesCount
      }
    });
  } catch (error) {
    logger.error('Error toggling comment like:', error);
    res.status(500).json({ success: false, message: 'Server error while toggling comment like' });
  }
};

/**
 * POST /api/vibes/:id/bookmark
 * Toggle bookmark / save vibe for current user.
 */
exports.toggleBookmark = async (req, res) => {
  try {
    const vibeId = req.params.id;
    if (!isValidObjectId(vibeId)) {
      return res.status(400).json({ success: false, message: 'Invalid vibe ID' });
    }

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
        .populate({
          path: 'author',
          select: 'name role profilePhoto currentClass designation',
          populate: { path: 'currentClass', select: 'label name section' }
        })
        .populate('reviewedBy', 'name role profilePhoto')
        .lean(),
      Vibe.countDocuments(query),
      Vibe.aggregate([
        { $match: { author: new mongoose.Types.ObjectId(req.user.userId), isActive: true } },
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
      likesCount: Math.max(0, Number(vibe.likesCount) || 0),
      commentsCount: Math.max(0, Number(vibe.commentsCount) || 0),
      isLiked: likedVibeIds.has(vibe._id.toString()),
      isBookmarked: bookmarkedVibeIds.has(vibe._id.toString())
    }));

    res.status(200).json({
      success: true,
      data: enhancedVibes,
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
    const userObjId = new mongoose.Types.ObjectId(req.user.userId);

    const matchPipeline = [
      { $match: { user: userObjId } },
      {
        $lookup: {
          from: 'vibes',
          localField: 'vibe',
          foreignField: '_id',
          as: 'vibeDoc'
        }
      },
      { $unwind: '$vibeDoc' },
      {
        $match: {
          'vibeDoc.isActive': true,
          'vibeDoc.status': 'approved'
        }
      }
    ];

    const [savedResults, countResult] = await Promise.all([
      VibeBookmark.aggregate([
        ...matchPipeline,
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $lookup: {
            from: 'users',
            localField: 'vibeDoc.author',
            foreignField: '_id',
            as: 'authorDoc'
          }
        },
        {
          $unwind: {
            path: '$authorDoc',
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $lookup: {
            from: 'classes',
            localField: 'authorDoc.currentClass',
            foreignField: '_id',
            as: 'classDoc'
          }
        },
        {
          $unwind: {
            path: '$classDoc',
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $project: {
            _id: '$vibeDoc._id',
            caption: '$vibeDoc.caption',
            category: '$vibeDoc.category',
            images: '$vibeDoc.images',
            author: {
              _id: '$authorDoc._id',
              name: '$authorDoc.name',
              role: '$authorDoc.role',
              profilePhoto: '$authorDoc.profilePhoto',
              designation: '$authorDoc.designation',
              currentClass: {
                _id: '$classDoc._id',
                label: '$classDoc.label',
                name: '$classDoc.name',
                section: '$classDoc.section'
              }
            },
            postAs: '$vibeDoc.postAs',
            authorRole: '$vibeDoc.authorRole',
            status: '$vibeDoc.status',
            tags: '$vibeDoc.tags',
            location: '$vibeDoc.location',
            likesCount: '$vibeDoc.likesCount',
            commentsCount: '$vibeDoc.commentsCount',
            isPinned: '$vibeDoc.isPinned',
            isSpotlight: '$vibeDoc.isSpotlight',
            createdAt: '$vibeDoc.createdAt',
            updatedAt: '$vibeDoc.updatedAt'
          }
        }
      ]),
      VibeBookmark.aggregate([
        ...matchPipeline,
        { $count: 'total' }
      ])
    ]);

    const total = countResult[0]?.total || 0;
    const vibeIds = savedResults.map(v => v._id);
    let likedVibeIds = new Set();
    if (vibeIds.length > 0) {
      const userLikes = await VibeLike.find({ vibe: { $in: vibeIds }, user: req.user.userId }).select('vibe').lean();
      likedVibeIds = new Set(userLikes.map(l => l.vibe.toString()));
    }

    const vibes = savedResults.map(v => ({
      ...v,
      likesCount: Math.max(0, Number(v.likesCount) || 0),
      commentsCount: Math.max(0, Number(v.commentsCount) || 0),
      isLiked: likedVibeIds.has(v._id.toString()),
      isBookmarked: true
    }));

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
        .populate({
          path: 'author',
          select: 'name role profilePhoto currentClass designation phone email',
          populate: { path: 'currentClass', select: 'label name section' }
        })
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

    if (!isValidObjectId(vibeId)) {
      return res.status(400).json({ success: false, message: 'Invalid vibe ID' });
    }

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Action must be "approve" or "reject"' });
    }

    const vibe = await Vibe.findOne({ _id: vibeId, isActive: true }).populate('author', 'name role profilePhoto currentClass designation');
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

    // Trigger push & in-app notification to author
    (async () => {
      try {
        const authorId = vibe.author?._id || vibe.author;
        const title = action === 'approve' ? '✨ Vibe Approved!' : 'Vibe Submission Update';
        const message = action === 'approve'
          ? 'Your campus vibe has been approved and is now live on SGV Campus Feed!'
          : `Your vibe submission was not approved: ${vibe.rejectionReason}`;

        await Notification.create({
          title,
          message,
          type: 'General',
          category: 'general',
          recipient: authorId,
          actionType: 'navigate',
          actionData: '/vibes'
        }).catch(() => {});

        await sendTargetedNotification('user', authorId, {
          title,
          message,
          type: 'General'
        }).catch(() => {});
      } catch (notifErr) {
        logger.error('[Vibe Review] Notification error:', notifErr);
      }
    })();

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
 * POST /api/vibes/admin/batch-review
 * Approve or Reject multiple pending vibes at once. Admin / Super Admin only.
 */
exports.batchReviewVibes = async (req, res) => {
  try {
    const { vibeIds, action, reason } = req.body;

    if (!Array.isArray(vibeIds) || vibeIds.length === 0) {
      return res.status(400).json({ success: false, message: 'vibeIds array is required' });
    }

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Action must be "approve" or "reject"' });
    }

    const validIds = vibeIds.filter(id => isValidObjectId(id)).map(id => new mongoose.Types.ObjectId(id));
    if (validIds.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid vibe IDs provided' });
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    const finalReason = reason ? reason.trim() : 'Does not follow school community guidelines';

    const updateDoc = {
      $set: {
        status: newStatus,
        reviewedBy: new mongoose.Types.ObjectId(req.user.userId),
        reviewedAt: new Date(),
        ...(action === 'reject' ? { rejectionReason: finalReason } : {})
      }
    };

    if (action === 'approve') {
      updateDoc.$unset = { rejectionReason: 1 };
    }

    await Vibe.updateMany(
      { _id: { $in: validIds }, isActive: true },
      updateDoc
    );

    // Trigger push & in-app notifications asynchronously
    (async () => {
      try {
        const vibes = await Vibe.find({ _id: { $in: validIds } }).select('author caption category');
        for (const v of vibes) {
          if (!v.author) continue;
          const title = action === 'approve' ? '✨ Vibe Approved!' : 'Vibe Submission Update';
          const message = action === 'approve'
            ? 'Your campus vibe has been approved and is now live on SGV Campus Feed!'
            : `Your vibe submission was not approved: ${finalReason}`;

          await Notification.create({
            title,
            message,
            type: 'General',
            category: 'general',
            recipient: v.author,
            actionType: 'navigate',
            actionData: '/vibes'
          }).catch(() => {});

          await sendTargetedNotification('user', v.author, {
            title,
            message,
            type: 'General'
          }).catch(() => {});
        }
      } catch (notifErr) {
        logger.error('[Batch Vibe Review] Notification error:', notifErr);
      }
    })();

    res.status(200).json({
      success: true,
      message: `Successfully ${action === 'approve' ? 'approved' : 'rejected'} ${validIds.length} ${validIds.length === 1 ? 'vibe' : 'vibes'}!`
    });
  } catch (error) {
    logger.error('Error batch reviewing vibes:', error);
    res.status(500).json({ success: false, message: 'Server error while batch reviewing vibes' });
  }
};

/**
 * PATCH /api/vibes/admin/:id/pin
 * Toggle pin status. Admin / Super Admin only.
 */
exports.togglePinVibe = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid vibe ID' });
    }

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
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid vibe ID' });
    }

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
        .populate({
          path: 'author',
          select: 'name role profilePhoto currentClass designation',
          populate: { path: 'currentClass', select: 'label name section' }
        })
        .lean(),

      // Achievements
      Vibe.find({
        status: 'approved',
        isActive: true,
        category: 'achievement'
      })
        .sort({ isSpotlight: -1, isPinned: -1, createdAt: -1 })
        .limit(5)
        .populate({
          path: 'author',
          select: 'name role profilePhoto currentClass designation',
          populate: { path: 'currentClass', select: 'label name section' }
        })
        .lean(),

      // Recent campus vibes from students & teachers (excluding official announcements to prevent duplication)
      Vibe.find({
        status: 'approved',
        isActive: true,
        postAs: 'self',
        category: { $ne: 'official' }
      })
        .sort({ createdAt: -1 })
        .limit(15)
        .populate({
          path: 'author',
          select: 'name role profilePhoto designation currentClass',
          populate: { path: 'currentClass', select: 'label name section' }
        })
        .lean(),
    ]);

    // Enhance with user interaction flags if logged in
    // Enhance with user interaction flags and view status if logged in
    const currentUserId = req.user?.userId;
    let likedVibeIds = new Set();
    let bookmarkedVibeIds = new Set();
    let viewedVibeIds = new Set();

    const allFetchedVibes = [...officialVibes, ...achievementVibes, ...recentCampusVibes];
    if (currentUserId && allFetchedVibes.length > 0) {
      const vibeIds = allFetchedVibes.map(v => v._id);
      const [userLikes, userBookmarks, userViews] = await Promise.all([
        VibeLike.find({ vibe: { $in: vibeIds }, user: currentUserId }).select('vibe').lean(),
        VibeBookmark.find({ vibe: { $in: vibeIds }, user: currentUserId }).select('vibe').lean(),
        VibeView.find({ vibe: { $in: vibeIds }, user: currentUserId }).select('vibe').lean()
      ]);

      likedVibeIds = new Set(userLikes.map(l => l.vibe.toString()));
      bookmarkedVibeIds = new Set(userBookmarks.map(b => b.vibe.toString()));
      viewedVibeIds = new Set(userViews.map(v => v.vibe.toString()));
    }

    const enhanceVibe = (vibe) => ({
      ...vibe,
      isLiked: likedVibeIds.has(vibe._id.toString()),
      isBookmarked: bookmarkedVibeIds.has(vibe._id.toString()),
      isViewed: viewedVibeIds.has(vibe._id.toString())
    });

    const enhancedOfficial = officialVibes.map(enhanceVibe);
    const enhancedAchievements = achievementVibes.map(enhanceVibe);
    const enhancedRecentCampus = recentCampusVibes.map(enhanceVibe);

    // Group recent campus vibes by unique author for circular story bubbles
    const authorStoriesMap = new Map();
    for (const vibe of enhancedRecentCampus) {
      if (!vibe.author || !vibe.author._id) continue;
      const authorId = vibe.author._id.toString();
      if (!authorStoriesMap.has(authorId)) {
        authorStoriesMap.set(authorId, {
          author: vibe.author,
          latestVibeId: vibe._id,
          latestImage: vibe.images?.[0]?.thumbnailUrl || vibe.images?.[0]?.url || '',
          captionPreview: vibe.caption || '',
          category: vibe.category,
          storyCount: 1,
          unviewedCount: vibe.isViewed ? 0 : 1,
          isViewed: !!vibe.isViewed,
          createdAt: vibe.createdAt,
          vibes: [vibe]
        });
      } else {
        const item = authorStoriesMap.get(authorId);
        item.storyCount += 1;
        if (!vibe.isViewed) {
          item.unviewedCount += 1;
          item.isViewed = false;
        }
        item.vibes.push(vibe);
      }
    }

    const recentAuthorStories = Array.from(authorStoriesMap.values()).slice(0, 10);

    res.status(200).json({
      success: true,
      data: {
        official: enhancedOfficial,
        achievements: enhancedAchievements,
        stories: recentAuthorStories,
        totalActiveStories: enhancedRecentCampus.length + enhancedOfficial.length + enhancedAchievements.length
      }
    });
  } catch (error) {
    logger.error('Error fetching vibe highlights:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching highlights' });
  }
};

/**
 * POST /api/vibes/views or POST /api/vibes/:id/view
 * Record that user viewed one or more vibes in story format.
 */
exports.recordVibeViews = async (req, res) => {
  try {
    const currentUserId = req.user?.userId;
    if (!currentUserId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    let vibeIds = [];
    if (req.params.id) {
      vibeIds = [req.params.id];
    } else if (Array.isArray(req.body.vibeIds)) {
      vibeIds = req.body.vibeIds;
    } else if (req.body.vibeId) {
      vibeIds = [req.body.vibeId];
    }

    const userObjId = new mongoose.Types.ObjectId(currentUserId);
    const validObjIds = vibeIds
      .filter(id => isValidObjectId(id))
      .map(id => new mongoose.Types.ObjectId(id));

    if (validObjIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Valid vibeId or vibeIds array is required' });
    }

    const operations = validObjIds.map(vibeObjId => ({
      updateOne: {
        filter: { user: userObjId, vibe: vibeObjId },
        update: { $setOnInsert: { user: userObjId, vibe: vibeObjId, viewedAt: new Date() } },
        upsert: true
      }
    }));

    try {
      await VibeView.bulkWrite(operations, { ordered: false });
    } catch (bulkErr) {
      if (bulkErr.code !== 11000 && !bulkErr.writeErrors?.every(e => e.code === 11000)) {
        logger.warn('Non-duplicate bulkWrite error in recordVibeViews:', bulkErr);
      }
    }

    res.status(200).json({ success: true, message: 'Views recorded' });
  } catch (error) {
    logger.error('Error recording vibe views:', error);
    res.status(500).json({ success: false, message: 'Server error while recording views' });
  }
};

/**
 * GET /api/vibes/:id/viewers
 * Get list of users who viewed the story / vibe.
 * Restricted to Super Admin, Admin, or the vibe author.
 */
exports.getVibeViewers = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid vibe ID' });
    }

    const vibe = await Vibe.findById(req.params.id).select('author').lean();
    if (!vibe) {
      return res.status(404).json({ success: false, message: 'Vibe not found' });
    }

    const currentUserId = req.user?.userId;
    const currentUserRole = req.user?.role;
    const isSuperAdminOrAdmin = currentUserRole === 'super admin' || currentUserRole === 'admin';
    const isAuthor = currentUserId && vibe.author && vibe.author.toString() === currentUserId.toString();

    if (!isSuperAdminOrAdmin && !isAuthor) {
      return res.status(403).json({ success: false, message: 'Only admins or the story author can see who viewed this story' });
    }

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const [views, total] = await Promise.all([
      VibeView.find({ vibe: req.params.id })
        .sort({ viewedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({
          path: 'user',
          select: 'name role profilePhoto currentClass designation',
          populate: { path: 'currentClass', select: 'label name section' }
        })
        .lean(),
      VibeView.countDocuments({ vibe: req.params.id })
    ]);

    const viewers = views
      .filter(v => v.user)
      .map(v => ({
        _id: v.user._id,
        name: v.user.name,
        role: v.user.role,
        profilePhoto: v.user.profilePhoto,
        currentClass: v.user.currentClass,
        designation: v.user.designation,
        viewedAt: v.viewedAt || v.createdAt
      }));

    res.status(200).json({
      success: true,
      data: viewers,
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit) || 1,
        hasNextPage: skip + limit < total
      }
    });
  } catch (error) {
    logger.error('Error fetching vibe viewers:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching story viewers' });
  }
};

/**
 * GET /api/vibes/spotlight
 * Returns the top spotlighted/pinned vibe for the Home Page hero banner.
 */
exports.getSpotlightVibe = async (req, res) => {
  try {
    const populateAuthorObj = {
      path: 'author',
      select: 'name role profilePhoto currentClass designation',
      populate: { path: 'currentClass', select: 'label name section' }
    };

    // Strictly fetch vibe explicitly chosen by Admin for spotlight (no automatic fallback leaks)
    const spotlight = await Vibe.findOne({
      status: 'approved',
      isActive: true,
      isSpotlight: true
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .populate(populateAuthorObj)
      .lean();

    let enhancedSpotlight = null;
    if (spotlight) {
      const currentUserId = req.user?.userId;
      let isLiked = false;
      let isBookmarked = false;

      if (currentUserId) {
        const [userLike, userBookmark] = await Promise.all([
          VibeLike.exists({ vibe: spotlight._id, user: currentUserId }),
          VibeBookmark.exists({ vibe: spotlight._id, user: currentUserId })
        ]);
        isLiked = Boolean(userLike);
        isBookmarked = Boolean(userBookmark);
      }

      let sanitizedImages = spotlight.images || [];
      if (Array.isArray(sanitizedImages)) {
        sanitizedImages = sanitizedImages.map(img => {
          if (!img) return img;
          const isVideo = img.type === 'video' || /\.(mp4|mov|webm|m4v|avi|3gp|mkv|flv|wmv|qt)(\?.*)?$/i.test(img.url || '');
          if (isVideo && !img.thumbnailUrl && img.url && img.url.includes('cloudinary.com')) {
            return {
              ...img,
              thumbnailUrl: img.url
                .replace(/\/video\/upload\/(?:[^/]+\/)?/, '/video/upload/so_0,w_720,q_auto,f_auto/')
                .replace(/\.(mp4|mov|webm|m4v|avi|3gp|mkv|flv|wmv|qt)(\?.*)?$/i, '.jpg')
            };
          }
          return img;
        });
      }

      enhancedSpotlight = {
        ...spotlight,
        images: sanitizedImages,
        likesCount: Math.max(0, Number(spotlight.likesCount) || 0),
        commentsCount: Math.max(0, Number(spotlight.commentsCount) || 0),
        isLiked,
        isBookmarked
      };
    }

    res.status(200).json({
      success: true,
      data: enhancedSpotlight
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

    if (!isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid or missing user ID' });
    }

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
        .populate({
          path: 'author',
          select: 'name role profilePhoto currentClass designation',
          populate: { path: 'currentClass', select: 'label name section' }
        })
        .lean(),
      Vibe.countDocuments(query)
    ]);

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

    const enhancedVibes = vibes.map(v => ({
      ...v,
      likesCount: Math.max(0, Number(v.likesCount) || 0),
      commentsCount: Math.max(0, Number(v.commentsCount) || 0),
      isLiked: likedVibeIds.has(v._id.toString()),
      isBookmarked: bookmarkedVibeIds.has(v._id.toString())
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
    logger.error('Error fetching user vibes:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching user vibes' });
  }
};
