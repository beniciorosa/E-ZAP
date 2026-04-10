// ===== Baileys Multi-Session Manager =====
// Manages multiple WhatsApp connections via Baileys library.
// Sessions are persisted to Supabase (creds as JSONB).

const { default: makeWASocket, DisconnectReason, makeCacheableSignalKeyStore, initAuthCreds, BufferJSON } = require("@whiskeysockets/baileys");
const pino = require("pino");
const { supaRest } = require("./supabase");

const logger = pino({ level: "warn" });

// In-memory session store: sessionId -> { sock, status, qr }
const sessions = new Map();
// Reconnection attempt counters: sessionId -> count
const reconnectAttempts = new Map();
const MAX_RECONNECT_ATTEMPTS = 5;

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
      reconnectAttempts.delete(sessionId); // Reset counter on success
      const phone = sock.user?.id?.split(":")[0] || sock.user?.id?.split("@")[0] || "";
      await updateSessionStatus(sessionId, "connected", phone);
      await saveSessionCreds(sessionId, authState.creds);
      emit("session:connected", { sessionId, phone });
      console.log("[BAILEYS] Connected:", sessionId, "phone:", phone);
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMsg = lastDisconnect?.error?.message || "";
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 403;

      console.log("[BAILEYS] Disconnected:", sessionId, "code:", statusCode, "reconnect:", shouldReconnect);

      sessions.delete(sessionId);

      if (shouldReconnect) {
        const attempts = (reconnectAttempts.get(sessionId) || 0) + 1;
        reconnectAttempts.set(sessionId, attempts);

        if (attempts > MAX_RECONNECT_ATTEMPTS) {
          console.log("[BAILEYS] Max reconnect attempts reached for:", sessionId, "- stopping");
          reconnectAttempts.delete(sessionId);
          await updateSessionStatus(sessionId, "disconnected");
          emit("session:disconnected", { sessionId, reason: "max_attempts" });
          return;
        }

        // Progressive backoff: 3s, 6s, 12s, 24s, 48s
        const delay = 3000 * Math.pow(2, attempts - 1);
        console.log("[BAILEYS] Reconnecting:", sessionId, "attempt:", attempts + "/" + MAX_RECONNECT_ATTEMPTS, "in", delay + "ms");

        setTimeout(async () => {
          // Fetch fresh creds from Supabase instead of using stale closure
          try {
            const rows = await supaRest("/rest/v1/wa_sessions?id=eq." + sessionId + "&select=creds");
            const freshCreds = rows && rows.length > 0 ? rows[0].creds : null;
            await startSession(sessionId, freshCreds);
          } catch(e) {
            console.error("[BAILEYS] Failed to fetch creds for reconnect:", e.message);
            await startSession(sessionId, null);
          }
        }, delay);
      } else {
        reconnectAttempts.delete(sessionId);
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

  // Get contact/group name
  let chatName = "";
  try {
    if (jid.endsWith("@g.us")) {
      // Group: get group subject from Baileys
      try {
        const groupMeta = await sock.groupMetadata(jid);
        chatName = groupMeta?.subject || jid.split("@")[0];
      } catch(e) {
        chatName = jid.split("@")[0];
      }
    } else {
      chatName = msg.pushName || jid.split("@")[0];
    }
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

  // Format JID — keep @g.us as-is, convert LID to phone, add @s.whatsapp.net for plain numbers
  if (!jid.includes("@")) {
    jid = jid.replace(/\D/g, "") + "@s.whatsapp.net";
  } else if (jid.includes("@lid")) {
    // LID format — need to resolve to phone number via store
    console.log("[BAILEYS] Resolving LID:", jid);
    try {
      // Try to get contact info from Baileys store
      const contact = await session.sock.onWhatsApp(jid.split("@")[0]);
      if (contact && contact.length > 0) {
        jid = contact[0].jid;
        console.log("[BAILEYS] Resolved LID to:", jid);
      }
    } catch(e) {
      console.log("[BAILEYS] LID resolve failed, trying sender_jid from DB...");
      // Fallback: get phone from wa_messages (sender_jid from last received message)
      try {
        const msgs = await supaRest("/rest/v1/wa_messages?session_id=eq." + sessionId + "&chat_jid=eq." + encodeURIComponent(jid) + "&from_me=eq.false&order=timestamp.desc&limit=1&select=sender_jid");
        if (msgs && msgs.length > 0 && msgs[0].sender_jid && msgs[0].sender_jid.includes("@s.whatsapp.net")) {
          jid = msgs[0].sender_jid;
          console.log("[BAILEYS] Resolved from DB to:", jid);
        }
      } catch(e2) { console.log("[BAILEYS] DB fallback failed:", e2.message); }
    }
  }

  let sentMsg;
  if (content.image) {
    sentMsg = await session.sock.sendMessage(jid, {
      image: { url: content.image },
      caption: content.caption || "",
    });
  } else {
    sentMsg = await session.sock.sendMessage(jid, { text: content.text || content });
  }

  // Resolve chat name for saving
  let chatName = jid.split("@")[0];
  try {
    if (jid.endsWith("@g.us")) {
      const groupMeta = await session.sock.groupMetadata(jid);
      chatName = groupMeta?.subject || chatName;
    } else {
      // Try to get existing name from DB
      const existing = await supaRest("/rest/v1/wa_messages?session_id=eq." + sessionId + "&chat_jid=eq." + encodeURIComponent(jid) + "&chat_name=neq.&order=timestamp.desc&limit=1&select=chat_name");
      if (existing && existing.length > 0 && existing[0].chat_name) {
        chatName = existing[0].chat_name;
      }
    }
  } catch(e) {}

  // Save sent message to Supabase
  const textBody = content.text || content.caption || (typeof content === "string" ? content : "");
  try {
    await supaRest("/rest/v1/wa_messages", "POST", {
      session_id: sessionId,
      message_id: sentMsg.key.id,
      chat_jid: jid,
      chat_name: chatName,
      from_me: true,
      sender_name: "Eu",
      sender_jid: session.sock.user?.id || "",
      body: textBody,
      media_type: content.image ? "image" : null,
      timestamp: new Date().toISOString(),
    }, "resolution=merge-duplicates,return=minimal");
  } catch(e) {
    console.error("[BAILEYS] Failed to save sent message:", e.message);
  }

  // Emit for real-time update
  emit("message:new", {
    sessionId,
    chatJid: jid,
    chatName: chatName,
    fromMe: true,
    body: textBody,
    timestamp: Math.floor(Date.now() / 1000),
  });

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
  let creds;

  if (existingCreds && Object.keys(existingCreds).length > 0) {
    try {
      // Reconstruct Buffer/Uint8Array objects from Supabase JSONB
      creds = JSON.parse(JSON.stringify(existingCreds), BufferJSON.reviver);
      // Validate critical key exists
      if (!creds.noiseKey || !creds.noiseKey.public) {
        console.log("[BAILEYS] Creds corrupted (missing noiseKey), generating fresh creds for:", sessionId);
        creds = initAuthCreds();
      }
    } catch(e) {
      console.log("[BAILEYS] Failed to parse creds, generating fresh for:", sessionId, e.message);
      creds = initAuthCreds();
    }
  } else {
    // No existing creds — generate fresh (will require QR scan)
    creds = initAuthCreds();
    console.log("[BAILEYS] Fresh creds generated for:", sessionId);
  }

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
    // Serialize Buffer/Uint8Array properly for JSONB storage
    const serialized = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
    await supaRest("/rest/v1/wa_sessions?id=eq." + sessionId, "PATCH", {
      creds: serialized,
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
      // Validate creds before auto-reconnect — skip if corrupted (would need QR scan)
      const credsValid = s.creds && Object.keys(s.creds).length > 0 && (() => {
        try {
          const parsed = JSON.parse(JSON.stringify(s.creds), BufferJSON.reviver);
          return parsed.noiseKey && parsed.noiseKey.public;
        } catch(e) { return false; }
      })();

      if (!credsValid) {
        console.log("[BAILEYS] Skipping session with corrupted creds:", s.id, "- marking disconnected");
        await updateSessionStatus(s.id, "disconnected");
        continue;
      }

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
