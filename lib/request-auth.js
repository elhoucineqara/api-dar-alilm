const User = require('../models/User');
const {
  assertAccountCanAuthenticate,
  syncReservedAdminRole,
} = require('./auth-user');
const { verifyToken } = require('./jwt');

function extractTokenFromRequest(req, options = {}) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  if (options.allowQueryToken && typeof req.query.token === 'string' && req.query.token.trim()) {
    return req.query.token.trim();
  }

  return null;
}

function buildAuthUser(user) {
  return {
    userId: user._id.toString(),
    id: user._id.toString(),
    email: user.email,
    role: user.role,
    accountStatus: user.accountStatus || 'active',
  };
}

async function getAuthContextFromToken(token) {
  const decoded = verifyToken(token);
  let user = await User.findById(decoded.userId);

  if (!user) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }

  user = await syncReservedAdminRole(user);
  assertAccountCanAuthenticate(user);

  return {
    decoded,
    user,
    authUser: buildAuthUser(user),
  };
}

async function getOptionalAuthUser(req, options = {}) {
  const token = extractTokenFromRequest(req, options);
  if (!token) {
    return null;
  }

  try {
    const context = await getAuthContextFromToken(token);
    return context.authUser;
  } catch {
    return null;
  }
}

async function requireAuthUser(req, options = {}) {
  const user = await getOptionalAuthUser(req, options);
  if (!user) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }

  return user;
}

module.exports = {
  extractTokenFromRequest,
  getAuthContextFromToken,
  getOptionalAuthUser,
  requireAuthUser,
};
