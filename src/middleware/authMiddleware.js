const { verifyAccessToken, extractTokenFromHeader } = require("../utils/jwtService");

module.exports = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: "No authorization header provided" });
  }

  const token = extractTokenFromHeader(authHeader);
  if (!token) {
    return res.status(401).json({ message: "Invalid authorization header format" });
  }

  try {
    const decoded = verifyAccessToken(token);

    // Attach user info to request
    req.user = {
      id: decoded.id,
      email: decoded.email,
      name: decoded.name,
      roles: decoded.roles || [],
      iat: decoded.iat,
      exp: decoded.exp,
    };

    next();
  } catch (error) {
    console.warn(`Auth middleware error: ${error.message} for token: ${token.substring(0, 20)}...`);

    if (error.message.includes("expired")) {
      return res.status(401).json({
        message: "Access token has expired",
        code: "TOKEN_EXPIRED"
      });
    }

    return res.status(401).json({
      message: "Invalid access token",
      code: "INVALID_TOKEN"
    });
  }
};
