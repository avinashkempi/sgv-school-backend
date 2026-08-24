const express = require('express');
const {
  authenticateToken,
  optionalAuthenticateToken,
  requireAdmin
} = require('../middleware/auth');
const {
  listVibes,
  getVibe,
  createVibe,
  updateVibe,
  deleteVibe,
  toggleLike,
  getVibeLikes,
  getVibeComments,
  addVibeComment,
  deleteVibeComment,
  toggleBookmark,
  getMyVibes,
  getMySavedVibes,
  listPendingVibes,
  reviewVibe,
  togglePinVibe
} = require('../controllers/vibeController');

const router = express.Router();

// ── Admin Moderation Endpoints ──
router.get('/admin/pending', authenticateToken, requireAdmin, listPendingVibes);
router.patch('/admin/:id/review', authenticateToken, requireAdmin, reviewVibe);
router.patch('/admin/:id/pin', authenticateToken, requireAdmin, togglePinVibe);

// ── User Specific Endpoints ──
router.get('/user/my-vibes', authenticateToken, getMyVibes);
router.get('/user/saved', authenticateToken, getMySavedVibes);

// ── Public & Authenticated Feed Endpoints ──
router.get('/', optionalAuthenticateToken, listVibes);
router.get('/:id', optionalAuthenticateToken, getVibe);

// ── Vibe Actions ──
router.post('/', authenticateToken, createVibe);
router.put('/:id', authenticateToken, updateVibe);
router.delete('/:id', authenticateToken, deleteVibe);

// ── Interactions: Likes & Comments & Bookmarks ──
router.post('/:id/like', authenticateToken, toggleLike);
router.get('/:id/likes', authenticateToken, getVibeLikes);

router.get('/:id/comments', optionalAuthenticateToken, getVibeComments);
router.post('/:id/comments', authenticateToken, addVibeComment);
router.delete('/comments/:commentId', authenticateToken, deleteVibeComment);

router.post('/:id/bookmark', authenticateToken, toggleBookmark);

module.exports = router;
