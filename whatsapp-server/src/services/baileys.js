// ===== Baileys Multi-Session Manager =====
// Manages multiple WhatsApp connections via Baileys library.
// Sessions are persisted to Supabase (creds as JSONB).

const { default: makeWASocket, DisconnectReason, makeCacheableSignalKeyStore, initAuthCreds, BufferJSON } = require("@whiskeysockets/baileys");
const pino = require("pino");
const { supaRest } = require("./supabase");
const photoWorker = require("./photo-worker");

const logger = pino({ level: "warn" });

// In-memory session store: sessionId -> { sock, status, qr }
const sessions = new Map();
// Reconnection attempt counters: sessionId -> count
const reconnectAttempts = new Map();
const MAX_RECONNECT_ATTEMPTS = 5;

// Event emitter for WebSocket broadcasting
let _io = null;
function setIO(io) { _io = io; photoWorker.setIO(io); }

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
    // === History & Sync — captura completa ===
    syncFullHistory: true,                    // Pede histórico completo (INITIAL_BOOTSTRAP + FULL + RECENT)
    shouldSyncHistoryMessage: () => true,     // Aceita todos os tipos de history sync
    fireInitQueries: true,                    // Executa queries iniciais (contatos, grupos, presença)
    // === Presença & Online ===
    markOnlineOnConnect: false,               // NÃO marca online (evita conflito com celular do usuário)
    emitOwnEvents: true,                      // Emite eventos das próprias ações
    // === Retry & Resiliência ===
    maxMsgRetryCount: 10,                     // Máximo de retries para decrypt failures
    retryRequestDelayMs: 250,                 // Delay entre retries
    connectTimeoutMs: 30000,                  // Timeout de conexão 30s
    defaultQueryTimeoutMs: 60000,             // Timeout para queries 60s
    keepAliveIntervalMs: 25000,               // Ping mais frequente (25s)
    // === Ignorar status/stories ===
    shouldIgnoreJid: (jid) => jid === "status@broadcast",
    // === Link preview ===
    generateHighQualityLinkPreview: false,
    // === Message retry — busca do banco para reenvio ===
    getMessage: async (key) => {
      try {
        const rows = await supaRest(
          "/rest/v1/wa_messages?message_id=eq." + key.id + "&select=body&limit=1"
        );
        if (rows && rows[0] && rows[0].body) {
          return { conversation: rows[0].body };
        }
      } catch(e) {}
      return undefined;
    },
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

      // Start photo download worker
      photoWorker.startWorker(sessionId, sock);

      // Sync group metadata (description, participants) in background
      syncGroupMetadata(sessionId, sock).catch(e =>
        console.error("[BAILEYS] syncGroupMetadata error:", e.message)
      );
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMsg = lastDisconnect?.error?.message || "";
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 403;

      console.log("[BAILEYS] Disconnected:", sessionId, "code:", statusCode, "reconnect:", shouldReconnect);

      photoWorker.stopWorker(sessionId);
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

  // Message handler — "notify" = real-time, "append" = history sync
  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    const isRealTime = type === "notify";
    for (const msg of msgs) {
      try {
        await handleIncomingMessage(sessionId, msg, sock, isRealTime);
      } catch (e) {
        console.error("[BAILEYS] Message handler error:", e.message);
      }
    }
  });

  // Chats upsert — captures chat list updates (works without event buffering)
  sock.ev.on("chats.upsert", async (newChats) => {
    console.log("[BAILEYS] chats.upsert for", sessionId, "- count:", newChats.length);
    const chatBatch = newChats.map(c => ({
      session_id: sessionId,
      chat_jid: c.id,
      chat_name: c.name || c.id.split("@")[0],
      unread_count: c.unreadCount || 0,
      is_group: c.id.endsWith("@g.us"),
      last_message_timestamp: c.conversationTimestamp
        ? new Date((typeof c.conversationTimestamp === "object" ? (c.conversationTimestamp.low || c.conversationTimestamp) : c.conversationTimestamp) * 1000).toISOString()
        : null,
      pinned: c.pinned ? true : false,
      archived: c.archived ? true : false,
      muted_until: c.muteEndTime ? new Date(c.muteEndTime * 1000).toISOString() : null,
    }));
    for (let i = 0; i < chatBatch.length; i += 100) {
      try {
        await supaRest("/rest/v1/wa_chats", "POST", chatBatch.slice(i, i + 100), "resolution=merge-duplicates,return=minimal");
      } catch(e) {
        console.error("[BAILEYS] chats.upsert save error:", e.message);
      }
    }

    // Also upsert into wa_contacts + enqueue photos
    const contactBatch = newChats.map(c => ({
      session_id: sessionId,
      contact_jid: c.id,
      push_name: c.name || null,
      phone: c.id.split("@")[0].split(":")[0],
      is_group: c.id.endsWith("@g.us"),
      synced_at: new Date().toISOString(),
    }));
    for (let i = 0; i < contactBatch.length; i += 100) {
      await supaRest("/rest/v1/wa_contacts", "POST", contactBatch.slice(i, i + 100),
        "resolution=merge-duplicates,return=minimal").catch(() => {});
    }
    enqueuePhotos(sessionId, newChats.map(c => c.id));
  });

  // History sync — bulk historical messages/chats on connection (buffered event)
  sock.ev.process(async (events) => {
    if (events["messaging-history.set"]) {
      const { messages: msgs, chats: syncedChats, isLatest } = events["messaging-history.set"];
      console.log("[BAILEYS] History sync for", sessionId, "- msgs:", (msgs || []).length, "chats:", (syncedChats || []).length, "isLatest:", isLatest);
      await processHistorySync(sessionId, msgs, syncedChats);
    }
  });

  // Fallback ev.on for messaging-history.set (in case ev.process doesn't catch it)
  sock.ev.on("messaging-history.set", async ({ messages: msgs, chats: syncedChats, isLatest }) => {
    console.log("[BAILEYS] History sync (ev.on) for", sessionId, "- msgs:", (msgs || []).length, "chats:", (syncedChats || []).length);
    await processHistorySync(sessionId, msgs, syncedChats);
  });

  // ===== Contact sync — full list on connection =====
  sock.ev.on("contacts.upsert", async (contacts) => {
    if (!contacts || !contacts.length) return;
    console.log("[BAILEYS] contacts.upsert:", contacts.length, "contacts for", sessionId);

    const batch = contacts.map(c => ({
      session_id: sessionId,
      contact_jid: c.id,
      name: c.name || null,
      push_name: c.notify || null,
      phone: c.id.split("@")[0].split(":")[0],
      is_group: c.id.endsWith("@g.us"),
      synced_at: new Date().toISOString(),
    }));

    for (let i = 0; i < batch.length; i += 100) {
      const chunk = batch.slice(i, i + 100);
      try {
        await supaRest("/rest/v1/wa_contacts", "POST", chunk, "resolution=merge-duplicates,return=minimal");
      } catch (e) {
        console.error("[BAILEYS] contacts.upsert batch error:", e.message);
      }
    }

    // Enqueue photo downloads
    enqueuePhotos(sessionId, contacts.map(c => c.id));
  });

  // ===== Contact update — incremental changes =====
  sock.ev.on("contacts.update", async (updates) => {
    if (!updates || !updates.length) return;

    for (const c of updates) {
      if (!c.id) continue;
      const patch = {};
      if (c.name !== undefined) patch.name = c.name;
      if (c.notify !== undefined) patch.push_name = c.notify;
      patch.synced_at = new Date().toISOString();

      try {
        // Upsert: insert if not exists, update if exists
        await supaRest("/rest/v1/wa_contacts", "POST", [{
          session_id: sessionId,
          contact_jid: c.id,
          phone: c.id.split("@")[0].split(":")[0],
          is_group: c.id.endsWith("@g.us"),
          ...patch,
        }], "resolution=merge-duplicates,return=minimal");
      } catch (e) {
        console.error("[BAILEYS] contacts.update error:", e.message);
      }

      // If imgUrl changed, re-enqueue photo
      if (c.imgUrl !== undefined) {
        enqueuePhotos(sessionId, [c.id], true);
      }
    }
  });

  // ===== Group metadata update — name, description, photo, settings =====
  sock.ev.on("groups.update", async (updates) => {
    if (!updates || !updates.length) return;

    for (const g of updates) {
      if (!g.id) continue;
      const patch = {};
      if (g.subject !== undefined) patch.chat_name = g.subject;
      if (g.desc !== undefined) patch.description = g.desc;
      if (g.announce !== undefined) patch.is_read_only = g.announce === true || g.announce === "true";
      if (g.ephemeralDuration !== undefined) patch.ephemeral_duration = g.ephemeralDuration || 0;

      if (Object.keys(patch).length > 0) {
        try {
          await supaRest(
            "/rest/v1/wa_chats?session_id=eq." + sessionId + "&chat_jid=eq." + encodeURIComponent(g.id),
            "PATCH", patch, "return=minimal"
          );
        } catch (e) {
          console.error("[BAILEYS] groups.update error:", e.message);
        }
      }

      // Re-enqueue photo if profile picture changed
      if (g.imgUrl !== undefined) {
        enqueuePhotos(sessionId, [g.id], true);
      }
    }
  });

  // ===== Group participants update — join, leave, promote, demote =====
  sock.ev.on("group-participants.update", async ({ id: groupJid, participants, action }) => {
    if (!groupJid || !participants) return;
    console.log("[BAILEYS] group-participants.update:", action, participants.length, "in", groupJid);

    const now = new Date().toISOString();

    for (const pJid of participants) {
      const phone = pJid.split("@")[0].split(":")[0];

      if (action === "add") {
        // Upsert member
        try {
          await supaRest("/rest/v1/group_members", "POST", [{
            group_jid: groupJid,
            member_phone: phone,
            member_name: "",
            role: "member",
            first_seen: now,
            last_seen: now,
            left_at: null,
          }], "resolution=merge-duplicates,return=minimal").catch(() => {});
        } catch (e) { /* ignore */ }

        // Enqueue photo for new member
        enqueuePhotos(sessionId, [pJid]);

      } else if (action === "remove") {
        // Mark as left
        try {
          await supaRest(
            "/rest/v1/group_members?group_jid=eq." + encodeURIComponent(groupJid) + "&member_phone=eq." + phone,
            "PATCH", { left_at: now, last_seen: now }, "return=minimal"
          ).catch(() => {});
        } catch (e) { /* ignore */ }

      } else if (action === "promote") {
        try {
          await supaRest(
            "/rest/v1/group_members?group_jid=eq." + encodeURIComponent(groupJid) + "&member_phone=eq." + phone,
            "PATCH", { role: "admin", last_seen: now }, "return=minimal"
          ).catch(() => {});
        } catch (e) { /* ignore */ }

      } else if (action === "demote") {
        try {
          await supaRest(
            "/rest/v1/group_members?group_jid=eq." + encodeURIComponent(groupJid) + "&member_phone=eq." + phone,
            "PATCH", { role: "member", last_seen: now }, "return=minimal"
          ).catch(() => {});
        } catch (e) { /* ignore */ }
      }
    }

    // Update participants count in wa_chats
    try {
      const meta = await sock.groupMetadata(groupJid).catch(() => null);
      if (meta && meta.participants) {
        await supaRest(
          "/rest/v1/wa_chats?session_id=eq." + sessionId + "&chat_jid=eq." + encodeURIComponent(groupJid),
          "PATCH", { participants_count: meta.participants.length }, "return=minimal"
        );
      }
    } catch (e) { /* ignore */ }
  });

  // ===== Chat update — pin, archive, mute, settings changes =====
  sock.ev.on("chats.update", async (updates) => {
    if (!updates || !updates.length) return;

    for (const c of updates) {
      if (!c.id) continue;
      const patch = {};
      if (c.pinned !== undefined) patch.pinned = c.pinned ? true : false;
      if (c.archived !== undefined) patch.archived = c.archived ? true : false;
      if (c.muteEndTime !== undefined) patch.muted_until = c.muteEndTime ? new Date(c.muteEndTime * 1000).toISOString() : null;
      if (c.unreadCount !== undefined) patch.unread_count = c.unreadCount;
      if (c.conversationTimestamp !== undefined) {
        const ts = typeof c.conversationTimestamp === "object" ? c.conversationTimestamp.low : c.conversationTimestamp;
        if (ts) patch.last_message_timestamp = new Date(ts * 1000).toISOString();
      }
      if (c.name !== undefined) patch.chat_name = c.name;

      if (Object.keys(patch).length > 0) {
        try {
          await supaRest(
            "/rest/v1/wa_chats?session_id=eq." + sessionId + "&chat_jid=eq." + encodeURIComponent(c.id),
            "PATCH", patch, "return=minimal"
          );
        } catch (e) {
          console.error("[BAILEYS] chats.update error:", e.message);
        }
      }
    }
  });

  // ===== Chat delete — conversation deleted =====
  sock.ev.on("chats.delete", async (deletedIds) => {
    if (!deletedIds || !deletedIds.length) return;
    console.log("[BAILEYS] chats.delete:", deletedIds.length, "chats for", sessionId);

    for (const jid of deletedIds) {
      try {
        await supaRest(
          "/rest/v1/wa_chats?session_id=eq." + sessionId + "&chat_jid=eq." + encodeURIComponent(jid),
          "DELETE", null, "return=minimal"
        );
      } catch (e) {
        console.error("[BAILEYS] chats.delete error:", e.message);
      }
    }
  });

  // ===== Message update — edit, delete, status change =====
  sock.ev.on("messages.update", async (updates) => {
    if (!updates || !updates.length) return;

    for (const u of updates) {
      if (!u.key || !u.key.id) continue;
      const msgId = u.key.id;
      const chatJid = u.key.remoteJid;
      if (!chatJid || chatJid === "status@broadcast") continue;

      const patch = {};

      // Message edit
      if (u.update?.message) {
        const newBody = u.update.message?.conversation
          || u.update.message?.extendedTextMessage?.text
          || u.update.message?.editedMessage?.message?.protocolMessage?.editedMessage?.conversation
          || "";
        if (newBody) {
          patch.body = newBody;
          patch.is_edited = true;
          patch.edit_timestamp = new Date().toISOString();
        }
      }

      // Message delete (for everyone)
      if (u.update?.messageStubType === 68 || u.update?.message?.protocolMessage?.type === 0) {
        patch.is_deleted = true;
      }

      // Status update (delivered, read)
      if (u.update?.status !== undefined) {
        const statusMap = { 2: "sent", 3: "delivered", 4: "read" };
        if (statusMap[u.update.status]) {
          patch.status = statusMap[u.update.status];
        }
      }

      if (Object.keys(patch).length > 0) {
        try {
          await supaRest(
            "/rest/v1/wa_messages?session_id=eq." + sessionId + "&message_id=eq." + encodeURIComponent(msgId),
            "PATCH", patch, "return=minimal"
          );
        } catch (e) {
          // May not exist yet in DB — ignore
        }
      }
    }
  });

  // ===== Message reactions =====
  sock.ev.on("messages.reaction", async (reactions) => {
    if (!reactions || !reactions.length) return;

    for (const r of reactions) {
      if (!r.key || !r.key.id) continue;
      const msgId = r.key.id;
      const chatJid = r.key.remoteJid;
      if (!chatJid || chatJid === "status@broadcast") continue;

      const senderJid = r.reaction?.key?.participant || r.reaction?.key?.remoteJid || "";
      const emoji = r.reaction?.text || "";

      // Fetch current reactions from DB, modify, and save back
      try {
        const rows = await supaRest(
          "/rest/v1/wa_messages?session_id=eq." + sessionId + "&message_id=eq." + encodeURIComponent(msgId) +
          "&select=reactions"
        );
        if (!rows || rows.length === 0) continue;

        let reactions = rows[0].reactions || [];

        if (emoji) {
          // Add or replace reaction from this sender
          reactions = reactions.filter(rx => rx.sender !== senderJid);
          reactions.push({ emoji, sender: senderJid, timestamp: new Date().toISOString() });
        } else {
          // Empty emoji = reaction removed
          reactions = reactions.filter(rx => rx.sender !== senderJid);
        }

        await supaRest(
          "/rest/v1/wa_messages?session_id=eq." + sessionId + "&message_id=eq." + encodeURIComponent(msgId),
          "PATCH", { reactions }, "return=minimal"
        );
      } catch (e) {
        // Message may not exist in DB — ignore
      }
    }
  });

  // ===== Message delete — messages deleted for everyone =====
  sock.ev.on("messages.delete", async (data) => {
    if (!data) return;
    // Can be { keys: [...] } or { jid, all: true }
    if ("all" in data && data.all) {
      console.log("[BAILEYS] messages.delete ALL in", data.jid, "for", sessionId);
      emit("messages:delete", { sessionId, jid: data.jid, all: true });
    } else if (data.keys) {
      for (const key of data.keys) {
        if (!key.id || key.remoteJid === "status@broadcast") continue;
        try {
          await supaRest(
            "/rest/v1/wa_messages?session_id=eq." + sessionId + "&message_id=eq." + encodeURIComponent(key.id),
            "PATCH", { is_deleted: true }, "return=minimal"
          );
        } catch(e) {}
      }
      emit("messages:delete", { sessionId, keys: data.keys });
    }
  });

  // ===== Messages media update — media decrypted/available =====
  sock.ev.on("messages.media-update", async (updates) => {
    if (!updates || !updates.length) return;
    // Emit via Socket.io for frontend to update media previews
    emit("messages:media-update", { sessionId, updates: updates.map(u => ({
      messageId: u.key?.id, chatJid: u.key?.remoteJid, hasMedia: !!u.media, error: u.error?.message,
    }))});
  });

  // ===== Groups upsert — new group joined/created =====
  sock.ev.on("groups.upsert", async (groups) => {
    if (!groups || !groups.length) return;
    console.log("[BAILEYS] groups.upsert:", groups.length, "groups for", sessionId);

    for (const g of groups) {
      // Upsert into wa_chats
      try {
        await supaRest("/rest/v1/wa_chats", "POST", [{
          session_id: sessionId,
          chat_jid: g.id,
          chat_name: g.subject || g.id.split("@")[0],
          is_group: true,
          participants_count: g.participants ? g.participants.length : 0,
          synced_at: new Date().toISOString(),
        }], "resolution=merge-duplicates,return=minimal");
      } catch(e) {
        console.error("[BAILEYS] groups.upsert save error:", e.message);
      }

      // Upsert group members
      if (g.participants && g.participants.length > 0) {
        const members = g.participants.map(p => ({
          group_jid: g.id,
          member_phone: p.id.split("@")[0].split(":")[0],
          member_name: "",
          role: p.admin || "member",
          first_seen: new Date().toISOString(),
          last_seen: new Date().toISOString(),
        }));
        for (let i = 0; i < members.length; i += 100) {
          try {
            await supaRest("/rest/v1/group_members", "POST", members.slice(i, i + 100),
              "resolution=merge-duplicates,return=minimal");
          } catch(e) {}
        }
      }

      enqueuePhotos(sessionId, [g.id]);
    }
    emit("groups:upsert", { sessionId, groups: groups.map(g => ({ jid: g.id, subject: g.subject })) });
  });

  // ===== Chats phone number share — LID to JID mapping =====
  sock.ev.on("chats.phoneNumberShare", async (data) => {
    if (!data || !data.lid || !data.jid) return;
    console.log("[BAILEYS] phoneNumberShare:", data.lid, "->", data.jid, "for", sessionId);
    // Update wa_contacts to link LID with real JID
    try {
      await supaRest(
        "/rest/v1/wa_contacts?session_id=eq." + sessionId + "&contact_jid=eq." + encodeURIComponent(data.lid),
        "PATCH", { linked_jid: data.jid }, "return=minimal"
      );
    } catch(e) {}
    emit("chats:phoneNumberShare", { sessionId, lid: data.lid, jid: data.jid });
  });

  // ===== Call events — incoming/outgoing calls =====
  sock.ev.on("call", async (calls) => {
    if (!calls || !calls.length) return;
    for (const c of calls) {
      console.log("[BAILEYS] call:", c.status, "from", c.from, "for", sessionId);
      emit("call", { sessionId, callId: c.id, from: c.from, status: c.status, isGroup: c.isGroup, isVideo: c.isVideo });
    }
  });

  // ===== WhatsApp Business labels — edit and association =====
  sock.ev.on("labels.edit", async (label) => {
    if (!label) return;
    console.log("[BAILEYS] labels.edit:", label.name, "for", sessionId);
    emit("labels:edit", { sessionId, label });
  });

  sock.ev.on("labels.association", async ({ association, type }) => {
    if (!association) return;
    console.log("[BAILEYS] labels.association:", type, "for", sessionId);
    emit("labels:association", { sessionId, association, type });
  });

  return { status: "starting" };
}

