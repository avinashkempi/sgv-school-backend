const express = require('express');
const {
  authenticateToken,
  optionalAuthenticateToken,
  requireAdmin
} = require('../middleware/auth');
const {
  listVibes,
  getVibe,
  getCategories,
  createVibe,
  updateVibe,
  deleteVibe,
  toggleLike,
  getVibeLikes,
  getVibeComments,
  addVibeComment,
  deleteVibeComment,
  toggleCommentLike,
  toggleBookmark,
  getMyVibes,
  getMySavedVibes,
  listPendingVibes,
  reviewVibe,
  batchReviewVibes,
  togglePinVibe,
  toggleSpotlightVibe,
  getVibeHighlights,
  getSpotlightVibe,
  getUserVibes,
  recordVibeViews
} = require('../controllers/vibeController');

const router = express.Router();

// ── Categories ──
router.get('/categories', optionalAuthenticateToken, getCategories);

// ── Highlights & Spotlight (Public / Authenticated) ──
router.get('/highlights', optionalAuthenticateToken, getVibeHighlights);
router.get('/spotlight', optionalAuthenticateToken, getSpotlightVibe);

// ── Story Views Recording ──
router.post('/views', authenticateToken, recordVibeViews);
router.post('/:id/view', authenticateToken, recordVibeViews);

// ── Admin Moderation Endpoints ──
router.get('/admin/pending', authenticateToken, requireAdmin, listPendingVibes);
router.post('/admin/batch-review', authenticateToken, requireAdmin, batchReviewVibes);
router.patch('/admin/:id/review', authenticateToken, requireAdmin, reviewVibe);
router.patch('/admin/:id/pin', authenticateToken, requireAdmin, togglePinVibe);
router.patch('/admin/:id/spotlight', authenticateToken, requireAdmin, toggleSpotlightVibe);

// ── User Specific Endpoints ──
router.get('/user/my-vibes', authenticateToken, getMyVibes);
router.get('/user/saved', authenticateToken, getMySavedVibes);
router.get('/user/:userId', optionalAuthenticateToken, getUserVibes);

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
router.post('/comments/:commentId/like', authenticateToken, toggleCommentLike);

router.post('/:id/bookmark', authenticateToken, toggleBookmark);

module.exports = router;
