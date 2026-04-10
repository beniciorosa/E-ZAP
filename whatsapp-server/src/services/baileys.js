// ===== Baileys Multi-Session Manager =====
// Manages multiple WhatsApp connections via Baileys library.
// Sessions are persisted to Supabase (creds as JSONB).

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
const pino = require("pino");
const { supaRest } = require("./supabase");

const logger = pino({ level: "warn" });

// In-memory session store: sessionId -> { sock, status, qr }
const sessions = new Map();

// Event emitter for WebSocket broadcasting
let _io = null;
function setIO(io) { _io = io; }

function emit(event, data) {
  if (_io) _io.emit(event, data);
}

// ===== Create or reconnect a session =====
async function startSession(sessionId, existingCreds = null) {
  if (sessions.has(sessionId)) {
    const s = sessions.get(sessionId);
    if (s.status === "connected") return { status: "already_connected" };
  }

  console.log("[BAILEYS] Starting session:", sessionId);

  // Auth state: use in-memory creds from Supabase
  const authState = await buildAuthState(sessionId, existingCreds);

  const sock = makeWASocket({
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, logger),
    },
    printQRInTerminal: false,
    logger: logger,
    browser: ["E-ZAP Server", "Chrome", "1.0.0"],
    generateHighQualityLinkPreview: false,
  });

  const session = { sock, status: "connecting", qr: null, sessionId };
  sessions.set(sessionId, session);

  // Connection updates (QR, connected, disconnected)
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.status = "qr_pending";
      session.qr = qr;
      await updateSessionStatus(sessionId, "qr_pending");
      emit("session:qr", { sessionId, qr });
      console.log("[BAILEYS] QR generated for:", sessionId);
    }

    if (connection === "open") {
      session.status = "connected";
      session.qr = null;
      const phone = sock.user?.id?.split(":")[0] || sock.user?.id?.split("@")[0] || "";
      await updateSessionStatus(sessionId, "connected", phone);
      await saveSessionCreds(sessionId, authState.creds);
      emit("session:connected", { sessionId, phone });
      console.log("[BAILEYS] Connected:", sessionId, "phone:", phone);
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 403;

      console.log("[BAILEYS] Disconnected:", sessionId, "code:", statusCode, "reconnect:", shouldReconnect);

      sessions.delete(sessionId);

      if (shouldReconnect) {
        // Auto-reconnect after 3 seconds
        setTimeout(() => {
          console.log("[BAILEYS] Reconnecting:", sessionId);
          startSession(sessionId, existingCreds);
        }, 3000);
      } else {
        await updateSessionStatus(sessionId, statusCode === 403 ? "banned" : "disconnected");
        emit("session:disconnected", { sessionId, reason: statusCode });
      }
    }
  });

  // Save creds on update
  sock.ev.on("creds.update", async () => {
    await saveSessionCreds(sessionId, authState.creds);
  });

  // Message handler
  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    if (type !== "notify") return;
    for (const msg of msgs) {
      try {
        await handleIncomingMessage(sessionId, msg, sock);
      } catch (e) {
        console.error("[BAILEYS] Message handler error:", e.message);
      }
    }
  });

  return { status: "starting" };
}

