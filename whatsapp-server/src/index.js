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
app.use("/api/vcard", requireAuth, require("./routes/vcard"));
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
const _activityLog = require("./services/activity-log");
_activityLog.setIO(io);

// PR 2 — IQ counter snapshot loop: a cada 5 min emite iq:snapshot events
// pra cada sessão com atividade na última hora. Persiste historical em
// activity_events pra análise posterior (mesmo após pm2 restart que zera
// o counter in-memory). Ver whatsapp-server/src/services/iq-counter.js
const _iqCounter = require("./services/iq-counter");
_iqCounter.startSnapshotLoop(_activityLog.logEvent);

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

    // Cleanup do activity_events — DESATIVADO (2026-04-21).
    // Decisão: manter log eternamente. Volume estimado ~450MB/ano com todos
    // os 5 upgrades ativados (PR1+PR2). Plano Supabase SMALL suporta 10-18
    // anos antes de chegar no limite. Dados históricos são valiosos pra:
    // calibração empírica de hipóteses de rate-limit, auditoria, futura ML.
    // Se em 2030+ o DB crescer absurdo, migrar pra archive em Storage bucket.
    // RPC cleanup_old_activity_events continua existente no DB caso precisemos
    // limpar manualmente no futuro — só não é mais chamada automaticamente.

    // ===== Cron: cleanup seletivo de eventos ruidosos — a cada 6h =====
    // session:transient_drop + session:reconnected sao eventos de keep-alive
    // que geram ~280 rows/hora em producao (20+ sessoes). Retencao 48h pra
    // esses 2 types, permanente pra todo o resto (via RPC cleanup_transient_events
    // da migration 064). Cron roda a cada 6h em batches de 1000 rows.
    const { supaRest } = require("./services/supabase");
    cron.schedule("0 */6 * * *", async () => {
      try {
        const result = await supaRest(
          "/rest/v1/rpc/cleanup_transient_events",
          "POST",
          { keep_hours: 48 }
        );
        const deleted = Array.isArray(result) ? result[0] : result;
        console.log("[CRON cleanup_transient]", JSON.stringify(deleted));
      } catch (e) {
        console.error("[CRON cleanup_transient] failed:", e.message);
      }
    }, { timezone: "America/Sao_Paulo" });
    console.log("[CRON] cleanup_transient_events scheduled (every 6h, keep 48h)");
  } catch (e) {
    console.warn("[CRON] node-cron not available:", e.message);
  }
});
