const { requireAuthUser } = require('../lib/request-auth');

// Middleware to authenticate token
const authenticateToken = async (req, res, next) => {
  try {
    req.user = await requireAuthUser(req);
    next();
  } catch (error) {
    const statusCode = error.statusCode || 401;
    return res.status(statusCode).json({ 
      success: false,
      message: statusCode === 403 ? error.message : 'Unauthorized - Invalid token',
      error: error.message 
    });
  }
};

// Middleware to authorize specific roles
const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        success: false,
        message: 'Unauthorized - Please login first' 
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        success: false,
        message: `Forbidden - Access restricted to: ${roles.join(', ')}` 
      });
    }

    next();
  };
};

module.exports = {
  authenticateToken,
  authorizeRoles,
};

