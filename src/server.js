const app = require("./app");
const http = require("http");
const { Server } = require("socket.io");
const { setupWebSocket } = require("./utils/socketService");

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ['http://localhost:5173', 'http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:5000', 'http://127.0.0.1:5000'],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

setupWebSocket(io);

app.use((req, res, next) => {
  req.io = io;
  next();
});

server.listen(PORT, () => console.log(`Server running on ${PORT}`));