// ===== Handle incoming message =====
async function handleIncomingMessage(sessionId, msg, sock, isRealTime) {
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

  // Emit for real-time only (not history sync)
  if (isRealTime) {
    emit("message:new", {
      sessionId,
      chatJid: jid,
      chatName,
      fromMe: msg.key.fromMe || false,
      senderName: msg.pushName || "",
      body,
      mediaType,
      timestamp: msg.messageTimestamp,
    });
  }
}

// ===== Send message =====
async function sendMessage(sessionId, jid, content) {
  const session = await waitForSessionConnected(sessionId);
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

// ===== Fetch groups with invite links (temporary tool) =====
// Detect WhatsApp rate-limit errors from Baileys stanzas
function isRateLimitError(e) {
  const msg = (e?.message || "").toLowerCase();
  const statusCode = e?.output?.statusCode || e?.data;
  if (statusCode === 429 || statusCode === 503) return true;
  return msg.includes("rate-overlimit")
    || msg.includes("rate_overlimit")
    || msg.includes("rate limit")
    || msg.includes("rate-limit")
    || msg.includes("too many")
    || msg.includes("not-acceptable");
}

// Extract base ID from a JID: strips device suffix ":N" and "@domain"
// Examples: "5511999:1@s.whatsapp.net" -> "5511999", "123456@lid" -> "123456"
function extractBase(jid) {
  if (!jid) return "";
  return String(jid).split(":")[0].split("@")[0];
}
function extractDomain(jid) {
  if (!jid) return "";
  const m = String(jid).match(/@(.+)$/);
  return m ? m[1] : "";
}

// Returns { myJid, myLid, myPhoneBase, myLidBase } for the current session.
// IMPORTANT: Baileys 6.6.0 does NOT populate `sock.user.lid` — the LID is
// only stored in `sock.authState.creds.me.lid`. If we only read from
// `sock.user.lid` the LID is empty, which breaks admin detection in groups
// that list participants by @lid (new WhatsApp default). Read both places
// and prefer whichever is populated.
function getSessionIdentity(sock) {
  const jidCandidate = sock?.user?.id || sock?.authState?.creds?.me?.id || "";
  const lidCandidate = sock?.user?.lid || sock?.authState?.creds?.me?.lid || "";
  return {
    myJid: jidCandidate,
    myLid: lidCandidate,
    myPhoneBase: extractBase(jidCandidate),
    myLidBase: extractBase(lidCandidate),
  };
}

// Wait up to maxWaitMs for a session to be in "connected" state.
// Useful when the session is auto-reconnecting (e.g., after WhatsApp
// closes an idle connection with code 428 and baileys kicks off a
// ~3s reconnect). Polls every 500ms and returns the session on success,
// or the latest session snapshot (may be null/disconnected) on timeout.
async function waitForSessionConnected(sessionId, maxWaitMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const s = sessions.get(sessionId);
    if (s && s.status === "connected") return s;
    await new Promise(r => setTimeout(r, 500));
  }
  return sessions.get(sessionId) || null;
}

