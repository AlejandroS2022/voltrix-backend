const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { validateRegister, validateLogin } = require('../middleware/validate');

const router = express.Router();

const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10);
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

router.post('/register', validateRegister, async (req, res) => {
  try {
    const { first_name, last_name, email, password } = req.body;
    if (!first_name || !last_name || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const db = getDb();
    const userCheck = await db.query('SELECT id FROM users WHERE email=$1', [email]);
    if (userCheck.rows.length) return res.status(400).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await db.query(
      `INSERT INTO users (first_name, last_name, email, password_hash, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, first_name, last_name, email`,
      [first_name, last_name, email, hash]
    );
    const user = result.rows[0];

    await db.query('INSERT INTO wallets (user_id, balance_cents) VALUES ($1, 0)', [user.id]);

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.status(201).json({ token, user });
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
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  const db = getDb();
  const user = await db.query(
    `SELECT id, email, first_name, last_name FROM users WHERE id=$1`,
    [req.user.userId]
  );
  res.json(user.rows[0]);
});

module.exports = router;
