const jwt = require("jsonwebtoken");
require("dotenv").config();

// Optional authentication - doesn't fail if no token provided
// Useful for routes that work better with auth but don't require it
module.exports = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    // No token provided, continue without user
    req.user = null;
    return next();
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRETKEY);
    req.user = decoded;
    next();
  } catch (err) {
    // Invalid token, continue without user
    req.user = null;
    next();
  }
};