async function fetchGroupsWithInvites(sessionId, skipJids = [], maxCalls = 10, options = {}) {
  const session = await waitForSessionConnected(sessionId);
  if (!session || session.status !== "connected") {
    throw new Error("Sessão não conectada: " + sessionId);
  }

  const sock = session.sock;
  // WhatsApp uses TWO identities for the same user: phone JID (@s.whatsapp.net)
  // and LID (@lid). In newer groups, participants are listed by LID instead of phone.
  // getSessionIdentity handles the Baileys 6.6.0 quirk where sock.user.lid is
  // empty and the real LID is only in sock.authState.creds.me.lid.
  const { myJid, myLid, myPhoneBase, myLidBase } = getSessionIdentity(sock);

  // JIDs to skip — caller already has the invite link cached for these
  const skipSet = new Set(Array.isArray(skipJids) ? skipJids : []);
  // Max number of groupInviteCode calls in this single request (batch limit to avoid HTTP timeout)
  // Set maxCalls to Infinity from job workers (they are not bound by HTTP timeouts).
  const maxCallsThisBatch = (maxCalls === Infinity) ? Infinity : Math.max(1, Math.min(50, Number(maxCalls) || 10));
  let callsMade = 0;
  let batchLimitReached = false;

  // Extended options for job workers:
  //   delaySec: override the default 60s between calls (with ±5s jitter preserved)
  //   onProgress(payload): called after each group is processed
  //   shouldCancel(): called before each API call; if returns true, loop stops
  const delaySecOverride = typeof options.delaySec === "number" ? options.delaySec : 60;
  const baseDelayMs = Math.max(5, Math.min(300, delaySecOverride)) * 1000; // clamp 5s..300s
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const shouldCancel = typeof options.shouldCancel === "function" ? options.shouldCancel : null;
  let cancelled = false;

  // 1. Fetch all participating groups
  const groupsMap = await sock.groupFetchAllParticipating();
  const groupList = Object.values(groupsMap || {});
  const total = groupList.length;

  const results = [];
  let rateLimited = false;
  let processed = 0;
  let adminDetectedAny = false;
  let firstGroupSample = null;

  for (const g of groupList) {
    processed++;

    // Check for cancellation (job worker mode)
    if (shouldCancel && shouldCancel()) {
      cancelled = true;
      break;
    }

    // Capture a sample of the first group's participant structure for debugging
    if (!firstGroupSample && Array.isArray(g.participants) && g.participants.length > 0) {
      firstGroupSample = {
        name: g.subject,
        participantCount: g.participants.length,
        firstThree: g.participants.slice(0, 3).map(p => ({
          id: p.id,
          admin: p.admin || null,
        })),
      };
    }

    // Check if "me" is admin in this group — match by phone base OR LID base
    let isAdmin = false;
    if (Array.isArray(g.participants)) {
      const me = g.participants.find(p => {
        const pid = p.id || "";
        const pBase = extractBase(pid);
        const pDomain = extractDomain(pid);
        if (pid === myJid || pid === myLid) return true;
        if (pDomain === "s.whatsapp.net" && myPhoneBase && pBase === myPhoneBase) return true;
        if (pDomain === "lid" && myLidBase && pBase === myLidBase) return true;
        // Fallback: loose match by any base (covers cases where domain is missing)
        if (myPhoneBase && pBase === myPhoneBase) return true;
        if (myLidBase && pBase === myLidBase) return true;
        return false;
      });
      if (me && (me.admin === "admin" || me.admin === "superadmin")) {
        isAdmin = true;
        adminDetectedAny = true;
      }
    }

    let inviteLink = null;
    let inviteError = null;
    let skipped = false;

    if (isAdmin && skipSet.has(g.id)) {
      // Caller already has this link cached — skip the API call entirely
      skipped = true;
    } else if (isAdmin && rateLimited) {
      inviteError = "Abortado por rate-limit";
    } else if (isAdmin && batchLimitReached) {
      // Reached per-batch call limit — frontend will call again in the next batch
      skipped = true;
    } else if (isAdmin) {
      try {
        const code = await sock.groupInviteCode(g.id);
        if (code) inviteLink = "https://chat.whatsapp.com/" + code;
      } catch (e) {
        inviteError = e?.message || "Falha ao obter código";
        // ABORT on rate-limit: stop calling groupInviteCode to protect the account
        if (isRateLimitError(e)) {
          rateLimited = true;
          console.warn("[BAILEYS] Rate limit detected — aborting invite extraction at group", processed, "of", total);
        }
      }
      callsMade++;
      // Delay between IQ requests — "safe zone" strategy with jitter ±5s.
      // Default 60s/call gives us ~60 calls/hour, below the empirical WhatsApp
      // rate-limit threshold. Caller can override via options.delaySec.
      if (!rateLimited && callsMade < maxCallsThisBatch) {
        const jitterMs = Math.floor((Math.random() - 0.5) * 10000); // ±5000ms
        await new Promise(r => setTimeout(r, baseDelayMs + jitterMs));
      }
      // After the last call in this batch, stop processing further admin groups
      if (callsMade >= maxCallsThisBatch) batchLimitReached = true;
    } else {
      inviteError = "Sem permissão (não é admin)";
    }

    const rowOut = {
      jid: g.id,
      name: g.subject || "(sem nome)",
      participants: Array.isArray(g.participants) ? g.participants.length : 0,
      isAdmin,
      inviteLink,
      inviteError,
      skipped,
    };
    results.push(rowOut);

    // Persist to Supabase (fire-and-forget, don't block the loop) if we have a terminal state.
    // Skip rows (skipped=true due to cache) are NOT re-saved — they're already in the DB.
    if (!skipped && (inviteLink || inviteError)) {
      upsertGroupLink(sessionId, rowOut);
    }

    // Notify progress observer (job worker), if any
    if (onProgress) {
      try {
        onProgress({
          processed,
          total,
          row: rowOut,
          rateLimited,
          callsMade,
        });
      } catch (_) {}
    }
  }

  const debug = {
    myJid,
    myLid,
    myPhoneBase,
    myLidBase,
    adminDetectedAny,
    firstGroupSample,
  };

  // Visibility when detection is broken: log a big warning so we know without
  // needing to dig through logs later. This triggers when identity IS known
  // (myPhoneBase OR myLidBase populated) but none of the N groups matched.
  if (!adminDetectedAny && (myPhoneBase || myLidBase) && total > 0) {
    console.warn(
      "[BAILEYS] Admin detection FAILED for session", sessionId,
      "— iterated", total, "groups, found 0 admins.",
      "myJid=" + (myJid || "(empty)"),
      "myLid=" + (myLid || "(empty)"),
      "firstGroupSample=" + JSON.stringify(firstGroupSample)
    );
  }

  return { groups: results, rateLimited, total, processed, callsMade, batchLimitReached, cancelled, debug };
}

