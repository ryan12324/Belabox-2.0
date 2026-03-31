'use strict';

const { Router } = require('express');
const { getSettings, updateCredentials } = require('../auth');

const router = Router();

// GET /api/settings — returns current auth configuration (non-sensitive fields only)
// Note: access to this route is already gated by authMiddleware in server.js when
// authentication is enabled; unauthenticated callers receive 401 before reaching here.
router.get('/', (_req, res) => {
  res.json(getSettings());
});

// POST /api/settings — update credentials
router.post('/', (req, res) => {
  const { enabled, username, password, currentPassword } = req.body || {};
  try {
    updateCredentials({ enabled, username, password, currentPassword });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
