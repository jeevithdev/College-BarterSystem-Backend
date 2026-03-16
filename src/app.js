const express = require("express");
const app = express();
const cors = require("cors")
const mongoose = require("mongoose");
const path = require("path");
const authRoutes = require("./routes/auth");
const itemRoutes = require("./routes/itemRoutes");
const tradeRoutes = require("./routes/tradeRoutes");
const conversationRoutes = require("./routes/conversationRoutes");
require("dotenv").config();

app.use(express.json());
const corsOptions = {
  origin: ['http://localhost:5173', 'http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:5000', 'http://127.0.0.1:5000'],
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

app.use("/api/auth", authRoutes);
app.use("/api/items", itemRoutes);
app.use("/api/trades", tradeRoutes);
app.use("/api/conversations", conversationRoutes);

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("Connected to MongoDB Atlas"))
  .catch(err => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });
module.exports = app;