// ===== Supabase helpers for wa_group_links / wa_group_additions =====
// Best-effort: errors are logged but do not break the extraction/add flow.
async function upsertGroupLink(sessionId, row) {
  try {
    await supaRest(
      "/rest/v1/wa_group_links?on_conflict=session_id,group_jid",
      "POST",
      {
        session_id: sessionId,
        group_jid: row.jid,
        group_name: row.name,
        invite_link: row.inviteLink || null,
        invite_error: row.inviteError || null,
        is_admin: !!row.isAdmin,
        participants_count: row.participants || 0,
        updated_at: new Date().toISOString(),
      },
      "resolution=merge-duplicates,return=minimal"
    );
  } catch (e) {
    console.error("[BAILEYS] upsertGroupLink failed:", e.message);
  }
}

async function upsertGroupAddition(sourceSessionId, targetPhone, row) {
  try {
    const wasPromoted =
      row.status === "added_and_promoted" ||
      row.status === "promoted_only" ||
      row.status === "already_admin";
    await supaRest(
      "/rest/v1/wa_group_additions?on_conflict=source_session_id,target_phone,group_jid",
      "POST",
      {
        source_session_id: sourceSessionId,
        target_phone: targetPhone,
        group_jid: row.jid,
        group_name: row.name,
        status: row.status,
        status_message: row.statusMessage || null,
        was_promoted: wasPromoted,
        performed_at: new Date().toISOString(),
      },
      "resolution=merge-duplicates,return=minimal"
    );
  } catch (e) {
    console.error("[BAILEYS] upsertGroupAddition failed:", e.message);
  }
}

