const express = require('express');
const router = express.Router();
const spotify = require('../services/spotify');

// Auth middleware check helper
function authMiddleware(req, res, next) {
  const enableAuth = process.env.ENABLE_AUTH === 'true';
  if (!enableAuth) {
    return next();
  }
  if (req.session && req.session.authenticated) {
    return next();
  }
  return res.redirect('/login');
}

// GET Main App
router.get('/', authMiddleware, (req, res) => {
  res.render('index', {
    spotifyConfigured: spotify.isConfigured(),
    enableAuth: process.env.ENABLE_AUTH === 'true'
  });
});

// GET Login Page
router.get('/login', (req, res) => {
  if (process.env.ENABLE_AUTH !== 'true') {
    return res.redirect('/');
  }
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }
  res.render('login', { error: null });
});

// POST Login Action
router.post('/login', (req, res) => {
  if (process.env.ENABLE_AUTH !== 'true') {
    return res.redirect('/');
  }
  const { username, password } = req.body || {};
  const expectedPassword = process.env.AUTH_PASSWORD || 'admin';

  if (password === expectedPassword) {
    req.session.authenticated = true;
    return res.redirect('/');
  }

  return res.render('login', { error: 'Invalid credentials' });
});

// GET Logout Action
router.get('/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(() => {
      res.redirect('/login');
    });
  } else {
    res.redirect('/login');
  }
});

module.exports = router;
