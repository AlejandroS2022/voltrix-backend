const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '15m';

function generateAccessToken(payload) {
  const expiresIn = JWT_EXPIRES_IN;
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function generateRefreshToken() {
  return crypto.randomBytes(64).toString('hex'); // 128 chars hex, long random token (not JWT)
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { generateAccessToken, generateRefreshToken, hashToken };