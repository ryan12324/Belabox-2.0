'use strict';

const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const { login, logout, getCookieToken, getSettings } = require('../auth');

const router = Router();

// Rate-limit the login endpoint: max 10 attempts per IP per 15 minutes
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

// POST /api/auth/login
router.post('/login', loginRateLimit, (req, res) => {
  const { username, password } = req.body || {};
  const token = login(username || '', password || '');
  if (!token) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  // Set HttpOnly cookie valid for 30 days
  const maxAge = 30 * 24 * 60 * 60; // seconds
  res.setHeader(
    'Set-Cookie',
    `belabox_token=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict`
  );
  res.json({ ok: true });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  const token = getCookieToken(req);
  if (token) logout(token);
  res.setHeader(
    'Set-Cookie',
    'belabox_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict'
  );
  res.json({ ok: true });
});

// GET /api/auth/status
router.get('/status', (_req, res) => {
  res.json(getSettings());
});

module.exports = router;
