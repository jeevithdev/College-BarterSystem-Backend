require("dotenv").config(); // MUST be first — before any module reads process.env

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const errorHandler = require("./middleware/errorHandler");

// Initialize Redis connection (for rate limiting and sessions)
const { createRedisConnection } = require("./config/redis");
const redisClient = createRedisConnection();

const authRoutes = require("./routes/auth");
const twoFactorRoutes = require("./routes/twoFactorRoutes");
const itemRoutes = require("./routes/itemRoutes");
const tradeRoutes = require("./routes/tradeRoutes");
const conversationRoutes = require("./routes/conversationRoutes");

const app = express();

// ─── Trust Proxy Settings ─────────────────────────────────────────────
// Important for getting correct IP addresses behind reverse proxy
app.set("trust proxy", 1);

// ─── Enhanced Security Middleware ─────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow cross-origin requests for API
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
}));

// ─── Body Parsing with Reduced Size Limits ───────────────────────────────
// Reduced from 10MB to 1MB for DoS protection
const maxJsonSize = process.env.MAX_JSON_SIZE || "1mb";
app.use(express.json({
  limit: maxJsonSize,
  verify: (req, res, buf) => {
    // Store raw body for signature verification if needed
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({
  extended: true,
  limit: maxJsonSize,
  parameterLimit: 100, // Limit number of parameters
}));

// ─── Enhanced CORS Configuration ──────────────────────────────────────────
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : [
      "http://localhost:5173",
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "http://localhost:5000",
      "http://127.0.0.1:5000",
    ];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked origin: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
  maxAge: 86400, // 24 hours
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Origin",
    "X-Requested-With",
    "Content-Type",
    "Accept",
    "Authorization",
    "X-Request-ID",
  ],
};
app.use(cors(corsOptions));

// ─── Security Headers ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  // Remove server information for security
  res.removeHeader("X-Powered-By");

  // Add custom security headers
  res.setHeader("X-Request-ID", req.headers["x-request-id"] || require("crypto").randomUUID());
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // Cache control for API responses
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
  }

  next();
});

// ─── Socket.IO Injection ─────────────────────────────────────────────────
// `setIO` is called from server.js after socket.io initializes.
// Because this middleware runs per-request (not at registration time),
// ioInstance will already be set before any HTTP request arrives.
let ioInstance = null;

app.use((req, res, next) => {
  req.io = ioInstance;
  next();
});

const setIO = (io) => {
  ioInstance = io;
};

// ─── Enhanced Health Check ────────────────────────────────────────────────
app.get("/health", async (req, res) => {
  const healthCheck = {
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    version: process.env.npm_package_version || "unknown",
    services: {
      redis: "unknown",
      mongodb: "connected", // Assume connected if we reach this point
    }
  };

  // Check Redis health
  try {
    const { isRedisHealthy } = require("./config/redis");
    healthCheck.services.redis = await isRedisHealthy() ? "connected" : "disconnected";
  } catch (error) {
    healthCheck.services.redis = "error";
  }

  // Return 503 if any critical service is down
  const isHealthy = healthCheck.services.redis !== "error";

  res.status(isHealthy ? 200 : 503).json(healthCheck);
});

// ─── Upload Configuration Endpoint ────────────────────────────────────────
app.get("/api/files/config", (req, res) => {
  const { getUploadConfig } = require("./middleware/uploadMiddleware");

  res.json({
    image: getUploadConfig("image"),
    document: getUploadConfig("document"),
    general: getUploadConfig("general"),
  });
});

// ─── API Routes ───────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/auth/2fa", twoFactorRoutes);
app.use("/api/items", itemRoutes);
app.use("/api/trades", tradeRoutes);
app.use("/api/conversations", conversationRoutes);

// ─── 404 Handler ──────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    message: "Route not found",
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString(),
  });
});

// ─── Global Error Handler (must be last) ──────────────────────────────────
app.use(errorHandler);

module.exports = { app, setIO, allowedOrigins, redisClient };