// Authentication routes - Google OAuth

const express = require('express');
const router = express.Router();
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const fs = require('fs');
const path = require('path');

// Allowed email domain
const ALLOWED_DOMAIN = 'hemlockandoak.com';

// Configure Passport
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

// Google OAuth Strategy
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback'
  },
  (accessToken, refreshToken, profile, done) => {
    // Extract email from profile
    const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;

    if (!email) {
      return done(null, false, { message: 'No email found in Google profile' });
    }

    // Check if email is from allowed domain
    const emailDomain = email.split('@')[1];
    if (emailDomain !== ALLOWED_DOMAIN) {
      return done(null, false, { message: `Only @${ALLOWED_DOMAIN} emails are allowed` });
    }

    // Create user object
    const user = {
      id: profile.id,
      email: email,
      name: profile.displayName,
      picture: profile.photos && profile.photos[0] ? profile.photos[0].value : null
    };

    return done(null, user);
  }
));

// Initialize passport middleware
router.use(passport.initialize());
router.use(passport.session());

// Load HTML templates
const loginHTML = fs.readFileSync(path.join(__dirname, '../views/login.html'), 'utf8');

// Login page
router.get('/login', (req, res) => {
  // Check if already logged in
  if (req.session.userId) {
    return res.redirect('/');
  }

  // Pass error message if any
  const error = req.query.error;
  let html = loginHTML;
  if (error) {
    html = html.replace('<!--ERROR_MESSAGE-->', `<div class="error" style="display:block">${decodeURIComponent(error)}</div>`);
  }
  res.send(html);
});

// Initiate Google OAuth flow
router.get('/auth/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account' // Always show account selector
  })
);

// Google OAuth callback
router.get('/auth/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/login?error=' + encodeURIComponent('Authentication failed. Only @hemlockandoak.com emails are allowed.')
  }),
  (req, res) => {
    // Successful authentication
    req.session.userId = req.user.id;
    req.session.userEmail = req.user.email;
    req.session.userName = req.user.name;
    req.session.userPicture = req.user.picture;

    res.redirect('/');
  }
);

// Logout
router.get('/logout', (req, res) => {
  req.logout((err) => {
    req.session.destroy(() => {
      res.redirect('/login');
    });
  });
});

// API endpoint to get current user info
router.get('/api/auth/user', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({
    id: req.session.userId,
    email: req.session.userEmail,
    name: req.session.userName,
    picture: req.session.userPicture
  });
});

module.exports = router;
