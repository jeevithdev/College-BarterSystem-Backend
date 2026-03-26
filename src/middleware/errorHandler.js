/**
 * Global error handler middleware.
 * Must be registered AFTER all routes.
 */
const errorHandler = (err, req, res, next) => {
  // Log the error
  console.error(`[ERROR] ${req.method} ${req.originalUrl}:`, err.message);
  if (process.env.NODE_ENV !== "production") {
    console.error(err.stack);
  }

  // Mongoose validation error
  if (err.name === "ValidationError") {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({
      message: "Validation Error",
      errors: messages,
    });
  }

  // Mongoose cast error (invalid ObjectId)
  if (err.name === "CastError") {
    return res.status(400).json({
      message: `Invalid ${err.path}: ${err.value}`,
    });
  }

  // Mongoose duplicate key error
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    return res.status(409).json({
      message: `Duplicate value for ${field}`,
    });
  }

  // JWT errors
  if (err.name === "JsonWebTokenError") {
    return res.status(401).json({ message: "Invalid token" });
  }
  if (err.name === "TokenExpiredError") {
    return res.status(401).json({ message: "Token expired" });
  }

  // Default server error
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    message: err.message || "Internal Server Error",
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
};

module.exports = errorHandler;
