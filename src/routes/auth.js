const express = require('express');
const bcrypt = require('bcrypt');
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
    res.status(201).json({ token: accessToken, user });
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
    res.json({
      token: accessToken,
      user: { id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name }
    });
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

    const userRes = await db.query('SELECT id,email,first_name,last_name FROM users WHERE id=$1', [tokenRow.user_id]);
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

module.exports = router;