// ===== Handle incoming message =====
async function handleIncomingMessage(sessionId, msg, sock) {
  const jid = msg.key.remoteJid;
  if (!jid || jid === "status@broadcast") return;

  const body = msg.message?.conversation
    || msg.message?.extendedTextMessage?.text
    || msg.message?.imageMessage?.caption
    || msg.message?.videoMessage?.caption
    || "";

  const mediaType = msg.message?.imageMessage ? "image"
    : msg.message?.videoMessage ? "video"
    : msg.message?.audioMessage ? "audio"
    : msg.message?.documentMessage ? "document"
    : msg.message?.stickerMessage ? "sticker"
    : null;

  // Get contact name
  let chatName = "";
  try {
    chatName = msg.pushName || jid.split("@")[0];
  } catch(e) {}

  // Save to Supabase
  await supaRest("/rest/v1/wa_messages", "POST", {
    session_id: sessionId,
    message_id: msg.key.id,
    chat_jid: jid,
    chat_name: chatName,
    from_me: msg.key.fromMe || false,
    sender_name: msg.pushName || "",
    sender_jid: msg.key.participant || jid,
    body: body,
    media_type: mediaType,
    timestamp: new Date((msg.messageTimestamp || 0) * 1000).toISOString(),
  }, "resolution=merge-duplicates,return=minimal");

  // Emit for real-time
  emit("message:new", {
    sessionId,
    chatJid: jid,
    chatName,
    fromMe: msg.key.fromMe || false,
    body,
    mediaType,
    timestamp: msg.messageTimestamp,
  });
}

// ===== Send message =====
async function sendMessage(sessionId, jid, content) {
  const session = sessions.get(sessionId);
  if (!session || session.status !== "connected") {
    throw new Error("Sessão não conectada: " + sessionId);
  }

  // Format JID
  if (!jid.includes("@")) {
    jid = jid.replace(/\D/g, "") + "@s.whatsapp.net";
  }

  if (content.image) {
    await session.sock.sendMessage(jid, {
      image: { url: content.image },
      caption: content.caption || "",
    });
  } else {
    await session.sock.sendMessage(jid, { text: content.text || content });
  }

  return { ok: true };
}

// ===== Stop session =====
async function stopSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    try { session.sock.end(); } catch(e) {}
    sessions.delete(sessionId);
  }
  await updateSessionStatus(sessionId, "disconnected");
  return { ok: true };
}

// ===== List active sessions =====
function getActiveSessions() {
  const result = [];
  for (const [id, s] of sessions) {
    result.push({
      sessionId: id,
      status: s.status,
      hasQr: !!s.qr,
      phone: s.sock?.user?.id?.split(":")[0] || "",
    });
  }
  return result;
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

// ===== Auth state helpers =====
async function buildAuthState(sessionId, existingCreds) {
  // Simple in-memory auth state
  let creds = existingCreds || {};
  const keys = {};

  return {
    creds,
    keys: {
      get: async (type, ids) => {
        const result = {};
        for (const id of ids) {
          const key = keys[type + "_" + id];
          if (key) result[id] = key;
        }
        return result;
      },
      set: async (data) => {
        for (const type in data) {
          for (const id in data[type]) {
            keys[type + "_" + id] = data[type][id];
          }
        }
      },
    },
  };
}

async function saveSessionCreds(sessionId, creds) {
  try {
    await supaRest("/rest/v1/wa_sessions?id=eq." + sessionId, "PATCH", {
      creds: creds,
      last_seen: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[BAILEYS] Failed to save creds:", e.message);
  }
}

async function updateSessionStatus(sessionId, status, phone) {
  try {
    const body = { status, last_seen: new Date().toISOString() };
    if (phone) body.phone = phone;
    await supaRest("/rest/v1/wa_sessions?id=eq." + sessionId, "PATCH", body);
  } catch (e) {
    console.error("[BAILEYS] Failed to update status:", e.message);
  }
}

// ===== Boot: reconnect all saved sessions =====
async function reconnectAllSessions() {
  try {
    const sessions = await supaRest("/rest/v1/wa_sessions?status=eq.connected&select=id,creds");
    if (!sessions || !sessions.length) {
      console.log("[BAILEYS] No saved sessions to reconnect");
      return;
    }
    console.log("[BAILEYS] Reconnecting", sessions.length, "saved sessions...");
    for (const s of sessions) {
      await startSession(s.id, s.creds);
      // Small delay between reconnections to avoid rate limits
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (e) {
    console.error("[BAILEYS] Reconnect error:", e.message);
  }
}

module.exports = {
  setIO,
  startSession,
  stopSession,
  sendMessage,
  getActiveSessions,
  getSession,
  reconnectAllSessions,
};
