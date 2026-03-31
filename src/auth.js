'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'settings.json');

// ── Session store ─────────────────────────────────────────────────────────────

/** Map<token, { username, loginTime }> */
const sessions = new Map();

// ── Credentials (loaded from file or defaults) ────────────────────────────────

let credentials = {
  enabled: false,
  username: 'admin',
  /** bcrypt-style? No – keep it simple: store hashed with SHA-256 + salt */
  passwordHash: '', // empty = no password set yet
  salt: '',
};

function _loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.auth) credentials = { ...credentials, ...data.auth };
  } catch (_) {
    // File doesn't exist yet — use defaults
  }
}

function _saveSettings() {
  try {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (_) {}
    existing.auth = credentials;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(existing, null, 2), 'utf8');
  } catch (err) {
    console.error('[Auth] Failed to save settings:', err.message);
  }
}

_loadSettings();

// ── Crypto helpers ────────────────────────────────────────────────────────────

function _hashPassword(password, salt) {
  // scrypt is a memory-hard KDF suitable for password storage
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function _generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function _generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// ── Public API ────────────────────────────────────────────────────────────────

function login(username, password) {
  // If auth is disabled, authentication is not required — return a no-op token
  // that isAuthenticated will ignore (since it also short-circuits on disabled auth).
  if (!credentials.enabled) return _generateToken();

  if (username !== credentials.username) return null;

  // If no password has been set yet, any password is accepted (first-run)
  let valid;
  if (!credentials.passwordHash) {
    valid = true;
  } else {
    valid = _hashPassword(password, credentials.salt) === credentials.passwordHash;
  }

  if (!valid) return null;

  const token = _generateToken();
  sessions.set(token, { username, loginTime: Date.now() });
  return token;
}

function logout(token) {
  sessions.delete(token);
}

function isAuthenticated(token) {
  if (!credentials.enabled) return true;
  return sessions.has(token);
}

function getCookieToken(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)belabox_token=([^;]+)/);
  return match ? match[1] : null;
}

function getSettings() {
  return {
    enabled: credentials.enabled,
    username: credentials.username,
    hasPassword: !!credentials.passwordHash,
  };
}

function updateCredentials({ enabled, username, password, currentPassword }) {
  // If auth is currently enabled and a password is set, verify currentPassword
  if (credentials.enabled && credentials.passwordHash) {
    if (!currentPassword) throw new Error('Current password is required to change credentials');
    const hash = _hashPassword(currentPassword, credentials.salt);
    if (hash !== credentials.passwordHash) throw new Error('Current password is incorrect');
  }

  // When enabling auth, a password must be provided (prevent lockout-free enabling)
  if (enabled && !credentials.passwordHash && (!password || !password.trim())) {
    throw new Error('A password is required to enable authentication');
  }

  if (enabled !== undefined) credentials.enabled = !!enabled;
  if (username !== undefined && username.trim()) credentials.username = username.trim();

  if (password !== undefined && password !== '') {
    const salt = _generateSalt();
    credentials.salt = salt;
    credentials.passwordHash = _hashPassword(password, salt);
  }

  _saveSettings();
}

// ── Express middleware ────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const pathname = req.path;

  // Allow access to login page and auth API regardless of auth state
  if (
    pathname === '/login' ||
    pathname === '/login.html' ||
    pathname.startsWith('/api/auth/')
  ) {
    return next();
  }

  // If auth is not enabled, let everything through
  if (!credentials.enabled) return next();

  const token = getCookieToken(req);
  if (isAuthenticated(token)) return next();

  // API / WebSocket upgrade → 401 JSON
  if (pathname.startsWith('/api') || req.headers.upgrade === 'websocket') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Page request → redirect to login
  res.redirect('/login');
}

module.exports = {
  login,
  logout,
  isAuthenticated,
  getCookieToken,
  getSettings,
  updateCredentials,
  authMiddleware,
};