// Read cached links for a session (used when the frontend opens)
async function getCachedGroupLinks(sessionId) {
  try {
    const rows = await supaRest(
      "/rest/v1/wa_group_links?session_id=eq." + sessionId +
      "&select=group_jid,group_name,invite_link,invite_error,is_admin,participants_count,updated_at&order=group_name.asc"
    );
    return rows || [];
  } catch (e) {
    console.error("[BAILEYS] getCachedGroupLinks failed:", e.message);
    return [];
  }
}

// Bulk import of legacy localStorage cache into Supabase.
// payload = { links: [{jid, link, error}], additionsByPhone: { "5511...": [{jid, status, statusMessage}] } }
// Uses single POST requests with array bodies so the whole cache goes up in
// at most 2 HTTP calls total, not one per row.
async function importLocalCache(sessionId, payload) {
  let linksImported = 0;
  let additionsImported = 0;
  const nowIso = new Date().toISOString();

  // ===== Links =====
  if (Array.isArray(payload?.links) && payload.links.length > 0) {
    const rows = payload.links
      .filter(it => it && it.jid)
      .map(it => ({
        session_id: sessionId,
        group_jid: it.jid,
        group_name: "(migrado do cache local)",
        invite_link: it.link || null,
        invite_error: it.error || null,
        is_admin: true, // legacy cache only stored entries where the session was admin
        participants_count: 0,
        updated_at: nowIso,
      }));
    if (rows.length > 0) {
      try {
        await supaRest(
          "/rest/v1/wa_group_links?on_conflict=session_id,group_jid",
          "POST",
          rows,
          "resolution=merge-duplicates,return=minimal"
        );
        linksImported = rows.length;
      } catch (e) {
        console.error("[BAILEYS] importLocalCache links failed:", e.message);
      }
    }
  }

  // ===== Additions =====
  if (payload?.additionsByPhone && typeof payload.additionsByPhone === "object") {
    const rows = [];
    for (const rawPhone of Object.keys(payload.additionsByPhone)) {
      const cleanPhone = String(rawPhone).replace(/\D/g, "");
      if (!cleanPhone) continue;
      const entries = payload.additionsByPhone[rawPhone];
      if (!Array.isArray(entries)) continue;
      for (const it of entries) {
        if (!it || !it.jid || !it.status) continue;
        const wasPromoted =
          it.status === "added_and_promoted" ||
          it.status === "promoted_only" ||
          it.status === "already_admin";
        rows.push({
          source_session_id: sessionId,
          target_phone: cleanPhone,
          group_jid: it.jid,
          group_name: "(migrado do cache local)",
          status: it.status,
          status_message: it.statusMessage || null,
          was_promoted: wasPromoted,
          performed_at: nowIso,
        });
      }
    }
    if (rows.length > 0) {
      try {
        await supaRest(
          "/rest/v1/wa_group_additions?on_conflict=source_session_id,target_phone,group_jid",
          "POST",
          rows,
          "resolution=merge-duplicates,return=minimal"
        );
        additionsImported = rows.length;
      } catch (e) {
        console.error("[BAILEYS] importLocalCache additions failed:", e.message);
      }
    }
  }

  return { linksImported, additionsImported };
}

// Read cached addition history for a (session, phone) pair
async function getCachedGroupAdditions(sessionId, targetPhone) {
  try {
    const rows = await supaRest(
      "/rest/v1/wa_group_additions?source_session_id=eq." + sessionId +
      "&target_phone=eq." + encodeURIComponent(targetPhone) +
      "&select=group_jid,group_name,status,status_message,was_promoted,performed_at&order=performed_at.desc"
    );
    return rows || [];
  } catch (e) {
    console.error("[BAILEYS] getCachedGroupAdditions failed:", e.message);
    return [];
  }
}

