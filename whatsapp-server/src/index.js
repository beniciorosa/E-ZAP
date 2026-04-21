// ===== E-ZAP WhatsApp Server =====
// Multi-session Baileys backend with Express API + Socket.io real-time
require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const cors = require("cors");
const { requireAuth } = require("./middleware/auth");
const baileys = require("./services/baileys");

const PORT = process.env.PORT || 3100;

// ===== Express setup =====
const app = express();
app.use(cors());
// Raise body limit so /api/fotos/upload can accept base64 images up to ~10MB.
app.use(express.json({ limit: "15mb" }));

// Serve static files (group avatars, assets) — publicly accessible, no auth.
// Upload via SFTP to /opt/ezap/whatsapp-server/public/ on the Hetzner box.
app.use("/static", express.static(path.resolve(__dirname, "../public"), {
  maxAge: "7d",
  fallthrough: true,
}));

// Serve ezapweb.html at root (same origin, no mixed content issues)
app.get("/", (req, res) => {
  res.sendFile(path.resolve(__dirname, "../../ezapweb.html"));
});
app.get("/ezapweb.html", (req, res) => {
  res.sendFile(path.resolve(__dirname, "../../ezapweb.html"));
});

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
app.use("/api/fotos", requireAuth, require("./routes/fotos"));
app.use("/api/hubspot", requireAuth, require("./routes/hubspot"));
app.use("/api/activity", requireAuth, require("./routes/activity"));
app.use("/api/dhiego-ai", requireAuth, require("./routes/dhiego-ai"));
app.use("/api/google", require("./routes/google-oauth")); // no auth — OAuth callback must be public

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

// Activity log — unifica eventos de produção em activity_events + emite em
// tempo real via socket.io (canal: "activity:event"). Ver
// whatsapp-server/src/services/activity-log.js
require("./services/activity-log").setIO(io);

// ===== Start server =====
server.listen(PORT, async () => {
  console.log("===========================================");
  console.log("  E-ZAP WhatsApp Server v1.0.0");
  console.log("  Port: " + PORT);
  console.log("  Supabase: " + (process.env.SUPABASE_URL ? "connected" : "NOT SET"));
  console.log("===========================================");

  // Reconnect saved sessions on boot
  await baileys.reconnectAllSessions();

  // ===== Cron: refresh CALLS DE HOJE + CALLS DA SEMANA diariamente às 00:01 BRT =====
  try {
    const cron = require("node-cron");
    const callHubspot = async (path, label) => {
      try {
        const resp = await fetch(`http://localhost:${PORT}${path}`, {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + (process.env.ADMIN_TOKEN || ""),
            "Content-Type": "application/json",
          },
        });
        const data = await resp.json().catch(() => ({}));
        console.log(`[CRON ${label}]`, JSON.stringify(data));
      } catch (e) {
        console.error(`[CRON ${label}] failed:`, e.message);
      }
    };
    cron.schedule("1 0 * * *", async () => {
      await callHubspot("/api/hubspot/calls-today/refresh", "calls-today");
      await callHubspot("/api/hubspot/calls-week/refresh", "calls-week");
    }, { timezone: "America/Sao_Paulo" });
    console.log("[CRON] CALLS DE HOJE + SEMANA refresh scheduled (00:01 America/Sao_Paulo)");

    // Cleanup do activity_events — roda 03:00 BRT todos os dias.
    // Chama a RPC cleanup_old_activity_events(30) que apaga em batches de 1000.
    cron.schedule("0 3 * * *", async () => {
      try {
        const { supaRest } = require("./services/supabase");
        const r = await supaRest(
          "/rest/v1/rpc/cleanup_old_activity_events",
          "POST",
          { keep_days: 30 }
        );
        console.log("[CRON activity-cleanup] rows deleted:", r);
      } catch (e) {
        console.error("[CRON activity-cleanup] failed:", e.message);
      }
    }, { timezone: "America/Sao_Paulo" });
    console.log("[CRON] activity_events cleanup scheduled (03:00 America/Sao_Paulo, keep 30d)");
  } catch (e) {
    console.warn("[CRON] node-cron not available:", e.message);
  }
});
