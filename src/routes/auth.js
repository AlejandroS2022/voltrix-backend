const express = require('express');
const bcrypt = require('bcrypt');
const axios = require('axios');
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db');
const { validateRegister, validateLogin } = require('../middleware/validate');
const { generateAccessToken, generateRefreshToken, hashToken } = require('../utils/tokens');

const router = express.Router();
const NODE_ENV = process.env.NODE_ENV;
const REFRESH_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_DAYS || '30', 10);
const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10);

function setRefreshCookie(res, token, maxAgeSeconds) {
  const cookieOptions = {
    httpOnly: true,
    secure: NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: maxAgeSeconds * 1000,
    path: '/api/auth',
  };
  res.cookie('refresh_token', token, cookieOptions);
}

router.post('/register', validateRegister, async (req, res) => {
  try {
    const { email, password, first_name, last_name } = req.body;
    if (!first_name || !last_name || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const db = getDb();
    const exists = await db.query('SELECT id FROM users WHERE email=$1', [email]);
    if (exists.rowCount) return res.status(400).json({ error: 'Email already registered' });

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await db.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, email, first_name, last_name`,
      [email, password_hash, first_name, last_name]
    );
    const user = result.rows[0];

    // create wallet and other assets if not existing
    await db.query('INSERT INTO wallets (user_id, balance_cents) VALUES ($1, 0) ON CONFLICT DO NOTHING', [user.id]);

    // generate tokens
    const accessToken = generateAccessToken({ userId: user.id, email: user.email });
    const rawRefresh = generateRefreshToken();
    const refreshHash = hashToken(rawRefresh);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 3600 * 1000);

    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at) VALUES ($1,$2,$3,$4,$5)`,
      [user.id, refreshHash, req.get('User-Agent') || null, req.ip || null, expiresAt]
    );

    setRefreshCookie(res, rawRefresh, REFRESH_TTL_DAYS * 24 * 3600);
    // include is_admin flag when returning user
    const uQ = await db.query('SELECT id,email,first_name,last_name,is_admin FROM users WHERE id=$1', [user.id]);
    const fullUser = uQ.rows[0];
    res.status(201).json({ token: accessToken, user: fullUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', validateLogin, async (req, res) => {
  try {
    const { email, password } = req.body;
    const db = getDb();
    const result = await db.query('SELECT * FROM users WHERE email=$1', [email]);
    if (result.rowCount === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const accessToken = generateAccessToken({ userId: user.id, email: user.email });
    const rawRefresh = generateRefreshToken();
    const refreshHash = hashToken(rawRefresh);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 3600 * 1000);

    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at) VALUES ($1,$2,$3,$4,$5)`,
      [user.id, refreshHash, req.get('User-Agent') || null, req.ip || null, expiresAt]
    );

    setRefreshCookie(res, rawRefresh, REFRESH_TTL_DAYS * 24 * 3600);
    // include is_admin flag in login response
    const uQ = await db.query('SELECT id,email,first_name,last_name,is_admin FROM users WHERE id=$1', [user.id]);
    res.json({ token: accessToken, user: uQ.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const rawRefresh = req.cookies?.refresh_token;
    if (!rawRefresh) return res.status(401).json({ error: 'Missing refresh token' });

    const db = getDb();
    const refreshHash = hashToken(rawRefresh);
    const q = await db.query('SELECT * FROM refresh_tokens WHERE token_hash=$1', [refreshHash]);
    if (q.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    const tokenRow = q.rows[0];
    if (tokenRow.revoked || new Date(tokenRow.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Refresh token expired or revoked' });
    }

    // rotate: revoke old and insert new one
    await db.query('UPDATE refresh_tokens SET revoked=true WHERE id=$1', [tokenRow.id]);
    const newRaw = generateRefreshToken();
    const newHash = hashToken(newRaw);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 3600 * 1000);
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at) VALUES ($1,$2,$3,$4,$5)`,
      [tokenRow.user_id, newHash, req.get('User-Agent') || null, req.ip || null, expiresAt]
    );

    const userRes = await db.query('SELECT id,email,first_name,last_name,is_admin FROM users WHERE id=$1', [tokenRow.user_id]);
    const user = userRes.rows[0];
    const accessToken = generateAccessToken({ userId: user.id, email: user.email });

    setRefreshCookie(res, newRaw, REFRESH_TTL_DAYS * 24 * 3600);
    res.json({ token: accessToken, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Refresh failed' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const rawRefresh = req.cookies?.refresh_token;
    if (rawRefresh) {
      const db = getDb();
      const h = hashToken(rawRefresh);
      await db.query('UPDATE refresh_tokens SET revoked=true WHERE token_hash=$1', [h]);
    }

    // clear cookie
    res.clearCookie('refresh_token', { path: '/api/auth' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// OAuth2 quick-start endpoints (redirects). These are optional helpers —
// to enable fully working social login configure the provider client IDs/secrets
// in env and implement the callback exchange. For now these routes redirect
// to the provider consent URL when CLIENT_ID is present, otherwise return 501.

router.get('/oauth/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_OAUTH_CALLBACK;
  if (!clientId || !redirectUri) return res.status(501).json({ error: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_OAUTH_CALLBACK.' });
  const scope = encodeURIComponent('openid email profile');
  const state = encodeURIComponent(req.query.state || '/');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&state=${state}`;
  res.redirect(url);
});

// helper: build a full frontend redirect URL and optionally append query params like error/provider
function buildFrontendUrl(statePath) {
  const frontend = process.env.FRONTEND_URL || '/';
  const base = frontend.startsWith('http') ? frontend : `http://${frontend}`; // allow env with or without protocol
  const path = statePath && statePath.startsWith('/') ? statePath : `/${statePath || ''}`;
  // normalize: avoid double slashes
  return `${base.replace(/\/$/, '')}${path}`;
}

function redirectWithError(res, state, errKey, provider) {
  try {
    const url = new URL(buildFrontendUrl(state));
    if (errKey) url.searchParams.set('oauth_error', errKey);
    if (provider) url.searchParams.set('oauth_provider', provider);
    return res.redirect(302, url.toString());
  } catch (e) {
    // fallback: simple redirect
    const fallback = buildFrontendUrl(state) + `?oauth_error=${encodeURIComponent(errKey || 'unknown')}&oauth_provider=${encodeURIComponent(provider || '')}`;
    return res.redirect(302, fallback);
  }
}

router.get('/oauth/google/callback', async (req, res) => {
  const code = req.query.code;
  const state = decodeURIComponent(req.query.state || '/');
  // user cancelled or provider-specific error
  if (req.query.error) return redirectWithError(res, state, req.query.error, 'google');
  if (!code) return redirectWithError(res, state, 'missing_code', 'google');
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_CALLBACK;
  if (!clientId || !clientSecret || !redirectUri) return redirectWithError(res, state, 'not_configured', 'google');

  try {
    // Exchange code for tokens
    const params = new URLSearchParams();
    params.append('code', code);
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
    params.append('redirect_uri', redirectUri);
    params.append('grant_type', 'authorization_code');

    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (tokenRes.status !== 200 || tokenRes.data.error) {
      console.error('google token exchange failed', tokenRes.status, tokenRes.data);
      return redirectWithError(res, state, tokenRes.data.error_description || 'token_exchange_failed', 'google');
    }
    const accessToken = tokenRes.data.access_token;
    if (!accessToken) return redirectWithError(res, state, 'token_missing', 'google');

    // Fetch user info
    let userRes;
    try {
      userRes = await axios.get(`https://www.googleapis.com/oauth2/v2/userinfo?access_token=${accessToken}`);
    } catch (uerr) {
      console.error('google userinfo fetch failed', uerr && uerr.response ? uerr.response.data : uerr.message || uerr);
      return redirectWithError(res, state, 'userinfo_failed', 'google');
    }
    const profile = userRes.data || {};
    if (!profile.email) return redirectWithError(res, state, 'email_required', 'google');

    const db = getDb();
    let user;
    const existing = await db.query('SELECT id,email,first_name,last_name FROM users WHERE email=$1', [profile.email]);
    if (existing.rowCount) {
      user = existing.rows[0];
      // optionally update names
      await db.query('UPDATE users SET first_name=$1, last_name=$2 WHERE id=$3', [profile.given_name || user.first_name, profile.family_name || user.last_name, user.id]);
    } else {
      // social signup: DB requires password_hash NOT NULL, create a dummy hashed password
      const dummyPassword = generateRefreshToken();
      const dummyHash = await bcrypt.hash(dummyPassword, SALT_ROUNDS);
      const r = await db.query(
        `INSERT INTO users (email, first_name, last_name, password_hash, created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING id,email,first_name,last_name,is_admin`,
        [profile.email, profile.given_name || '', profile.family_name || '', dummyHash]
      );
      user = r.rows[0];
      await db.query('INSERT INTO wallets (user_id, balance_cents) VALUES ($1,0) ON CONFLICT DO NOTHING', [user.id]);
    }

    // create tokens (rotate refresh token logic similar to login)
    const accessTokenLocal = generateAccessToken({ userId: user.id, email: user.email });
    const rawRefresh = generateRefreshToken();
    const refreshHash = hashToken(rawRefresh);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 3600 * 1000);
    await db.query(`INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at) VALUES ($1,$2,$3,$4,$5)`, [user.id, refreshHash, req.get('User-Agent') || null, req.ip || null, expiresAt]);
    setRefreshCookie(res, rawRefresh, REFRESH_TTL_DAYS * 24 * 3600);

    // Redirect back to frontend (state) — frontend should call /api/auth/refresh to get access token
    return res.redirect(302, buildFrontendUrl(state));
  } catch (err) {
    console.error('google oauth callback error', err && err.response ? err.response.data : err.message || err);
    return redirectWithError(res, state, 'google_oauth_failed', 'google');
  }
});

router.get('/oauth/facebook', (req, res) => {
  const clientId = process.env.FACEBOOK_CLIENT_ID;
  const redirectUri = process.env.FACEBOOK_OAUTH_CALLBACK;
  if (!clientId || !redirectUri) return res.status(501).json({ error: 'Facebook OAuth not configured. Set FACEBOOK_CLIENT_ID and FACEBOOK_OAUTH_CALLBACK.' });
  const scope = encodeURIComponent('email public_profile');
  const state = encodeURIComponent(req.query.state || '/');
  const url = `https://www.facebook.com/v16.0/dialog/oauth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=${scope}`;
  res.redirect(url);
});

router.get('/oauth/facebook/callback', async (req, res) => {
  const code = req.query.code;
  const state = decodeURIComponent(req.query.state || '/');
  if (req.query.error) return redirectWithError(res, state, req.query.error, 'facebook');
  if (!code) return redirectWithError(res, state, 'missing_code', 'facebook');
  const clientId = process.env.FACEBOOK_CLIENT_ID;
  const clientSecret = process.env.FACEBOOK_CLIENT_SECRET;
  const redirectUri = process.env.FACEBOOK_OAUTH_CALLBACK;
  if (!clientId || !clientSecret || !redirectUri) return redirectWithError(res, state, 'not_configured', 'facebook');

  try {
    // Exchange code for access token
    const tokenUrl = `https://graph.facebook.com/v16.0/oauth/access_token?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${encodeURIComponent(clientSecret)}&code=${encodeURIComponent(code)}`;
    const tokenRes = await axios.get(tokenUrl);
    if (tokenRes.status !== 200 || tokenRes.data.error) {
      console.error('facebook token exchange failed', tokenRes.status, tokenRes.data);
      return redirectWithError(res, state, tokenRes.data.error?.message || 'token_exchange_failed', 'facebook');
    }
    const accessToken = tokenRes.data.access_token;
    if (!accessToken) return redirectWithError(res, state, 'token_missing', 'facebook');

    // Fetch profile
    let profileRes;
    try {
      const profileUrl = `https://graph.facebook.com/me?fields=id,email,first_name,last_name&access_token=${encodeURIComponent(accessToken)}`;
      profileRes = await axios.get(profileUrl);
    } catch (uerr) {
      console.error('facebook userinfo fetch failed', uerr && uerr.response ? uerr.response.data : uerr.message || uerr);
      return redirectWithError(res, state, 'userinfo_failed', 'facebook');
    }
    const profile = profileRes.data || {};
    if (!profile.email) return redirectWithError(res, state, 'email_required', 'facebook');

    const db = getDb();
    let user;
    const existing = await db.query('SELECT id,email,first_name,last_name FROM users WHERE email=$1', [profile.email]);
    if (existing.rowCount) {
      user = existing.rows[0];
      await db.query('UPDATE users SET first_name=$1, last_name=$2 WHERE id=$3', [profile.first_name || user.first_name, profile.last_name || user.last_name, user.id]);
    } else {
      // social signup: DB requires password_hash NOT NULL, create a dummy hashed password
      const dummyPassword = generateRefreshToken();
      const dummyHash = await bcrypt.hash(dummyPassword, SALT_ROUNDS);
      const r = await db.query(
        `INSERT INTO users (email, first_name, last_name, password_hash, created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING id,email,first_name,last_name`,
        [profile.email, profile.first_name || '', profile.last_name || '', dummyHash]
      );
      user = r.rows[0];
      await db.query('INSERT INTO wallets (user_id, balance_cents) VALUES ($1,0) ON CONFLICT DO NOTHING', [user.id]);
    }

    // create tokens
    const accessTokenLocal = generateAccessToken({ userId: user.id, email: user.email });
    const rawRefresh = generateRefreshToken();
    const refreshHash = hashToken(rawRefresh);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 3600 * 1000);
    await db.query(`INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at) VALUES ($1,$2,$3,$4,$5)`, [user.id, refreshHash, req.get('User-Agent') || null, req.ip || null, expiresAt]);
    setRefreshCookie(res, rawRefresh, REFRESH_TTL_DAYS * 24 * 3600);

    return res.redirect(302, buildFrontendUrl(state));
  } catch (err) {
    console.error('facebook oauth callback error', err && err.response ? err.response.data : err.message || err);
    return redirectWithError(res, state, 'facebook_oauth_failed', 'facebook');
  }
});

// Update basic profile fields (first_name, last_name)
router.post('/profile', requireAuth, async (req, res) => {
  try {
    const { first_name, last_name } = req.body;
    if (!first_name && !last_name) return res.status(400).json({ error: 'Nothing to update' });
    const db = getDb();
    await db.query('UPDATE users SET first_name = COALESCE($1, first_name), last_name = COALESCE($2, last_name) WHERE id=$3', [first_name || null, last_name || null, req.user.userId]);
    const uQ = await db.query('SELECT id,email,first_name,last_name,is_admin FROM users WHERE id=$1', [req.user.userId]);
    res.json({ ok: true, user: uQ.rows[0] });
  } catch (err) {
    console.error('profile update failed', err);
    res.status(500).json({ error: 'profile_update_failed' });
  }
});

module.exports = router;
