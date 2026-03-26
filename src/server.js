const { app, setIO, allowedOrigins, redisClient } = require("./app");
const http = require("http");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
const { setupWebSocket } = require("./utils/socketService");
const { startExpirationScheduler } = require("./controllers/tradeController");
const { closeRedisConnection } = require("./config/redis");
const { validateJWTSecrets } = require("./utils/jwtService");
const { initializeNotificationService } = require("./services/notificationService");

const PORT = process.env.PORT || 5000;

// ─── Validate Critical Environment ────────────────────────────────────────
try {
  validateJWTSecrets();
  console.log("✅ JWT secrets validated");
} catch (error) {
  console.error("❌ JWT Configuration Error:", error.message);
  console.error("Please generate proper JWT secrets using crypto.randomBytes(32).toString('hex')");
  process.exit(1);
}

// ─── HTTP Server ──────────────────────────────────────────────────────
const server = http.createServer(app);

// ─── Socket.IO ────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Inject io into Express request pipeline
setIO(io);

// Initialize notification service with Socket.IO instance
initializeNotificationService(io);

// Set up WebSocket event handlers
setupWebSocket(io);

// ─── MongoDB Connection ───────────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("Connected to MongoDB Atlas");

    // Start server only after successful DB connection
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

    // Start trade expiration scheduler (checks every hour)
    startExpirationScheduler();
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });

// ─── Graceful Shutdown ────────────────────────────────────────────────
const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  // Stop accepting new connections
  server.close(() => {
    console.log("HTTP server closed");
  });

  // Close Socket.IO
  io.close(() => {
    console.log("Socket.IO closed");
  });

  // Close Redis connection
  try {
    await closeRedisConnection();
    console.log("Redis connection closed");
  } catch (err) {
    console.error("Error closing Redis:", err.message);
  }

  // Close MongoDB connection
  try {
    await mongoose.connection.close();
    console.log("MongoDB connection closed");
  } catch (err) {
    console.error("Error closing MongoDB:", err.message);
  }

  process.exit(0);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  gracefulShutdown("uncaughtException");
});
