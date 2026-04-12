// ===== E-ZAP WhatsApp Server =====
// Multi-session Baileys backend with Express API + Socket.io real-time
require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { requireAuth } = require("./middleware/auth");
const baileys = require("./services/baileys");

const PORT = process.env.PORT || 3100;

// ===== Express setup =====
const app = express();
app.use(cors());
app.use(express.json());

// Health check (public)
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    sessions: baileys.getActiveSessions().length,
  });
});

// Protected routes
app.use("/api/sessions", requireAuth, require("./routes/sessions"));
app.use("/api/messages", requireAuth, require("./routes/messages"));
app.use("/api/contacts", requireAuth, require("./routes/contacts"));
app.use("/api/jobs", requireAuth, require("./routes/jobs"));

// ===== HTTP + Socket.io =====
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// Auth for WebSocket connections
io.use((socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.query.token;
  if (token !== process.env.ADMIN_TOKEN) {
    return next(new Error("Token inválido"));
  }
  next();
});

io.on("connection", (socket) => {
  console.log("[WS] Admin connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("[WS] Admin disconnected:", socket.id);
  });
});

// Connect Socket.io to Baileys for event broadcasting
baileys.setIO(io);

// ===== Start server =====
server.listen(PORT, async () => {
  console.log("===========================================");
  console.log("  E-ZAP WhatsApp Server v1.0.0");
  console.log("  Port: " + PORT);
  console.log("  Supabase: " + (process.env.SUPABASE_URL ? "connected" : "NOT SET"));
  console.log("===========================================");

  // Reconnect saved sessions on boot
  await baileys.reconnectAllSessions();
});
