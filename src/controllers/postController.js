const Post = require('../models/Post');
const Notification = require('../models/Notification');
const { sendTargetedNotification } = require('../services/notificationService');
const logger = require('../utils/logger');

/**
 * GET /api/posts
 * List posts with optional category filter, pagination, and pinned-first sorting.
 * Public endpoint — no auth required.
 */
exports.listPosts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50); // Cap at 50
    const skip = (page - 1) * limit;
    const { category } = req.query;

    const query = { isActive: true };
    if (category && ['general', 'achievement'].includes(category)) {
      query.category = category;
    }

    const [posts, total] = await Promise.all([
      Post.find(query)
        .sort({ isPinned: -1, createdAt: -1 }) // Pinned first, then newest
        .skip(skip)
        .limit(limit)
        .populate('postedBy', 'name role profilePhoto')
        .lean(),
      Post.countDocuments(query)
    ]);

    res.status(200).json({
      success: true,
      data: posts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: skip + posts.length < total
      }
    });
  } catch (error) {
    logger.error('Error listing posts:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching posts' });
  }
};

/**
 * GET /api/posts/:id
 * Get a single post by ID.
 */
exports.getPost = async (req, res) => {
  try {
    const post = await Post.findOne({ _id: req.params.id, isActive: true })
      .populate('postedBy', 'name role profilePhoto')
      .lean();

    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    res.status(200).json({ success: true, data: post });
  } catch (error) {
    logger.error('Error fetching post:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching post' });
  }
};

/**
 * POST /api/posts
 * Create a new post. Admin only.
 * Sends push notification for achievement posts.
 */
exports.createPost = async (req, res) => {
  try {
    const { title, description, category, imageUrls } = req.body;

    if (!title || !category) {
      return res.status(400).json({ success: false, message: 'Title and category are required' });
    }

    if (!['general', 'achievement'].includes(category)) {
      return res.status(400).json({ success: false, message: 'Category must be "general" or "achievement"' });
    }

    if (imageUrls && !Array.isArray(imageUrls)) {
      return res.status(400).json({ success: false, message: 'imageUrls must be an array' });
    }

    // Limit to 5 images per post for performance
    const trimmedUrls = (imageUrls || []).filter(Boolean).slice(0, 5);

    const post = new Post({
      title: title.trim(),
      description: description ? description.trim() : '',
      category,
      imageUrls: trimmedUrls,
      postedBy: req.user.userId
    });

    await post.save();

    // Populate postedBy for the response
    await post.populate('postedBy', 'name role');

    // Send push notification for achievement posts only
    if (category === 'achievement') {
      try {
        const notif = new Notification({
          title: '🏆 New Achievement!',
          message: title,
          type: 'General',
          category: 'announcement',
          priority: 'medium',
          targetRole: 'all',
          sendToPublic: true,
          actionType: 'navigate',
          actionData: { screen: 'home', tab: 'achievement' }
        });
        await notif.save();

        // Fire-and-forget push notification to all users
        sendTargetedNotification('all', null, {
          title: '🏆 New Achievement!',
          body: title,
          category: 'announcement',
          priority: 'medium'
        }, true).catch(err => logger.warn('Push notification failed for achievement post:', err));
      } catch (notifErr) {
        // Don't fail the post creation if notification fails
        logger.warn('Failed to send achievement notification:', notifErr);
      }
    }

    res.status(201).json({
      success: true,
      data: post.toObject(),
      message: 'Post created successfully'
    });
  } catch (error) {
    logger.error('Error creating post:', error);
    res.status(500).json({ success: false, message: 'Server error while creating post' });
  }
};

/**
 * PUT /api/posts/:id
 * Update a post. Admin only.
 */
exports.updatePost = async (req, res) => {
  try {
    const { title, description, category, imageUrls } = req.body;

    const post = await Post.findOne({ _id: req.params.id, isActive: true });
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    if (title !== undefined) post.title = title.trim();
    if (description !== undefined) post.description = description.trim();
    if (category !== undefined) {
      if (!['general', 'achievement'].includes(category)) {
        return res.status(400).json({ success: false, message: 'Invalid category' });
      }
      post.category = category;
    }
    if (imageUrls !== undefined) {
      if (!Array.isArray(imageUrls)) {
        return res.status(400).json({ success: false, message: 'imageUrls must be an array' });
      }
      post.imageUrls = imageUrls.filter(Boolean).slice(0, 5);
    }

    await post.save();
    await post.populate('postedBy', 'name role');

    res.status(200).json({
      success: true,
      data: post.toObject(),
      message: 'Post updated successfully'
    });
  } catch (error) {
    logger.error('Error updating post:', error);
    res.status(500).json({ success: false, message: 'Server error while updating post' });
  }
};

/**
 * DELETE /api/posts/:id
 * Soft-delete a post. Admin only.
 */
exports.deletePost = async (req, res) => {
  try {
    const post = await Post.findOne({ _id: req.params.id, isActive: true });
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    post.isActive = false;
    await post.save();

    res.status(200).json({ success: true, message: 'Post deleted successfully' });
  } catch (error) {
    logger.error('Error deleting post:', error);
    res.status(500).json({ success: false, message: 'Server error while deleting post' });
  }
};

/**
 * PATCH /api/posts/:id/pin
 * Toggle pin status. Admin only.
 */
exports.togglePin = async (req, res) => {
  try {
    const post = await Post.findOne({ _id: req.params.id, isActive: true });
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    post.isPinned = !post.isPinned;
    await post.save();

    res.status(200).json({
      success: true,
      data: { isPinned: post.isPinned },
      message: post.isPinned ? 'Post pinned' : 'Post unpinned'
    });
  } catch (error) {
    logger.error('Error toggling pin:', error);
    res.status(500).json({ success: false, message: 'Server error while toggling pin' });
  }
};