// ===== List admin groups + cross-reference membership of a target phone (real-time) =====
// If there's a connected session whose phone matches targetPhone, we call
// groupFetchAllParticipating() on THAT session to get an authoritative list
// of groups the target phone belongs to, and mark each group accordingly.
// If no such session exists, all groups come back with memberStatus="unknown".
async function listAdminGroupsWithMembership(sessionId, targetPhone) {
  const adminGroups = await listAdminGroups(sessionId);

  // Normalize the target phone
  const cleanPhone = String(targetPhone || "").replace(/\D/g, "");
  if (!cleanPhone) {
    return { groups: adminGroups.map(g => Object.assign({}, g, { memberStatus: "unknown" })), targetSessionFound: false };
  }

  // Find a connected session whose phone matches
  let targetSession = null;
  for (const [id, s] of sessions) {
    if (s && s.status === "connected") {
      const sessPhone = s.sock?.user?.id?.split(":")[0]?.split("@")[0] || "";
      if (sessPhone === cleanPhone) {
        targetSession = s;
        break;
      }
    }
  }

  if (!targetSession) {
    return {
      groups: adminGroups.map(g => Object.assign({}, g, { memberStatus: "unknown" })),
      targetSessionFound: false,
    };
  }

  // Fetch target session's groups and build a lookup map
  const targetGroupsMap = await targetSession.sock.groupFetchAllParticipating();
  const targetGroupsList = Object.values(targetGroupsMap || {});

  // Build { groupJid -> { isMember, isAdmin } }
  const membership = {};
  const targetJid = targetSession.sock?.user?.id || "";
  const targetLid = targetSession.sock?.user?.lid || "";
  const targetPhoneBase = extractBase(targetJid);
  const targetLidBase = extractBase(targetLid);

  for (const tg of targetGroupsList) {
    let isAdmin = false;
    if (Array.isArray(tg.participants)) {
      const me = tg.participants.find(p => {
        const pid = p.id || "";
        const pBase = extractBase(pid);
        const pDomain = extractDomain(pid);
        if (pid === targetJid || pid === targetLid) return true;
        if (pDomain === "s.whatsapp.net" && targetPhoneBase && pBase === targetPhoneBase) return true;
        if (pDomain === "lid" && targetLidBase && pBase === targetLidBase) return true;
        if (targetPhoneBase && pBase === targetPhoneBase) return true;
        if (targetLidBase && pBase === targetLidBase) return true;
        return false;
      });
      if (me && (me.admin === "admin" || me.admin === "superadmin")) isAdmin = true;
    }
    membership[tg.id] = { isMember: true, isAdmin };
  }

  const enrichedGroups = adminGroups.map(g => {
    const m = membership[g.jid];
    return Object.assign({}, g, {
      memberStatus: !m ? "not_member" : (m.isAdmin ? "admin" : "member"),
    });
  });

  return { groups: enrichedGroups, targetSessionFound: true };
}

// ===== List groups where the session is admin (lightweight, no extra IQ calls) =====
async function listAdminGroups(sessionId) {
  const session = await waitForSessionConnected(sessionId);
  if (!session || session.status !== "connected") {
    throw new Error("Sessão não conectada: " + sessionId);
  }
  const sock = session.sock;

  const { myJid, myLid, myPhoneBase, myLidBase } = getSessionIdentity(sock);

  const groupsMap = await sock.groupFetchAllParticipating();
  const groupList = Object.values(groupsMap || {});

  const results = [];
  for (const g of groupList) {
    let isAdmin = false;
    if (Array.isArray(g.participants)) {
      const me = g.participants.find(p => {
        const pid = p.id || "";
        const pBase = extractBase(pid);
        const pDomain = extractDomain(pid);
        if (pid === myJid || pid === myLid) return true;
        if (pDomain === "s.whatsapp.net" && myPhoneBase && pBase === myPhoneBase) return true;
        if (pDomain === "lid" && myLidBase && pBase === myLidBase) return true;
        if (myPhoneBase && pBase === myPhoneBase) return true;
        if (myLidBase && pBase === myLidBase) return true;
        return false;
      });
      if (me && (me.admin === "admin" || me.admin === "superadmin")) isAdmin = true;
    }
    if (isAdmin) {
      results.push({
        jid: g.id,
        name: g.subject || "(sem nome)",
        participants: Array.isArray(g.participants) ? g.participants.length : 0,
      });
    }
  }
  // Sort alphabetically (pt-BR locale) for easier scanning
  results.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return results;
}

