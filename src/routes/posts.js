const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const {
  listPosts,
  getPost,
  createPost,
  updatePost,
  deletePost,
  togglePin
} = require('../controllers/postController');

const router = express.Router();

// Public endpoints
router.get('/', listPosts);
router.get('/:id', getPost);

// Admin-only endpoints
router.post('/', authenticateToken, requireAdmin, createPost);
router.put('/:id', authenticateToken, requireAdmin, updatePost);
router.delete('/:id', authenticateToken, requireAdmin, deletePost);
router.route('/:id/pin')
  .patch(authenticateToken, requireAdmin, togglePin)
  .post(authenticateToken, requireAdmin, togglePin)
  .put(authenticateToken, requireAdmin, togglePin);

module.exports = router;
