const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: '7d',
  });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    throw new Error('Invalid or expired token');
  }
}

module.exports = {
  generateToken,
  verifyToken,
};