// ===== Add a participant to all admin groups (temporary tool) =====
// options:
//   promoteToAdmin: boolean  — if true, promote the target to admin after adding
//   onlyJids: string[]       — if provided, ONLY process groups in this list (whitelist)
//   delaySec: number         — override delay between IQ calls (default 20s). Jitter ±3s.
//   onProgress: function     — called after each group is processed (job worker mode)
//   shouldCancel: function   — if returns true, stop the loop (job worker mode)
async function addParticipantToAllGroups(sessionId, phoneToAdd, skipJids = [], maxCalls = 10, options = {}) {
  const session = await waitForSessionConnected(sessionId);
  if (!session || session.status !== "connected") {
    throw new Error("Sessão não conectada: " + sessionId);
  }
  const sock = session.sock;
  const promoteToAdmin = options && options.promoteToAdmin === true;
  const onlyJids = options && Array.isArray(options.onlyJids) ? options.onlyJids : null;
  const onlyJidsSet = onlyJids ? new Set(onlyJids) : null;
  const delaySecOverride = typeof options.delaySec === "number" ? options.delaySec : 20;
  const addBaseDelayMs = Math.max(5, Math.min(300, delaySecOverride)) * 1000;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const shouldCancel = typeof options.shouldCancel === "function" ? options.shouldCancel : null;
  let cancelled = false;

  // Normalize target phone: digits only → JID @s.whatsapp.net
  const cleanPhone = String(phoneToAdd || "").replace(/\D/g, "");
  if (cleanPhone.length < 10) {
    throw new Error("Número inválido (use formato 5511999999999): " + phoneToAdd);
  }
  const targetJid = cleanPhone + "@s.whatsapp.net";

  // Verify the target number is on WhatsApp before touching any group
  try {
    const check = await sock.onWhatsApp(cleanPhone);
    if (!Array.isArray(check) || check.length === 0 || !check[0].exists) {
      throw new Error("Número não está no WhatsApp: " + cleanPhone);
    }
  } catch (e) {
    if (e.message && e.message.indexOf("não está no WhatsApp") >= 0) throw e;
    throw new Error("Falha ao verificar número no WhatsApp: " + e.message);
  }

  // Same identity setup as fetchGroupsWithInvites (for admin detection)
  const { myJid, myLid, myPhoneBase, myLidBase } = getSessionIdentity(sock);

  const skipSet = new Set(Array.isArray(skipJids) ? skipJids : []);
  // maxCalls counts INDIVIDUAL WhatsApp API calls (add + promote are 2 separate calls)
  // Set to Infinity from job workers (not bound by HTTP timeouts).
  const maxCallsThisBatch = (maxCalls === Infinity) ? Infinity : Math.max(1, Math.min(50, Number(maxCalls) || 10));
  let callsMade = 0;
  let batchLimitReached = false;

  const groupsMap = await sock.groupFetchAllParticipating();
  const groupList = Object.values(groupsMap || {});
  const total = groupList.length;

  const results = [];
  let rateLimited = false;
  let processed = 0;

  // Small helper to wait between IQ calls (unless we just hit rate limit or batch limit)
  // Uses the configured delay (default 20s) with ±3s jitter.
  async function rateLimitDelay() {
    if (!rateLimited && callsMade < maxCallsThisBatch) {
      const jitterMs = Math.floor((Math.random() - 0.5) * 6000); // ±3000ms
      await new Promise(r => setTimeout(r, addBaseDelayMs + jitterMs));
    }
  }

  for (const g of groupList) {
    processed++;

    // Cancellation check (job worker mode)
    if (shouldCancel && shouldCancel()) {
      cancelled = true;
      break;
    }

    // If a whitelist filter is active, skip groups not in the list (do not return them).
    // IMPORTANT: we still notify onProgress with row=null so the job worker can
    // advance `job.progress.done` for every iteration of the loop. Without this,
    // the progress bar stays pinned at the position of the last *matched* group
    // and never reaches the total even after the loop fully completes.
    if (onlyJidsSet && !onlyJidsSet.has(g.id)) {
      if (onProgress) {
        try {
          onProgress({ processed, total, row: null, rateLimited, callsMade });
        } catch (_) {}
      }
      continue;
    }

    // Check if "me" is admin in this group (same matching logic as fetchGroupsWithInvites)
    let isAdmin = false;
    if (Array.isArray(g.participants)) {
      const me = g.participants.find(p => {
        const pid = p.id || "";
        const pBase = extractBase(pid);
        const pDomain = extractDomain(pid);
        if (pid === myJid || pid === myLid) return true;
        if (pDomain === "s.whatsapp.net" && myPhoneBase && pBase === myPhoneBase) return true;
        if (pDomain === "lid" && myLidBase && pBase === myLidBase) return true;
        if (myPhoneBase && pBase === myPhoneBase) return true;
        if (myLidBase && pBase === myLidBase) return true;
        return false;
      });
      if (me && (me.admin === "admin" || me.admin === "superadmin")) isAdmin = true;
    }

    // Check if the target is ALREADY in the group AND if they're already admin
    let alreadyMember = false;
    let alreadyAdmin = false;
    if (Array.isArray(g.participants)) {
      const already = g.participants.find(p => {
        const pid = p.id || "";
        const pBase = extractBase(pid);
        return pid === targetJid || pBase === cleanPhone;
      });
      if (already) {
        alreadyMember = true;
        if (already.admin === "admin" || already.admin === "superadmin") alreadyAdmin = true;
      }
    }

    let status = null;
    let statusMessage = null;

    if (!isAdmin) {
      status = "not_admin";
      statusMessage = "Sem permissão (não é admin)";
    } else if (alreadyAdmin && promoteToAdmin) {
      status = "already_admin";
      statusMessage = "Já é admin";
    } else if (alreadyMember && !promoteToAdmin) {
      status = "already_member";
      statusMessage = "Já é membro";
    } else if (rateLimited) {
      status = "aborted_rate_limit";
      statusMessage = "Abortado por rate-limit";
    } else if (skipSet.has(g.id)) {
      status = "skipped";
    } else if (batchLimitReached) {
      status = "skipped";
    } else {
      // Decide which operations to perform
      let needAdd = !alreadyMember;
      let needPromote = promoteToAdmin && !alreadyAdmin;
      let addOk = false;

      // ===== STEP 1: ADD (if needed) =====
      if (needAdd) {
        try {
          const resp = await sock.groupParticipantsUpdate(g.id, [targetJid], "add");
          const entry = Array.isArray(resp) && resp.length > 0 ? resp[0] : null;
          const code = entry?.status || "";
          if (code === "200") {
            addOk = true;
          } else if (code === "409") {
            // Already member — proceed to promote if needed
            addOk = true;
            alreadyMember = true;
          } else if (code === "403") {
            status = "privacy_block";
            statusMessage = "Privacidade do número bloqueou";
            needPromote = false;
          } else if (code === "408") {
            status = "not_on_whatsapp";
            statusMessage = "Número não existe no WhatsApp";
            needPromote = false;
          } else {
            status = "error";
            statusMessage = "Código " + (code || "desconhecido") + " no add";
            needPromote = false;
          }
        } catch (e) {
          if (isRateLimitError(e)) {
            rateLimited = true;
            status = "aborted_rate_limit";
            statusMessage = "Abortado por rate-limit (no add)";
            console.warn("[BAILEYS] Rate limit during add — aborting at", processed, "of", total);
          } else {
            status = "error";
            statusMessage = e?.message || "Falha ao adicionar";
          }
          needPromote = false;
        }
        callsMade++;
        // Delay between add and the next call (either promote of same group or next group)
        await rateLimitDelay();
        if (callsMade >= maxCallsThisBatch) batchLimitReached = true;
      }

      // ===== STEP 2: PROMOTE (if needed and previous step did not fail) =====
      if (needPromote && !rateLimited && !batchLimitReached) {
        try {
          const resp = await sock.groupParticipantsUpdate(g.id, [targetJid], "promote");
          const entry = Array.isArray(resp) && resp.length > 0 ? resp[0] : null;
          const code = entry?.status || "";
          if (code === "200") {
            status = needAdd ? "added_and_promoted" : "promoted_only";
            statusMessage = needAdd ? "Adicionado e promovido a admin" : "Promovido a admin";
          } else {
            // promote failed but add (if any) succeeded
            status = needAdd ? "added_not_promoted" : "promote_error";
            statusMessage = "Adicionado mas promoção falhou (código " + (code || "desconhecido") + ")";
          }
        } catch (e) {
          if (isRateLimitError(e)) {
            rateLimited = true;
            status = needAdd ? "added_not_promoted" : "aborted_rate_limit";
            statusMessage = needAdd ? "Adicionado, promoção abortada por rate-limit" : "Abortado por rate-limit (no promote)";
            console.warn("[BAILEYS] Rate limit during promote — aborting at", processed, "of", total);
          } else {
            status = needAdd ? "added_not_promoted" : "promote_error";
            statusMessage = e?.message || "Falha ao promover";
          }
        }
        callsMade++;
        await rateLimitDelay();
        if (callsMade >= maxCallsThisBatch) batchLimitReached = true;
      } else if (needPromote && batchLimitReached) {
        // Batch limit hit between add and promote — mark as partial so the frontend retries promote
        status = needAdd ? "added_not_promoted" : "skipped";
        statusMessage = needAdd ? "Adicionado, promoção no próximo lote" : null;
      }

      // Simple "added" case (no promote requested, add succeeded)
      if (!status && addOk && !needPromote) {
        status = "added";
        statusMessage = "Adicionado";
      }
    }

    const rowOut = {
      jid: g.id,
      name: g.subject || "(sem nome)",
      participants: Array.isArray(g.participants) ? g.participants.length : 0,
      isAdmin,
      status,
      statusMessage,
    };
    results.push(rowOut);

    // Persist terminal statuses to the additions history. Skip "skipped"
    // entries (those are either filter excludes or batch-limit-reached).
    // Also skip "not_admin" since nothing happened there.
    if (status && status !== "skipped" && status !== "not_admin" && status !== "aborted_rate_limit") {
      upsertGroupAddition(sessionId, cleanPhone, rowOut);
    }

    // Notify progress observer (job worker), if any
    if (onProgress) {
      try {
        onProgress({
          processed,
          total,
          row: rowOut,
          rateLimited,
          callsMade,
        });
      } catch (_) {}
    }
  }

  return { groups: results, rateLimited, total, processed, callsMade, batchLimitReached, cancelled };
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

// ===== Process history sync data =====
async function processHistorySync(sessionId, msgs, syncedChats) {
  // Save chats to wa_chats table
  if (syncedChats && syncedChats.length > 0) {
    const chatBatch = syncedChats.map(c => ({
      session_id: sessionId,
      chat_jid: c.id,
      chat_name: c.name || c.id.split("@")[0],
      unread_count: c.unreadCount || 0,
      is_group: c.id.endsWith("@g.us"),
      last_message_timestamp: c.conversationTimestamp
        ? new Date((typeof c.conversationTimestamp === "object" ? (c.conversationTimestamp.low || c.conversationTimestamp) : c.conversationTimestamp) * 1000).toISOString()
        : null,
      pinned: c.pinned ? true : false,
      archived: c.archived ? true : false,
      muted_until: c.muteEndTime ? new Date(c.muteEndTime * 1000).toISOString() : null,
    }));
    for (let i = 0; i < chatBatch.length; i += 100) {
      try {
        await supaRest("/rest/v1/wa_chats", "POST", chatBatch.slice(i, i + 100), "resolution=merge-duplicates,return=minimal");
      } catch(e) {
        console.error("[BAILEYS] Chat batch save error:", e.message);
      }
    }
    console.log("[BAILEYS] Saved", chatBatch.length, "chats for", sessionId);
  }

  // Save historical messages in batches
  if (msgs && msgs.length > 0) {
    let saved = 0;
    const batch = [];
    for (const msg of msgs) {
      const jid = msg.key?.remoteJid;
      if (!jid || jid === "status@broadcast") continue;
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
      const ts = msg.messageTimestamp;
      const timestamp = ts ? new Date((typeof ts === "object" ? (ts.low || ts) : ts) * 1000).toISOString() : new Date().toISOString();

      batch.push({
        session_id: sessionId,
        message_id: msg.key.id,
        chat_jid: jid,
        chat_name: msg.pushName || jid.split("@")[0],
        from_me: msg.key.fromMe || false,
        sender_name: msg.pushName || "",
        sender_jid: msg.key.participant || jid,
        body: body,
        media_type: mediaType,
        timestamp: timestamp,
      });
    }
    for (let i = 0; i < batch.length; i += 200) {
      try {
        await supaRest("/rest/v1/wa_messages", "POST", batch.slice(i, i + 200), "resolution=merge-duplicates,return=minimal");
        saved += batch.slice(i, i + 200).length;
      } catch(e) {
        console.error("[BAILEYS] History batch save error:", e.message);
      }
    }
    console.log("[BAILEYS] History sync saved", saved, "messages for", sessionId);

    // Enqueue photo downloads for contacts seen in messages
    const uniqueJids = [...new Set(batch.map(m => m.chat_jid).filter(j => j && j !== "status@broadcast"))];
    enqueuePhotos(sessionId, uniqueJids);
  }

  // Enqueue photo downloads for synced chats
  if (syncedChats && syncedChats.length > 0) {
    enqueuePhotos(sessionId, syncedChats.map(c => c.id));
  }
}

// ===== Profile picture proxy (with in-memory cache) =====
const _picCache = new Map(); // jid -> { url, ts }
const PIC_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getProfilePicture(sessionId, jid) {
  const cacheKey = sessionId + ":" + jid;
  const cached = _picCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < PIC_CACHE_TTL) return cached.url;

  const s = sessions.get(sessionId);
  if (!s || s.status !== "connected") return null;

  try {
    const url = await s.sock.profilePictureUrl(jid, "image");
    _picCache.set(cacheKey, { url, ts: Date.now() });
    return url;
  } catch (e) {
    // No profile picture or privacy settings block it
    _picCache.set(cacheKey, { url: null, ts: Date.now() });
    return null;
  }
}

// ===== Mark chat messages as read =====
async function readChatMessages(sessionId, chatJid) {
  const s = sessions.get(sessionId);
  if (!s || s.status !== "connected") return false;

  try {
    // Fetch latest message keys from DB to mark as read
    const msgs = await supaRest(
      "/rest/v1/wa_messages?session_id=eq." + sessionId +
      "&chat_jid=eq." + encodeURIComponent(chatJid) +
      "&from_me=eq.false&order=timestamp.desc&limit=5" +
      "&select=message_id,chat_jid,sender_jid"
    );
    if (!msgs || msgs.length === 0) return true;

    const keys = msgs.map(m => ({
      remoteJid: m.chat_jid,
      id: m.message_id,
      participant: m.sender_jid || undefined,
    }));

    await s.sock.readMessages(keys);
    return true;
  } catch (e) {
    console.error("[BAILEYS] readChatMessages error:", e.message);
    return false;
  }
}

// ===== Enqueue photo downloads =====
async function enqueuePhotos(sessionId, jids, force = false) {
  if (!jids || !jids.length) return;
  // Filter out broadcast and invalid JIDs
  const valid = jids.filter(j => j && j !== "status@broadcast" && (j.includes("@s.whatsapp.net") || j.includes("@g.us")));
  if (!valid.length) return;

  const rows = valid.map(jid => ({
    session_id: sessionId,
    jid: jid,
    status: "pending",
  }));

  // If force, reset existing entries
  if (force) {
    for (const jid of valid) {
      await supaRest(
        "/rest/v1/wa_photo_queue?session_id=eq." + sessionId + "&jid=eq." + encodeURIComponent(jid),
        "PATCH", { status: "pending", attempts: 0, error: null }, "return=minimal"
      ).catch(() => {});
    }
  }

  // Insert new entries (ignore duplicates)
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await supaRest("/rest/v1/wa_photo_queue", "POST", chunk,
      "resolution=ignore-duplicates,return=minimal").catch(() => {});
  }
}

// ===== Sync group metadata (description, participants, settings) =====
async function syncGroupMetadata(sessionId, sock) {
  console.log("[BAILEYS] Syncing group metadata for:", sessionId);
  try {
    const groupsMap = await sock.groupFetchAllParticipating();
    const groups = Object.values(groupsMap || {});
    console.log("[BAILEYS] Found", groups.length, "groups for", sessionId);

    const now = new Date().toISOString();

    for (const g of groups) {
      // Update wa_chats with group metadata
      try {
        await supaRest(
          "/rest/v1/wa_chats?session_id=eq." + sessionId + "&chat_jid=eq." + encodeURIComponent(g.id),
          "PATCH", {
            chat_name: g.subject || g.id.split("@")[0],
            description: g.desc || null,
            participants_count: g.participants?.length || 0,
            is_read_only: g.announce === true || g.announce === "true",
            ephemeral_duration: g.ephemeralDuration || 0,
          }, "return=minimal"
        );
      } catch (e) { /* chat may not exist yet */ }

      // Upsert group members
      if (g.participants && g.participants.length > 0) {
        const memberBatch = g.participants.map(p => ({
          group_jid: g.id,
          group_name: g.subject || "",
          member_phone: p.id.split("@")[0].split(":")[0],
          member_name: "",
          role: p.admin === "superadmin" ? "admin" : (p.admin || "member"),
          first_seen: now,
          last_seen: now,
        }));

        for (let i = 0; i < memberBatch.length; i += 100) {
          const chunk = memberBatch.slice(i, i + 100);
          await supaRest("/rest/v1/group_members", "POST", chunk,
            "resolution=merge-duplicates,return=minimal").catch(() => {});
        }

        // Enqueue photos for all group members
        enqueuePhotos(sessionId, g.participants.map(p => p.id));
      }
    }

    // Enqueue photos for all groups
    enqueuePhotos(sessionId, groups.map(g => g.id));

    console.log("[BAILEYS] Group metadata sync done for:", sessionId, "groups:", groups.length);
  } catch (e) {
    console.error("[BAILEYS] syncGroupMetadata error:", e.message);
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
  fetchGroupsWithInvites,
  addParticipantToAllGroups,
  listAdminGroups,
  listAdminGroupsWithMembership,
  getCachedGroupLinks,
  getCachedGroupAdditions,
  importLocalCache,
  getProfilePicture,
  readChatMessages,
};
