// ===== Baileys Multi-Session Manager =====
// Manages multiple WhatsApp connections via Baileys library.
// Sessions are persisted to Supabase (creds as JSONB).

const { default: makeWASocket, DisconnectReason, makeCacheableSignalKeyStore, initAuthCreds, BufferJSON, downloadMediaMessage, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const pino = require("pino");
const { supaRest } = require("./supabase");
// Activity log: importação lazy pra evitar ciclo (activity-log depende de supabase,
// e vários módulos já importam baileys). Acessar via _getActivityLog() quando usar.
let _activityLog = null;
function _getActivityLog() {
  if (!_activityLog) _activityLog = require("./activity-log");
  return _activityLog;
}
function _logEvent(opts) {
  try { _getActivityLog().logEvent(opts); } catch (e) { /* never block flow on log */ }
}
// IQ counter — PR 2. Conta stanzas IQ que a sessão emite via monkey-patch
// em sock.query. Dados in-memory, snapshot periódico via logEvent(iq:snapshot).
const _iqCounter = require("./iq-counter");

const logger = pino({ level: "warn" });

// In-memory session store: sessionId -> { sock, status, qr }
const sessions = new Map();
// Reconnection attempt counters: sessionId -> count
const reconnectAttempts = new Map();
const MAX_RECONNECT_ATTEMPTS = 5;

// Rate-limit registry — survives session recreation on reconnect (not PM2 restart).
// Keyed by sessionId, holds { hitAt: epoch_ms } when the last rate-limit was detected.
const rateLimitRegistry = new Map();
const RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min
function markRateLimit(sessionId) {
  rateLimitRegistry.set(sessionId, { hitAt: Date.now() });
}
function getRateLimitStatus(sessionId) {
  const entry = rateLimitRegistry.get(sessionId);
  if (!entry) return null;
  const age = Date.now() - entry.hitAt;
  if (age >= RATE_LIMIT_COOLDOWN_MS) {
    rateLimitRegistry.delete(sessionId);
    return null;
  }
  return { hitAt: entry.hitAt, remainingMs: RATE_LIMIT_COOLDOWN_MS - age };
}

// ===== Session Quarantine =====
// Puts a session in "airplane mode": blocks IQ-generating handlers and HTTP
// routes without disconnecting the socket. Used by createGroupsFromList to
// silence ambient IQ traffic (incoming group message → groupMetadata fetch,
// participant update → groupMetadata refresh, ezapweb routes) while a
// delicate groupCreate sequence runs.
//
// Persistence is deliberately in-memory: on PM2 restart every session starts
// fresh (no stuck quarantine), and runtime release is instant.
const sessionQuarantine = new Map(); // sessionId -> { enteredAt, reason }
function quarantineSession(sessionId, reason) {
  if (sessionQuarantine.has(sessionId)) return;
  sessionQuarantine.set(sessionId, { enteredAt: Date.now(), reason: reason || "manual" });
  emit("session:quarantine", { sessionId, reason: reason || "manual" });
  console.warn("[QUARANTINE] " + sessionId + " entered quarantine: " + (reason || "manual"));
  const s = sessions.get(sessionId);
  _logEvent({
    type: "session:quarantine_enter",
    level: "info",
    message: "Quarentena ativa: motivo=" + (reason || "manual"),
    sessionId,
    sessionLabel: s ? s.label : null,
    sessionPhone: s ? s.phone : null,
    metadata: { reason: reason || "manual" },
  });
}
function releaseSession(sessionId) {
  if (!sessionQuarantine.has(sessionId)) return;
  const q = sessionQuarantine.get(sessionId);
  sessionQuarantine.delete(sessionId);
  emit("session:quarantine:release", { sessionId });
  console.log("[QUARANTINE] " + sessionId + " released");
  const s = sessions.get(sessionId);
  _logEvent({
    type: "session:quarantine_release",
    level: "info",
    message: "Quarentena liberada (durou " + Math.round((Date.now() - q.enteredAt) / 1000) + "s)",
    sessionId,
    sessionLabel: s ? s.label : null,
    sessionPhone: s ? s.phone : null,
    metadata: { durationMs: Date.now() - q.enteredAt, reason: q.reason },
  });
}
function isQuarantined(sessionId) {
  return sessionQuarantine.has(sessionId);
}
function getQuarantineStatus(sessionId) {
  const q = sessionQuarantine.get(sessionId);
  if (!q) return null;
  return { enteredAt: new Date(q.enteredAt).toISOString(), reason: q.reason, durationMs: Date.now() - q.enteredAt };
}

// Cached WA Web protocol version. Baileys hardcodes a version that goes stale
// as WhatsApp ships updates — when stale we get code 405 on connect. Refresh
// from the live endpoint every 6 hours and reuse across sessions.
let _cachedWaVersion = null;
let _cachedWaVersionAt = 0;
const WA_VERSION_TTL_MS = 6 * 60 * 60 * 1000;
async function getWaVersion() {
  const now = Date.now();
  if (_cachedWaVersion && (now - _cachedWaVersionAt) < WA_VERSION_TTL_MS) {
    return _cachedWaVersion;
  }
  try {
    const r = await fetchLatestBaileysVersion();
    _cachedWaVersion = r.version;
    _cachedWaVersionAt = now;
    console.log("[BAILEYS] Using WA Web version:", r.version.join("."), "(latest:", r.isLatest, ")");
  } catch (e) {
    console.warn("[BAILEYS] fetchLatestBaileysVersion failed, falling back to library default:", e.message);
    _cachedWaVersion = null;
  }
  return _cachedWaVersion;
}

// Event emitter for WebSocket broadcasting
let _io = null;
function setIO(io) { _io = io; }

function emit(event, data) {
  if (_io) _io.emit(event, data);
}

function normalizePhone(raw) {
  return String(raw || "").replace(/\D/g, "");
}

function extractParticipantPhone(msg) {
  return normalizePhone(
    msg?.key?.participantPn
    || msg?.participantPn
    || ""
  );
}

async function persistLidPhoneMapping(sessionId, lidJid, phone, contactName = "") {
  const normalizedPhone = normalizePhone(phone);
  if (!lidJid || !lidJid.endsWith("@lid") || !normalizedPhone) return;

  try {
    await supaRest(
      "/rest/v1/lid_phone_map?on_conflict=lid",
      "POST",
      {
        lid: lidJid,
        phone: normalizedPhone,
        contact_name: contactName || null,
        updated_at: new Date().toISOString(),
      },
      "resolution=merge-duplicates,return=minimal"
    );
  } catch (e) {
    console.error("[BAILEYS] lid_phone_map upsert error:", e.message);
  }

  const contactRow = {
    session_id: sessionId,
    contact_jid: lidJid,
    phone: normalizedPhone,
    is_group: false,
    synced_at: new Date().toISOString(),
  };
  if (contactName) contactRow.push_name = contactName;

  try {
    await supaRest(
      "/rest/v1/wa_contacts?on_conflict=session_id,contact_jid",
      "POST",
      [contactRow],
      "resolution=merge-duplicates,return=minimal"
    );
  } catch (e) {
    console.error("[BAILEYS] wa_contacts LID phone upsert error:", e.message);
  }
}

async function persistLidLinkedJid(sessionId, lidJid, linkedJid, contactName = "") {
  if (!lidJid || !lidJid.endsWith("@lid") || !linkedJid) return;

  const linkedPhone = normalizePhone(linkedJid);
  const contactRow = {
    session_id: sessionId,
    contact_jid: lidJid,
    linked_jid: linkedJid,
    is_group: false,
    synced_at: new Date().toISOString(),
  };
  if (linkedPhone) contactRow.phone = linkedPhone;
  if (contactName) contactRow.push_name = contactName;

  try {
    await supaRest(
      "/rest/v1/wa_contacts?on_conflict=session_id,contact_jid",
      "POST",
      [contactRow],
      "resolution=merge-duplicates,return=minimal"
    );
  } catch (e) {
    console.error("[BAILEYS] wa_contacts linked_jid upsert error:", e.message);
  }

  if (linkedPhone) {
    await persistLidPhoneMapping(sessionId, lidJid, linkedPhone, contactName);
  }
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

  // Pin WA Web protocol version to the latest known — fixes code 405 on
  // connect when WhatsApp ships a protocol update that the library default
  // is no longer compatible with.
  const waVersion = await getWaVersion();

  const sockOpts = {
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
  };
  if (waVersion) sockOpts.version = waVersion;
  const sock = makeWASocket(sockOpts);

  // PR 2: monkey-patch sock.query pra contar IQs reais emitidos pela sessão.
  // Preserva `this` e spread de args. Defensivo (try/catch interno) —
  // NUNCA deve quebrar o fluxo do Baileys. Se sock.query mudar de shape
  // em versão futura, attachToSock detecta e loga sem patchar.
  try {
    _iqCounter.attachToSock(sessionId, sock);
  } catch (e) {
    console.warn("[BAILEYS] iq-counter attach failed for", sessionId, e.message);
  }

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
      // Detecta se é reconnect (já havia attempts) pra logar como session:reconnected
      // em vez de session:connected. Permite fechar o ciclo "transient_drop → reconnected"
      // visualmente no sidebar.
      const wasReconnecting = (reconnectAttempts.get(sessionId) || 0) > 0;

      session.status = "connected";
      session.qr = null;
      session.connectedAt = Date.now();
      reconnectAttempts.delete(sessionId); // Reset counter on success
      const phone = sock.user?.id?.split(":")[0] || sock.user?.id?.split("@")[0] || "";
      await updateSessionStatus(sessionId, "connected", phone);
      await saveSessionCreds(sessionId, authState.creds);
      emit("session:connected", { sessionId, phone });
      console.log("[BAILEYS] Connected:", sessionId, "phone:", phone);
      // PR 2: popular metadata do iq-counter com label/phone — snapshots subsequentes
      // virão enriquecidos. Label vem do session in-memory (populada em startSession).
      try { _iqCounter.setMeta(sessionId, session.label || null, phone || null); }
      catch (_) {}

      // Activity log: reconnected event (só se foi reconnect — nao primeira conexão)
      if (wasReconnecting) {
        _logEvent({
          type: "session:reconnected",
          level: "info",
          message: "Sessão voltou ao ar após queda",
          sessionId,
          sessionLabel: session.label || null,
          sessionPhone: phone || null,
          metadata: { phone },
        });
      }

      // Sync group metadata (description, participants) in background —
      // but SKIP if the session has skip_group_sync=true in wa_sessions.
      // Heavy sessions (Escalada 719 groups, CX, CX2, Follow Up) have
      // this flag set to avoid the batch IQ on every reconnect. The toggle
      // is controllable per-session via the grupos.html sessions card.
      try {
        const syncCheck = await supaRest(
          "/rest/v1/wa_sessions?id=eq." + sessionId + "&select=skip_group_sync"
        ).catch(() => []);
        const skipSync = syncCheck && syncCheck[0] && syncCheck[0].skip_group_sync === true;
        if (skipSync) {
          console.log("[BAILEYS] Skipping group metadata sync for", sessionId, "(skip_group_sync=true)");
        } else {
          syncGroupMetadata(sessionId, sock).catch(e =>
            console.error("[BAILEYS] syncGroupMetadata error:", e.message)
          );
        }
      } catch (_) {
        // If the check fails, sync anyway (safe default)
        syncGroupMetadata(sessionId, sock).catch(() => {});
      }
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMsg = lastDisconnect?.error?.message || "";
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 403;

      console.log("[BAILEYS] Disconnected:", sessionId, "code:", statusCode, "reconnect:", shouldReconnect);

      // Activity log: stream:error capture — registra todas as disconnects com
      // detalhe (code + message). Casos críticos (device_removed, rate-overlimit,
      // loggedOut) ganham level=critical pra aparecer em vermelho na sidebar.
      // Pattern de detecção: statusCode + errorMsg. Conflict types estão em
      // errorMsg tipo "conflict type=device_removed".
      try {
        const existing = sessions.get(sessionId);
        const snapshot = {
          sessionId,
          sessionLabel: existing ? existing.label : null,
          sessionPhone: existing ? existing.phone : null,
        };
        // Classificação da causa do close:
        // - CRITICAL / STREAM_ERROR: device_removed, loggedOut, 403, rate-overlimit
        //   → level critical/error, aparece vermelho na sidebar, exige atenção
        // - TRANSIENT: 503, 408, 428, connectionLost, "Connection Closed"
        //   → level info, aparece cinza/amarelo, reconecta automaticamente
        // - OUTROS: unknown
        let evType = "session:disconnected";
        let evLevel = "info";
        let evMsg = "Sessão desconectou (code=" + (statusCode || "?") + ")";

        const errLower = String(errorMsg || "").toLowerCase();
        const isDeviceRemoved = errLower.includes("device_removed") || errLower.includes("device removed");
        const isRateOverlimit = errLower.includes("rate-overlimit");
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
        const isForbidden = statusCode === 403;
        // Transient: códigos HTTP 503/408/428/500 ou connectionLost/restart-required.
        const isTransient = (
          statusCode === 503 ||
          statusCode === 500 ||
          statusCode === 408 ||
          statusCode === 428 ||
          statusCode === DisconnectReason.connectionLost ||
          statusCode === DisconnectReason.restartRequired ||
          errLower.includes("connection closed") ||
          errLower.includes("restart required") ||
          errLower.includes("connection terminated")
        );

        if (isDeviceRemoved) {
          evType = "wa:stream_error";
          evLevel = "critical";
          evMsg = "⛔ device_removed — linked device expulso pelo WhatsApp (requer QR novo)";
        } else if (isRateOverlimit) {
          evType = "wa:stream_error";
          evLevel = "error";
          evMsg = "🔴 rate-overlimit stanza — WhatsApp bloqueou explicitamente";
        } else if (isLoggedOut) {
          evType = "wa:stream_error";
          evLevel = "critical";
          evMsg = "⛔ loggedOut — QR novo necessário";
        } else if (isForbidden) {
          evType = "wa:stream_error";
          evLevel = "error";
          evMsg = "Forbidden (403) — banimento ou restrição";
        } else if (isTransient && shouldReconnect) {
          // Queda transiente — callWithTransientRetry lida no hot path,
          // conexão reconecta automaticamente em segundos.
          evType = "session:transient_drop";
          evLevel = "info";
          evMsg = "📡 Queda temporária (code=" + (statusCode || "?") + ") — reconectando automaticamente…";
        }

        _logEvent({
          type: evType,
          level: evLevel,
          message: evMsg,
          ...snapshot,
          metadata: {
            statusCode: statusCode || null,
            errorMessage: errorMsg || null,
            shouldReconnect,
            willRetry: shouldReconnect,
            isTransient,
          },
        });
      } catch (_) {}

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
        await supaRest(
          "/rest/v1/wa_chats?on_conflict=session_id,chat_jid",
          "POST",
          chatBatch.slice(i, i + 100),
          "resolution=merge-duplicates,return=minimal"
        );
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
      await supaRest(
        "/rest/v1/wa_contacts?on_conflict=session_id,contact_jid",
        "POST",
        contactBatch.slice(i, i + 100),
        "resolution=merge-duplicates,return=minimal"
      ).catch(() => {});
    }
    // No bulk photo enqueue here — photos are fetched lazily when the contact
    // actually sends a message (see handleIncomingMessage). Dumping thousands
    // of profilePictureUrl IQs on reconnect is what got accounts silently
    // rate-limited by WhatsApp in the first place.
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
        await supaRest(
          "/rest/v1/wa_contacts?on_conflict=session_id,contact_jid",
          "POST",
          chunk,
          "resolution=merge-duplicates,return=minimal"
        );
      } catch (e) {
        console.error("[BAILEYS] contacts.upsert batch error:", e.message);
      }
    }

    // No bulk photo enqueue — lazy on first incoming message instead.
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
        await supaRest(
          "/rest/v1/wa_contacts?on_conflict=session_id,contact_jid",
          "POST",
          [{
            session_id: sessionId,
            contact_jid: c.id,
            phone: c.id.split("@")[0].split(":")[0],
            is_group: c.id.endsWith("@g.us"),
            ...patch,
          }],
          "resolution=merge-duplicates,return=minimal"
        );
      } catch (e) {
        console.error("[BAILEYS] contacts.update error:", e.message);
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
          await supaRest(
            "/rest/v1/group_members?on_conflict=group_jid,member_phone",
            "POST",
            [{
              group_jid: groupJid,
              member_phone: phone,
              member_name: "",
              role: "member",
              first_seen: now,
              last_seen: now,
              left_at: null,
            }],
            "resolution=merge-duplicates,return=minimal"
          ).catch(() => {});
        } catch (e) { /* ignore */ }

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

    // Update participants count in wa_chats — only when the session isn't in
    // quarantine. During createGroupsFromList the groupCreate itself triggers
    // this event for each newly-added participant; the groupMetadata refresh
    // competes for the WhatsApp IQ budget we're trying to protect.
    if (!isQuarantined(sessionId)) {
      try {
        const meta = await sock.groupMetadata(groupJid).catch(() => null);
        if (meta && meta.participants) {
          await supaRest(
            "/rest/v1/wa_chats?session_id=eq." + sessionId + "&chat_jid=eq." + encodeURIComponent(groupJid),
            "PATCH", { participants_count: meta.participants.length }, "return=minimal"
          );
        }
      } catch (e) { /* ignore */ }
    }
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
        await supaRest(
          "/rest/v1/wa_chats?on_conflict=session_id,chat_jid",
          "POST",
          [{
            session_id: sessionId,
            chat_jid: g.id,
            chat_name: g.subject || g.id.split("@")[0],
            is_group: true,
            participants_count: g.participants ? g.participants.length : 0,
            synced_at: new Date().toISOString(),
          }],
          "resolution=merge-duplicates,return=minimal"
        );
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
            await supaRest(
              "/rest/v1/group_members?on_conflict=group_jid,member_phone",
              "POST",
              members.slice(i, i + 100),
              "resolution=merge-duplicates,return=minimal"
            );
          } catch(e) {}
        }
      }
    }
    emit("groups:upsert", { sessionId, groups: groups.map(g => ({ jid: g.id, subject: g.subject })) });
  });

  // ===== Chats phone number share — LID to JID mapping =====
  sock.ev.on("chats.phoneNumberShare", async (data) => {
    if (!data || !data.lid || !data.jid) return;
    console.log("[BAILEYS] phoneNumberShare:", data.lid, "->", data.jid, "for", sessionId);
    await persistLidLinkedJid(sessionId, data.lid, data.jid);
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
  const senderJid = msg.key.participant || jid;
  const participantPhone = extractParticipantPhone(msg);

  if (participantPhone && senderJid.endsWith("@lid")) {
    persistLidPhoneMapping(sessionId, senderJid, participantPhone, msg.pushName || "").catch(() => {});
  }

  // DHIEGO.AI hook — only active on the configured assistant session. Runs
  // fire-and-forget so the normal message persistence path is never blocked
  // by LLM latency. Errors are swallowed inside dhiegoAi.maybeHandle.
  if (isRealTime) {
    try {
      const dhiegoAi = require("./dhiego-ai");
      dhiegoAi.maybeHandle(sessionId, msg, sock).catch(e => {
        console.error("[DHIEGO.AI] unhandled:", e.message);
      });
    } catch (_) { /* module might fail to load if deps missing — don't break baileys */ }
  }

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
      // Group: prefer cached chat_name from wa_chats to avoid a groupMetadata
      // IQ on every incoming group message. The groups.update / groups.upsert
      // handlers keep wa_chats.chat_name in sync on subject changes, so the
      // cache is fresh. Falls back to a live groupMetadata fetch only when
      // the row doesn't exist AND the session isn't in quarantine. This
      // previously fired ~dozens of IQs/min on busy business accounts and
      // was the biggest silent leak into WhatsApp's rate budget during
      // createGroupsFromList.
      try {
        const cachedRows = await supaRest(
          "/rest/v1/wa_chats?session_id=eq." + sessionId +
          "&chat_jid=eq." + encodeURIComponent(jid) +
          "&select=chat_name&limit=1"
        ).catch(() => null);
        if (cachedRows && cachedRows[0] && cachedRows[0].chat_name) {
          chatName = cachedRows[0].chat_name;
        } else if (!isQuarantined(sessionId)) {
          try {
            const groupMeta = await sock.groupMetadata(jid);
            chatName = groupMeta?.subject || jid.split("@")[0];
          } catch(e) {
            chatName = jid.split("@")[0];
          }
        } else {
          chatName = jid.split("@")[0];
        }
      } catch(e) {
        chatName = jid.split("@")[0];
      }
    } else if (msg.key.fromMe) {
      // Outgoing message: pushName is OUR name, not the contact's
      // Try to get contact name from wa_contacts or wa_chats
      try {
        const rows = await supaRest(
          "/rest/v1/wa_contacts?session_id=eq." + sessionId +
          "&contact_jid=eq." + encodeURIComponent(jid) +
          "&select=name,push_name&limit=1"
        );
        if (rows && rows[0]) {
          chatName = rows[0].name || rows[0].push_name || jid.split("@")[0];
        } else {
          // Fallback to wa_chats
          const chatRows = await supaRest(
            "/rest/v1/wa_chats?session_id=eq." + sessionId +
            "&chat_jid=eq." + encodeURIComponent(jid) +
            "&select=chat_name&limit=1"
          );
          chatName = (chatRows && chatRows[0]) ? chatRows[0].chat_name : jid.split("@")[0];
        }
      } catch(e) {
        chatName = jid.split("@")[0];
      }
    } else {
      // Incoming message: pushName IS the contact's name
      chatName = msg.pushName || jid.split("@")[0];
    }
  } catch(e) {}

  // Parse timestamp (handle protobuf Long objects)
  const rawTs = msg.messageTimestamp;
  const tsSeconds = rawTs ? (typeof rawTs === "object" ? (rawTs.low || rawTs.toNumber?.() || 0) : rawTs) : 0;
  const timestamp = tsSeconds > 0 ? new Date(tsSeconds * 1000).toISOString() : new Date().toISOString();

  // Save to Supabase. NOTE: on_conflict=session_id,message_id is REQUIRED
  // for resolution=merge-duplicates to target the idx_wa_messages_dedup
  // unique constraint instead of the primary key. Without it, PostgREST
  // tries a plain INSERT and every duplicate message returns 409, creating
  // a flood of wasted round-trips that saturates Kong/PostgREST.
  await supaRest(
    "/rest/v1/wa_messages?on_conflict=session_id,message_id",
    "POST",
    {
      session_id: sessionId,
      message_id: msg.key.id,
      chat_jid: jid,
      chat_name: chatName,
      from_me: msg.key.fromMe || false,
      sender_name: msg.pushName || "",
      sender_jid: senderJid,
      body: body,
      media_type: mediaType,
      timestamp: timestamp,
    },
    "resolution=merge-duplicates,return=minimal"
  );

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
      timestamp: timestamp,
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
    }

    if (jid.includes("@lid")) {
      try {
        const resolved = await resolveLid(sessionId, jid);
        if (resolved && resolved.jid && !resolved.jid.endsWith("@lid")) {
          jid = resolved.jid;
          console.log("[BAILEYS] Resolved from LID registry to:", jid);
        }
      } catch (e) {
        console.log("[BAILEYS] LID registry resolve failed:", e.message);
      }
    }

    if (jid.includes("@lid")) {
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
    await supaRest(
      "/rest/v1/wa_messages?on_conflict=session_id,message_id",
      "POST",
      {
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
      },
      "resolution=merge-duplicates,return=minimal"
    );
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

// Resolve session_id → JID canônico via sock.user.id. Retorna null se a
// sessão não estiver conectada ou o sock ainda não tiver user. Usado quando
// o frontend manda helpers/admins como session_id (ex: spec.helperSessionIds)
// em vez de phone cru — elimina o problema de wa_sessions.phone ter LID salvo.
function resolveSessionToJid(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || !s.sock || !s.sock.user) return null;
  const uid = String(s.sock.user.id || "");
  if (!uid) return null;
  // uid vem tipicamente como "5511xxx:28@s.whatsapp.net" ou "5511xxx@s.whatsapp.net".
  // Extraímos os dígitos antes de ":" ou "@" e reconstruimos um JID limpo.
  const digits = uid.split(":")[0].split("@")[0];
  if (!digits || digits.length < 10 || digits.length > 13) return null;
  return digits + "@s.whatsapp.net";
}

// Detecta LID (Linked ID) disfarçado de telefone. Telefones BR válidos têm
// 10-13 dígitos (com ou sem DDI 55). LIDs típicos têm 14-19 dígitos e NÃO
// funcionam como JID `{digits}@s.whatsapp.net` — passam pro
// groupParticipantsUpdate, o WhatsApp rejeita a stanza e pode derrubar a
// sessão com loggedOut 401 (bug Aline/Priscila/Luis 20/04). Filtro LOCAL,
// sem depender de sock.onWhatsApp (que retorna exists=true se o LID estiver
// no contact store da sessão).
function isLikelyLid(phoneOrDigits) {
  const d = String(phoneOrDigits || "").replace(/\D/g, "");
  if (d.length < 10 || d.length > 13) return true; // fora do range BR = suspeito
  return false;
}

// Detect transient connection errors that a retry can recover from.
// These happen when the Baileys socket disconnects mid-operation (Bad MAC,
// auto-reconnect, WebSocket ping timeout) — the driver will reconnect in
// seconds, so waiting + retrying typically works.
function isTransientConnectionError(e) {
  const msg = (e?.message || "").toLowerCase();
  if (!msg) return false;
  return msg.includes("connection closed")
    || msg.includes("connection lost")
    || msg.includes("websocket")
    || msg.includes("bad mac")
    || msg.includes("prekeyerror")
    || msg.includes("no session record")
    || msg.includes("timed out")
    || msg.includes("timeout")
    || msg.includes("socket")
    || msg.includes("stream errored");
}

// Wrap a Baileys call with retry on transient connection errors. Waits for
// the session to reconnect between attempts (up to waitForSessionConnected).
// Does NOT retry rate-limit errors (those must abort). Takes an async
// function that receives the *current* sock (refreshed after reconnect).
//
// Usage: await callWithTransientRetry(sessionId, async (sock) => sock.groupCreate(name, jids))
async function callWithTransientRetry(sessionId, fn, opts = {}) {
  const RETRY_DELAYS = opts.retryDelays || [15000, 20000, 25000]; // 15s/20s/25s
  const label = opts.label || "baileys_call";
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const session = sessions.get(sessionId);
      if (!session || !session.sock) {
        if (attempt >= RETRY_DELAYS.length) throw new Error("Sessão não disponível");
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }
      return await fn(session.sock);
    } catch (e) {
      lastError = e;
      if (isRateLimitError(e)) throw e; // don't retry rate-limit
      if (!isTransientConnectionError(e) || attempt >= RETRY_DELAYS.length) throw e;
      console.log(`[BAILEYS] ${label} transient fail attempt ${attempt + 1}/${RETRY_DELAYS.length + 1}: ${e.message}. Waiting ${RETRY_DELAYS[attempt]}ms + reconnect…`);
      await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
      // Tenta aguardar reconexão (até 30s); se não rolar, a próxima iteração vai pular
      try {
        await waitForSessionConnected(sessionId, 30000);
      } catch (_) { /* segue pra próxima tentativa */ }
    }
  }
  throw lastError;
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
  // 1. Get admin groups for the SESSION (the one that will do the adding)
  // listAdminGroups already calls groupFetchAllParticipating — no extra API calls needed
  const session = await waitForSessionConnected(sessionId);
  if (!session || session.status !== "connected") {
    throw new Error("Sessão não conectada: " + sessionId);
  }
  const sock = session.sock;
  const { myJid, myLid, myPhoneBase, myLidBase } = getSessionIdentity(sock);

  const groupsMap = await sock.groupFetchAllParticipating();
  const groupList = Object.values(groupsMap || {});

  // Normalize target phone
  const cleanPhone = String(targetPhone || "").replace(/\D/g, "");
  const targetJid = cleanPhone ? cleanPhone + "@s.whatsapp.net" : "";

  // 2. Filter groups where session is admin AND check if target is already member
  // This uses ONLY the session's data (no calls to target session = no rate limit)
  const adminGroups = [];

  for (const g of groupList) {
    // Check if session is admin
    let isAdmin = false;
    let targetMemberStatus = "unknown";

    if (Array.isArray(g.participants)) {
      // Check session admin status
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

      // Check if target phone is already a participant in this group
      if (cleanPhone) {
        const targetInGroup = g.participants.find(p => {
          const pid = p.id || "";
          const pBase = extractBase(pid);
          return pid === targetJid || pBase === cleanPhone;
        });
        if (targetInGroup) {
          targetMemberStatus = (targetInGroup.admin === "admin" || targetInGroup.admin === "superadmin") ? "admin" : "member";
        } else {
          targetMemberStatus = "not_member";
        }
      }
    }

    if (isAdmin) {
      adminGroups.push({
        jid: g.id,
        name: g.subject || g.id.split("@")[0],
        participants: Array.isArray(g.participants) ? g.participants.length : 0,
        memberStatus: targetMemberStatus,
      });
    }
  }

  // Sort by name (pt-BR locale)
  adminGroups.sort((a, b) => (a.name || "").localeCompare(b.name || "", "pt-BR"));

  return { groups: adminGroups, targetSessionFound: !!cleanPhone };
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

// ===== Bulk group creation helpers =====

const GROUP_CREATE_HOURLY_CAP = Number(process.env.GROUP_CREATE_HOURLY_CAP) || 6;
const HOUR_MS = 60 * 60 * 1000;

// Sleep in small slices so shouldCancel and progress heartbeats are responsive.
// Reports wait phase via onProgress({ phase, remainingMs, ...extra }) every ~5s.
// Quando cancela mid-wait, chama onPauseCapture({phase, remainingMs}) antes de
// retornar false — caller usa pra gravar quanto tempo faltava e retomar depois
// com esse valor (feature "resume de onde parou").
async function waitWithHeartbeat(totalMs, opts) {
  const { onProgress, shouldCancel, phase, extra, onPauseCapture } = opts || {};
  const sliceMs = 5000;
  let remaining = totalMs;
  while (remaining > 0) {
    if (shouldCancel && shouldCancel()) {
      if (typeof onPauseCapture === "function") {
        try { onPauseCapture({ phase, remainingMs: remaining }); } catch (_) {}
      }
      return false;
    }
    if (onProgress) {
      try { onProgress(Object.assign({ phase, remainingMs: remaining }, extra || {})); } catch (_) {}
    }
    const step = Math.min(sliceMs, remaining);
    await new Promise(r => setTimeout(r, step));
    remaining -= step;
  }
  return true;
}

// Count groupCreations for this session in the last hour. Returns the list so
// the caller can compute "when does the next slot open" from the oldest row.
async function fetchRecentGroupCreations(sessionId, windowMs) {
  const since = new Date(Date.now() - windowMs).toISOString();
  const rows = await supaRest(
    "/rest/v1/wa_group_creations?source_session_id=eq." + encodeURIComponent(sessionId) +
    "&status=eq.created" +
    "&updated_at=gte." + encodeURIComponent(since) +
    "&select=updated_at&order=updated_at.asc"
  ).catch(e => { console.error("[BAILEYS] fetchRecentGroupCreations failed:", e.message); return []; });
  return Array.isArray(rows) ? rows : [];
}

// Gate that blocks before a groupCreate until the hourly cap of groupCreates
// per account is not exceeded. Reports progress via onProgress with
// phase="hourly_budget".
async function waitForGroupCreateBudget(sessionId, opts) {
  const { onProgress, shouldCancel, hourlyCap } = opts || {};
  const cap = Number(hourlyCap) || GROUP_CREATE_HOURLY_CAP;

  // Hourly budget — re-check in a loop in case we need to wait multiple
  // windows (unlikely but safe).
  for (let guard = 0; guard < 10; guard++) {
    if (shouldCancel && shouldCancel()) return;
    const rows = await fetchRecentGroupCreations(sessionId, HOUR_MS);
    const used = rows.length;
    if (used < cap) {
      console.log("[BAILEYS] hourly budget " + used + "/" + cap + " OK for session", sessionId);
      return;
    }
    // Compute how long until the oldest row ages out of the 1h window
    const oldest = new Date(rows[0].updated_at).getTime();
    const waitMs = Math.max(10 * 1000, (oldest + HOUR_MS) - Date.now() + 5000);
    console.log("[BAILEYS] hourly budget " + used + "/" + cap + " used, waiting " + Math.round(waitMs / 1000) + "s for session", sessionId);
    const ok = await waitWithHeartbeat(waitMs, {
      onProgress, shouldCancel, phase: "hourly_budget", extra: { used, cap },
    });
    if (!ok) return;
    // Loop re-checks the DB to account for other jobs draining the window
  }
}

// Phones that must ALWAYS receive the conservative group-creation profile,
// regardless of what the caller passes in `options`. These accounts have a
// track record of being flagged by WhatsApp and cannot afford another
// rate-overlimit trip.
const CRITICAL_PHONES = new Set(["5519993473149"]); // Escalada Ltda

async function applyCriticalSessionOverrides(sessionId, sock, options) {
  const rawId = String((sock && sock.user && sock.user.id) || "");
  const phone = rawId.split(":")[0].split("@")[0].replace(/\D/g, "");
  const isCritical = CRITICAL_PHONES.has(phone);
  if (!isCritical) return options;

  const out = Object.assign({}, options);
  out.delaySec = Math.max(Number(out.delaySec) || 0, 600); // minimum 10min
  out.hourlyCap = Math.min(Number(out.hourlyCap) || GROUP_CREATE_HOURLY_CAP, 3);
  out._leadingDelayMs = 120 * 1000; // 2min leading delay
  out._criticalMode = true;
  out._criticalPhone = phone;
  console.warn(
    "[BAILEYS] critical session override active: sessionId=" + sessionId +
    " phone=" + phone + " delaySec=" + out.delaySec +
    " hourlyCap=" + out.hourlyCap + " leading=120s"
  );
  return out;
}

// ===== Bulk group creation from spreadsheet =====
// specs: [{ specHash, name, description, photoUrl, members:[phoneDigits], lockInfo, welcomeMessage }]
// Creates each group via sock.groupCreate and then polishes with description,
// avatar, lock setting, and welcome message. Conservative delays between groups
// because groupCreate is the most rate-limit-sensitive group operation.
async function createGroupsFromList(sessionId, specs, options = {}) {
  const session = await waitForSessionConnected(sessionId);
  if (!session || session.status !== "connected") {
    throw new Error("Sessão não conectada: " + sessionId);
  }
  const sock = session.sock;

  // Force the conservative profile on Escalada and any session that smells
  // flagged. This runs BEFORE we parse delaySec/hourlyCap so the rest of the
  // function sees the hardened values.
  options = await applyCriticalSessionOverrides(sessionId, sock, options);

  const delaySecRaw = Number(options.delaySec) || 180;
  // Clamp: mínimo 60s (proteção anti-NaN/negativo), máximo 86400s (24h).
  // Usuário pode escolher delays longos (1h, 2h, overnight) pra contas
  // sensíveis via input do card "Retomar" no grupos.html.
  const baseDelayMs = Math.max(60, Math.min(86400, delaySecRaw)) * 1000;
  const INTRA_DELAY_MS = 4000;
  const hourlyCap = Number(options.hourlyCap) || GROUP_CREATE_HOURLY_CAP;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const shouldCancel = typeof options.shouldCancel === "function" ? options.shouldCancel : null;

  const total = Array.isArray(specs) ? specs.length : 0;
  const results = [];
  let rateLimited = false;
  let cancelled = false;
  let processed = 0;

  // Enter full quarantine for the duration of the job. Gates every
  // IQ-generating event handler (incoming group messages stop triggering
  // groupMetadata, participant-update refreshes are skipped) AND blocks
  // ezapweb/extension HTTP routes that would call the socket (profile-pic,
  // group-info, list-admin-groups, groups, add-to-groups, messages/send)
  // — they all return 409 while quarantined. The finally block decides
  // whether to release based on rate-limit status.
  quarantineSession(sessionId, "create_groups_job");
  console.log("[BAILEYS] create-groups job starting for session", sessionId, "— session quarantined (all IQ traffic blocked)");

  try {

  for (let i = 0; i < total; i++) {
    if (shouldCancel && shouldCancel()) { cancelled = true; break; }
    if (rateLimited) break;

    // Gate: drain pending photo IQ calls + respect hourly groupCreate cap
    await waitForGroupCreateBudget(sessionId, { onProgress, shouldCancel, hourlyCap });
    if (shouldCancel && shouldCancel()) { cancelled = true; break; }

    // Leading delay before the FIRST create: give freshly-reconnected sessions
    // breathing room so any residual metadata sync IQs complete before we
    // start issuing groupCreate. Critical sessions override this to a fixed
    // 120s; normal sessions get baseDelayMs/2 capped at 90s.
    // User pode configurar explicitamente via leadingDelaySec (incluindo 0).
    //
    // Se este worker e' uma retomada (options._startingBetweenDelayMs > 0),
    // usamos o tempo que faltava do between_groups delay pausado em vez do
    // leading delay normal — assim o user retoma de onde parou.
    if (i === 0) {
      const resumeRemainingMs = Number(options._startingBetweenDelayMs) || 0;
      const userLead = options._leadingDelayMs;
      let leadMs;
      let leadPhase = "leading_delay";
      if (resumeRemainingMs > 0) {
        leadMs = resumeRemainingMs;
        leadPhase = "resume_remaining_delay";
        console.log("[BAILEYS] resuming paused delay " + Math.round(leadMs / 1000) + "s (from previous pause)");
      } else {
        leadMs = (typeof userLead === "number" && userLead >= 0)
          ? userLead
          : Math.min(baseDelayMs / 2, 90 * 1000);
        console.log("[BAILEYS] leading delay " + Math.round(leadMs / 1000) + "s before first groupCreate");
      }
      if (leadMs > 0) {
        const ok = await waitWithHeartbeat(leadMs, {
          onProgress, shouldCancel, phase: leadPhase,
          onPauseCapture: options._onPauseCapture,
        });
        if (!ok) { cancelled = true; break; }
      }
    }

    const spec = specs[i];
    processed++;
    const _specStartedAt = Date.now();
    // Latência por step — preenchido durante o processamento e jogado no
    // metadata do evento group_create:success/failed no final. Permite
    // análise empírica de qual step mais demora (photo? welcome? groupCreate?).
    const _stepDurations = {};
    const _measureStart = () => Date.now();
    const _measureEnd = (name, t0) => { _stepDurations[name] = Date.now() - t0; };

    // Sinaliza pro job manager qual spec está processando AGORA — a UI usa
    // isso pra mostrar "⏳ Pendente" na linha correta enquanto o grupo está
    // sendo criado, e as demais como "⏸ Aguardando".
    if (onProgress) {
      try {
        onProgress({ phase: "processing_spec", specHash: spec.specHash, name: spec.name, index: i });
      } catch (_) {}
    }

    // Activity log: início do spec
    const _sessInfo = sessions.get(sessionId);
    _logEvent({
      type: "group_create:start",
      level: "info",
      message: "Iniciando grupo: " + (spec.name || "(sem nome)"),
      sessionId,
      sessionLabel: _sessInfo ? _sessInfo.label : null,
      sessionPhone: _sessInfo ? _sessInfo.phone : null,
      groupName: spec.name || null,
      metadata: {
        specHash: spec.specHash,
        index: i,
        total,
        includeClient: spec.includeClient !== false,
        includeCx2: spec.includeCx2 !== false,
        includeEscalada: spec.includeEscalada !== false,
        hubspotTicketId: spec.hubspotTicketId || null,
      },
    });

    const row = {
      index: i,
      specHash: spec.specHash,
      name: spec.name || "(sem nome)",
      status: "pending",
      statusMessage: null,
      groupJid: null,
      // Inclui members/helperSessionIds + adminJids/adminSessionIds + 1 pro criador.
      // membersAdded é contado em 3 lugares (groupCreate participants incluindo owner,
      // admin add loop, helpers batch), então o total precisa seguir o mesmo critério
      // pra nunca ficar "4/3" na UI. Se spec usa session-based, prioriza esses counts.
      membersTotal: (Array.isArray(spec.helperSessionIds) && spec.helperSessionIds.length > 0
        ? spec.helperSessionIds.length + (spec.clientPhone ? 1 : 0)
        : (Array.isArray(spec.members) ? spec.members.length : 0))
        + (Array.isArray(spec.adminSessionIds) && spec.adminSessionIds.length > 0
          ? spec.adminSessionIds.length
          : (Array.isArray(spec.adminJids) ? spec.adminJids.length : 0))
        + 1,
      membersAdded: 0,
      hasDescription: false,
      hasPhoto: false,
      locked: false,
      welcomeSent: false,
      inviteLink: null,
      // Campos HubSpot denormalizados (vindos do spec via grupos.html)
      hubspotTicketId: spec.hubspotTicketId || null,
      hubspotTicketName: spec.hubspotTicketName || null,
      hubspotMentor: spec.hubspotMentor || null,
      hubspotTier: spec.hubspotTier || null,
      clientPhone: spec.clientPhone || null,
      mentorSessionId: spec.mentorSessionId || null,
      mentorSessionPhone: spec.mentorSessionPhone || null,
    };

    try {
      // ROOT CAUSE FIX (commit após 105ea6b): voltar ao pattern ORIGINAL —
      // groupCreate com TODOS os members (cliente + mentor + helpers) de uma
      // vez. O refactor "cliente primeiro + batch add helpers depois" (commit
      // a4d8878) disparava um pattern de IQs que o WhatsApp interpretava como
      // automação/bot e respondia com `stream:error code=401 conflict
      // type=device_removed` — removia a linked device. Sintoma visto em 2026-04-20:
      // 8 sessões caíram em sequência em grupos com o mesmo número suspeito.
      // Admins (Escalada Ltda) continuam em step separado (add + promote) —
      // esse pattern sempre funcionou.
      const isHubspotFlow = !!spec.clientPhone;

      // Flags do modo convite — default true (backward compat com fluxo antigo).
      // Se false, o membro NÃO entra via groupCreate, recebe DM com invite link.
      const includeClient = spec.includeClient !== false;
      const includeCx2 = spec.includeCx2 !== false;
      const includeEscalada = spec.includeEscalada !== false;
      const CX2_DIGITS = "5519971505209";
      const ESCALADA_DIGITS = "5519993473149";
      const CX2_JID = CX2_DIGITS + "@s.whatsapp.net";
      const ESCALADA_JID = ESCALADA_DIGITS + "@s.whatsapp.net";

      // Resolve session-based JIDs (preferido sobre phone cru — sock.user.id
      // é canônico, sem risco de LID salvo em wa_sessions.phone). Dedupe.
      // Defense: pre-carrega JID do próprio criador no seenJids pra NUNCA
      // tentar adicionar o criador como helper/admin do próprio grupo — isso
      // aconteceria se frontend mandar Escalada como admin e o user escolher
      // Escalada como sessão criadora (2026-04-21 Dhiego fluxo novo).
      // Pre-carrega CX2/Escalada no seenJids se user desmarcou — vão receber
      // DM com invite link em vez de entrar via groupCreate/add+promote.
      const resolvedHelperJids = [];
      const resolvedAdminJids = [];
      const seenJids = new Set();
      const creatorOwnJid = resolveSessionToJid(sessionId);
      if (creatorOwnJid) seenJids.add(creatorOwnJid);
      if (!includeCx2) seenJids.add(CX2_JID);
      if (!includeEscalada) seenJids.add(ESCALADA_JID);
      if (Array.isArray(spec.helperSessionIds)) {
        for (const hsid of spec.helperSessionIds) {
          const jid = resolveSessionToJid(hsid);
          if (jid && !seenJids.has(jid)) {
            resolvedHelperJids.push(jid);
            seenJids.add(jid);
          }
        }
      }
      if (Array.isArray(spec.adminSessionIds)) {
        for (const asid of spec.adminSessionIds) {
          const jid = resolveSessionToJid(asid);
          if (jid && !seenJids.has(jid)) {
            resolvedAdminJids.push(jid);
            seenJids.add(jid);
          }
        }
      }

      // Monta a lista FINAL de members pro groupCreate — todos juntos.
      // HubSpot: cliente + (helpers via session_id OU spec.members cru filtrado).
      // XLSX: spec.members cru, validado via onWhatsApp.
      // Se !includeClient, o cliente NÃO entra via groupCreate (vira DM invite).
      let memberJids;
      if (isHubspotFlow) {
        // Prefer resolvedClientJid (validado pelo /resolve-tickets via onWhatsApp
        // batch) — canônico, com o "9" BR ajustado se necessário. Fallback para
        // o phone cru se não veio validação (caso de IQ falhou no resolve).
        // Se validação marcou "not_on_whatsapp", resolvedClientJid é null e
        // a variable clientWasSkipped já foi setada pelo frontend via includeClient=false.
        const clientJid = spec.resolvedClientJid || (spec.clientPhone + "@s.whatsapp.net");
        const finalList = includeClient ? [clientJid] : [];
        if (resolvedHelperJids.length > 0) {
          // Session-based: JIDs já canônicos
          for (const j of resolvedHelperJids) if (!finalList.includes(j)) finalList.push(j);
        } else if (Array.isArray(spec.members)) {
          // Phone-based fallback: filtra LIDs localmente + onWhatsApp batch
          const extraPhones = spec.members
            .filter(p => p && p !== spec.clientPhone && !isLikelyLid(p));
          if (extraPhones.length > 0) {
            const validated = await validateMembersForCreate(sock, extraPhones).catch(() => []);
            for (const j of validated) if (!finalList.includes(j)) finalList.push(j);
          }
        }
        memberJids = finalList;
      } else {
        memberJids = await validateMembersForCreate(sock, spec.members || []);
        if (memberJids.length === 0) {
          throw new Error("Nenhum membro válido no WhatsApp");
        }
      }

      // 1. groupCreate com TODOS — retry em Connection Closed / Bad MAC.
      // Este é o pattern orgânico que o WhatsApp aceita sem flagar como bot.
      // Fallback pra `bad-request`: WhatsApp rejeita groupCreate quando o cliente
      // não está nos contatos do criador (Andrei/Franciele/Marlie). Nesse caso,
      // tentamos sem o cliente: o grupo é criado só com mentor+CX2, e depois
      // mandamos DM com invite link pro cliente + mensagem alt no grupo.
      let created;
      // Pre-emptive skip: se user desmarcou "incluir cliente", o cliente não
      // entra via groupCreate (nem mesmo vai tentar). Step 3 DM vai disparar
      // do mesmo jeito que no fallback bad-request.
      let clientWasSkipped = (isHubspotFlow && !includeClient && !!spec.clientPhone);
      if (clientWasSkipped) {
        row.statusMessage = appendNote(row.statusMessage,
          "modo convite: cliente não foi adicionado — link será enviado por DM");
      }
      const _tGroupCreate = _measureStart();
      try {
        created = await callWithTransientRetry(
          sessionId,
          (s) => s.groupCreate(spec.name, memberJids),
          { label: "groupCreate[" + (spec.name || "").substring(0, 30) + "]" }
        );
        _measureEnd("groupCreate", _tGroupCreate);
      } catch (e) {
        _measureEnd("groupCreate", _tGroupCreate);
        const errMsg = String(e?.message || "").toLowerCase();
        const isBadRequest = errMsg.includes("bad-request") || (e && e.output && e.output.statusCode === 400);
        if (isBadRequest && isHubspotFlow && spec.clientPhone && memberJids.length > 1) {
          // Retry sem o cliente. Assume que o cliente é o primeiro JID no array
          // (buildSpec monta assim: [clientJid, ...helpers]).
          const clientJid = spec.clientPhone + "@s.whatsapp.net";
          const memberJidsNoClient = memberJids.filter(j => j !== clientJid);
          if (memberJidsNoClient.length > 0) {
            console.log("[BAILEYS] groupCreate bad-request — retry sem cliente", spec.clientPhone, "para", spec.name);
            _logEvent({
              type: "group_create:bad_request_fallback",
              level: "warn",
              message: "bad-request no groupCreate — retry sem cliente (" + spec.clientPhone + ")",
              sessionId,
              sessionLabel: _sessInfo ? _sessInfo.label : null,
              sessionPhone: _sessInfo ? _sessInfo.phone : null,
              groupName: spec.name || null,
              metadata: {
                specHash: spec.specHash,
                clientPhone: spec.clientPhone,
                originalError: String(e?.message || "").slice(0, 200),
              },
            });
            try {
              created = await callWithTransientRetry(
                sessionId,
                (s) => s.groupCreate(spec.name, memberJidsNoClient),
                { label: "groupCreate[no-client]" }
              );
              clientWasSkipped = true;
              row.statusMessage = appendNote(row.statusMessage,
                "groupCreate sem cliente (bad-request): grupo criado, link enviado por DM");
            } catch (e2) {
              throw e2; // falha de novo, sem cliente — não tem o que fazer
            }
          } else {
            throw e;
          }
        } else {
          throw e;
        }
      }
      row.groupJid = created?.id || null;
      if (!row.groupJid) throw new Error("groupCreate não retornou id");
      row.createdAt = new Date().toISOString();

      // Detecta rejeitados via `created.participants` (Baileys retorna
      // {jid: {error: "403"}} pros bloqueados por privacidade). NÃO mata o
      // socket — WhatsApp só reporta individualmente, grupo é criado OK.
      row.clientAdded = null;
      row.clientDmSent = null;
      // Se o cliente foi pulado no groupCreate (bad-request), trata como rejected
      // desde já — Step 3 vai enviar DM, Step 10 vai mandar alt message.
      let clientRejected = clientWasSkipped;
      if (clientWasSkipped) row.clientAdded = false;
      const rejectedJids = []; // pra DM (cliente HubSpot OU members xlsx rejeitados)
      if (created.participants && typeof created.participants === "object") {
        const entries = Object.entries(created.participants);
        row.membersAdded = entries.filter(([, p]) => !p || !p.error).length;
        const clientJid = isHubspotFlow && !clientWasSkipped ? spec.clientPhone + "@s.whatsapp.net" : null;
        for (const [pjid, info] of entries) {
          const code = String((info && (info.error || info.statusCode)) || "");
          if (code === "403") {
            if (isHubspotFlow && pjid === clientJid) {
              clientRejected = true;
              row.clientAdded = false;
            } else if (!isHubspotFlow) {
              rejectedJids.push(pjid);
            }
            // Helpers rejeitados no fluxo HubSpot: loga mas não manda DM
            // (helpers são contas internas tipo CX2 — 403 seria config estranha,
            // não privacy real). Não emitimos DM nem bloqueia o fluxo.
          }
        }
        if (isHubspotFlow && !clientRejected) row.clientAdded = true;
      } else {
        row.membersAdded = memberJids.length;
        if (isHubspotFlow) row.clientAdded = true;
      }

      // Wait 8s for Signal key establishment (PreKeyError prevention).
      await new Promise(r => setTimeout(r, 8000));

      // 2. Invite link — envolvido em callWithTransientRetry pra sobreviver
      // a Connection Closed pós-groupCreate (bug observado Vitor/Max/Emerson).
      const _tInvite = _measureStart();
      try {
        const code = await callWithTransientRetry(
          sessionId,
          (s) => s.groupInviteCode(row.groupJid),
          { label: "inviteCode[" + (spec.name || "").substring(0, 30) + "]" }
        );
        if (code) row.inviteLink = "https://chat.whatsapp.com/" + code;
        _measureEnd("inviteCode", _tInvite);
      } catch (e) {
        _measureEnd("inviteCode", _tInvite);
        if (isRateLimitError(e)) { rateLimited = true; }
        row.statusMessage = appendNote(row.statusMessage, "invite_link_fail: " + (e?.message || e));
      }

      // 2b. Invite DMs pros helpers excluídos (modo convite).
      // CX2 e/ou Escalada desmarcados no modal → recebem DM com invite link
      // em vez de entrar via groupCreate/add+promote.
      // Marca row.cx2DmSent e row.escaladaDmSent: true|false|null (null=N/A).
      row.cx2DmSent = null;
      row.escaladaDmSent = null;
      const clientFirstNameForDM = (spec.name || "").split("|")[0].trim().split(" ")[0] || "cliente";
      const helperTemplateRaw = spec.inviteDmHelperTemplate
        || 'Olá! Novo grupo de mentoria criado: "{nome_grupo}". Entra por este link: {link}';
      const fillHelperTemplate = () => helperTemplateRaw
        .replace(/\{nome_grupo\}/g, spec.name || "")
        .replace(/\{link\}/g, row.inviteLink || "")
        .replace(/\{cliente_nome\}/g, clientFirstNameForDM)
        .replace(/\{mentor\}/g, String(spec.hubspotMentor || ""));

      if (!rateLimited && row.inviteLink && !includeCx2) {
        const _tDmCx2 = _measureStart();
        try {
          await callWithTransientRetry(
            sessionId,
            (s) => s.sendMessage(CX2_JID, { text: fillHelperTemplate() }),
            { label: "dmInviteCx2[" + (spec.name || "").substring(0, 30) + "]" }
          );
          _measureEnd("dmCx2", _tDmCx2);
          row.cx2DmSent = true;
          row.statusMessage = appendNote(row.statusMessage, "cx2_convite_enviado_por_dm");
          _logEvent({
            type: "dm:sent:cx2",
            level: "info",
            message: "DM convite enviada pra CX2 (grupo: " + (spec.name || "(sem nome)") + ")",
            sessionId, sessionLabel: _sessInfo ? _sessInfo.label : null,
            sessionPhone: _sessInfo ? _sessInfo.phone : null,
            groupJid: row.groupJid, groupName: spec.name || null,
            metadata: { target: CX2_DIGITS, specHash: spec.specHash, deltaMs: _stepDurations.dmCx2 },
          });
        } catch (e) {
          _measureEnd("dmCx2", _tDmCx2);
          row.cx2DmSent = false;
          row.statusMessage = appendNote(row.statusMessage, "cx2_dm_fail: " + (e?.message || e));
          if (isRateLimitError(e)) rateLimited = true;
          _logEvent({
            type: "dm:failed:cx2",
            level: "warn",
            message: "Falha ao enviar DM pra CX2: " + (e?.message || e),
            sessionId, sessionLabel: _sessInfo ? _sessInfo.label : null,
            groupJid: row.groupJid, groupName: spec.name || null,
            metadata: { target: CX2_DIGITS, specHash: spec.specHash, error: e?.message || String(e) },
          });
        }
        await new Promise(r => setTimeout(r, 2500));
      }
      if (!rateLimited && row.inviteLink && !includeEscalada) {
        const _tDmEsc = _measureStart();
        try {
          await callWithTransientRetry(
            sessionId,
            (s) => s.sendMessage(ESCALADA_JID, { text: fillHelperTemplate() }),
            { label: "dmInviteEscalada[" + (spec.name || "").substring(0, 30) + "]" }
          );
          _measureEnd("dmEscalada", _tDmEsc);
          row.escaladaDmSent = true;
          row.statusMessage = appendNote(row.statusMessage, "escalada_convite_enviado_por_dm");
          _logEvent({
            type: "dm:sent:escalada",
            level: "info",
            message: "DM convite enviada pra Escalada (grupo: " + (spec.name || "(sem nome)") + ")",
            sessionId, sessionLabel: _sessInfo ? _sessInfo.label : null,
            sessionPhone: _sessInfo ? _sessInfo.phone : null,
            groupJid: row.groupJid, groupName: spec.name || null,
            metadata: { target: ESCALADA_DIGITS, specHash: spec.specHash, deltaMs: _stepDurations.dmEscalada },
          });
        } catch (e) {
          _measureEnd("dmEscalada", _tDmEsc);
          row.escaladaDmSent = false;
          row.statusMessage = appendNote(row.statusMessage, "escalada_dm_fail: " + (e?.message || e));
          if (isRateLimitError(e)) rateLimited = true;
          _logEvent({
            type: "dm:failed:escalada",
            level: "warn",
            message: "Falha ao enviar DM pra Escalada: " + (e?.message || e),
            sessionId, sessionLabel: _sessInfo ? _sessInfo.label : null,
            groupJid: row.groupJid, groupName: spec.name || null,
            metadata: { target: ESCALADA_DIGITS, specHash: spec.specHash, error: e?.message || String(e) },
          });
        }
        await new Promise(r => setTimeout(r, 2500));
      }

      // 3. Client rejected by privacy OU bad-request OU modo convite (HubSpot) → DM invite.
      // Template preferido: spec.inviteDmClientTemplate (modo convite). Fallback: spec.rejectDmTemplate (privacy).
      // Resolve JID canônico via sock.onWhatsApp — WhatsApp retorna o formato
      // correto (com ou sem o "9" extra BR). Se o número NÃO está no WA,
      // marca clientDmSent=false com motivo claro em status_message.
      if (!rateLimited && isHubspotFlow && clientRejected && row.inviteLink) {
        const rawPhone = String(spec.clientPhone || "").replace(/\D/g, "");
        // Prefer resolvedClientJid (já validado no /resolve-tickets — batch IQ na
        // sessão doadora). Só cai no lookup local se não veio validação.
        let clientJid = spec.resolvedClientJid || null;
        if (!clientJid) {
          try {
            const r1 = await sock.onWhatsApp(rawPhone);
            if (Array.isArray(r1) && r1[0] && r1[0].exists && r1[0].jid && !r1[0].jid.endsWith("@lid")) {
              clientJid = r1[0].jid;
            } else if (rawPhone.length === 13 && rawPhone.startsWith("55")) {
              const without9 = rawPhone.slice(0, 4) + rawPhone.slice(5);
              const r2 = await sock.onWhatsApp(without9);
              if (Array.isArray(r2) && r2[0] && r2[0].exists && r2[0].jid && !r2[0].jid.endsWith("@lid")) {
                clientJid = r2[0].jid;
              }
            } else if (rawPhone.length === 12 && rawPhone.startsWith("55")) {
              const with9 = rawPhone.slice(0, 4) + "9" + rawPhone.slice(4);
              const r2 = await sock.onWhatsApp(with9);
              if (Array.isArray(r2) && r2[0] && r2[0].exists && r2[0].jid && !r2[0].jid.endsWith("@lid")) {
                clientJid = r2[0].jid;
              }
            }
          } catch (onWaErr) {
            console.warn("[BAILEYS] onWhatsApp lookup failed for client DM — fallback raw JID:", onWaErr.message);
          }
        }

        if (!clientJid) {
          row.clientDmSent = false;
          row.statusMessage = appendNote(row.statusMessage,
            "cliente_dm_falhou: número " + rawPhone + " não encontrado no WhatsApp. Verifique no HubSpot.");
          _logEvent({
            type: "dm:failed:client",
            level: "warn",
            message: "DM cliente NÃO enviada — número não encontrado em WhatsApp (" + rawPhone + ")",
            sessionId, sessionLabel: _sessInfo ? _sessInfo.label : null,
            groupJid: row.groupJid, groupName: spec.name || null,
            metadata: { target: rawPhone, reason: "not_on_whatsapp", specHash: spec.specHash },
          });
        } else {
          const _tDmClient = _measureStart();
          try {
            const clientTemplate = spec.inviteDmClientTemplate || spec.rejectDmTemplate
              || 'Olá! Seu grupo de mentoria "{nome_grupo}" foi criado, mas suas configurações de privacidade não permitem que a gente te adicione diretamente. Entra por este link: {link}';
            const dmText = clientTemplate
              .replace(/\{nome_grupo\}/g, spec.name || "")
              .replace(/\{link\}/g, row.inviteLink);
            await callWithTransientRetry(
              sessionId,
              (s) => s.sendMessage(clientJid, { text: dmText }),
              { label: "dmClientReject[...]" }
            );
            _measureEnd("dmClient", _tDmClient);
            row.clientDmSent = true;
            const adjusted9 = clientJid !== (rawPhone + "@s.whatsapp.net");
            const noteJid = adjusted9
              ? "cliente_convite_enviado_por_dm (JID ajustado: " + clientJid.split("@")[0] + ")"
              : "cliente_convite_enviado_por_dm";
            row.statusMessage = appendNote(row.statusMessage, noteJid);
            _logEvent({
              type: "dm:sent:client",
              level: "info",
              message: "DM convite enviada pro cliente" + (adjusted9 ? " (JID ajustado 9 BR)" : "") + " — " + (spec.name || "(sem nome)"),
              sessionId, sessionLabel: _sessInfo ? _sessInfo.label : null,
              sessionPhone: _sessInfo ? _sessInfo.phone : null,
              groupJid: row.groupJid, groupName: spec.name || null,
              metadata: {
                target: rawPhone,
                canonicalJid: clientJid,
                adjusted9br: adjusted9,
                specHash: spec.specHash,
                deltaMs: _stepDurations.dmClient,
              },
            });
          } catch (dmErr) {
            _measureEnd("dmClient", _tDmClient);
            row.clientDmSent = false;
            row.statusMessage = appendNote(row.statusMessage, "cliente_dm_fail: " + (dmErr?.message || dmErr));
            if (isRateLimitError(dmErr)) { rateLimited = true; }
            _logEvent({
              type: "dm:failed:client",
              level: "warn",
              message: "Falha ao enviar DM pro cliente: " + (dmErr?.message || dmErr),
              sessionId, sessionLabel: _sessInfo ? _sessInfo.label : null,
              groupJid: row.groupJid, groupName: spec.name || null,
              metadata: { target: rawPhone, specHash: spec.specHash, error: dmErr?.message || String(dmErr) },
            });
          }
        }
        await new Promise(r => setTimeout(r, 2500));
      }

      // 4. Description
      if (!rateLimited && spec.description) {
        const _tDesc = _measureStart();
        try {
          await callWithTransientRetry(
            sessionId,
            (s) => s.groupUpdateDescription(row.groupJid, String(spec.description)),
            { label: "desc[" + (spec.name || "").substring(0, 30) + "]" }
          );
          _measureEnd("description", _tDesc);
          row.hasDescription = true;
        } catch (e) {
          _measureEnd("description", _tDesc);
          row.statusMessage = appendNote(row.statusMessage, "desc_fail: " + (e.message || e));
          if (isRateLimitError(e)) { rateLimited = true; }
        }
        await new Promise(r => setTimeout(r, INTRA_DELAY_MS));
      }

      // 5. Photo from URL
      if (!rateLimited && spec.photoUrl) {
        const _tPhoto = _measureStart();
        try {
          const buf = await fetchPhotoBuffer(spec.photoUrl);
          await callWithTransientRetry(
            sessionId,
            (s) => s.updateProfilePicture(row.groupJid, buf),
            { label: "photo[" + (spec.name || "").substring(0, 30) + "]" }
          );
          _measureEnd("photo", _tPhoto);
          row.hasPhoto = true;
        } catch (e) {
          _measureEnd("photo", _tPhoto);
          row.statusMessage = appendNote(row.statusMessage, "photo_fail: " + (e.message || e));
          if (isRateLimitError(e)) { rateLimited = true; }
        }
        await new Promise(r => setTimeout(r, INTRA_DELAY_MS));
      }

      // 6a. "Adicionar membros" = todos — ANTES do lock (permissão de invite
      // link depende disso).
      if (!rateLimited) {
        const _tMemberMode = _measureStart();
        try {
          await callWithTransientRetry(
            sessionId,
            (s) => s.groupMemberAddMode(row.groupJid, "all_member_add"),
            { label: "memberAddMode" }
          );
          _measureEnd("memberAddMode", _tMemberMode);
        } catch (e) {
          _measureEnd("memberAddMode", _tMemberMode);
          row.statusMessage = appendNote(row.statusMessage, "member_add_mode_fail: " + (e?.message || e));
          if (isRateLimitError(e)) { rateLimited = true; }
        }
        await new Promise(r => setTimeout(r, 4000));
      }

      // 6b. Lock "Editar configurações do grupo".
      if (!rateLimited && spec.lockInfo) {
        const _tLock = _measureStart();
        try {
          await callWithTransientRetry(
            sessionId,
            (s) => s.groupSettingUpdate(row.groupJid, "locked"),
            { label: "lock" }
          );
          _measureEnd("lock", _tLock);
          row.locked = true;
        } catch (e) {
          _measureEnd("lock", _tLock);
          row.statusMessage = appendNote(row.statusMessage, "lock_fail: " + (e.message || e));
          if (isRateLimitError(e)) { rateLimited = true; }
        }
        await new Promise(r => setTimeout(r, INTRA_DELAY_MS));
      }

      // 7. Add + promote extra admin JIDs (e.g. Escalada Ltda).
      // Preferência: resolvedAdminJids (session-based). Fallback: spec.adminJids.
      // Filtros: remove o JID do próprio criador + remove Escalada se user
      // desmarcou (ela vai receber DM com invite link em vez disso).
      const adminJidsToProcess = resolvedAdminJids.length > 0
        ? resolvedAdminJids
        : (Array.isArray(spec.adminJids)
            ? spec.adminJids.filter(j =>
                (!creatorOwnJid || j !== creatorOwnJid) &&
                (includeEscalada || j !== ESCALADA_JID))
            : []);
      if (!rateLimited && adminJidsToProcess.length > 0) {
        const _tAdmin = _measureStart();
        for (const adminJid of adminJidsToProcess) {
          try {
            const addRes = await callWithTransientRetry(
              sessionId,
              (s) => s.groupParticipantsUpdate(row.groupJid, [adminJid], "add"),
              { label: "adminAdd[" + adminJid.split("@")[0] + "]" }
            );
            if (Array.isArray(addRes) && addRes[0] && String(addRes[0].status) === "200") {
              row.membersAdded = (row.membersAdded || 0) + 1;
            }
            await new Promise(r => setTimeout(r, 2000));
            await callWithTransientRetry(
              sessionId,
              (s) => s.groupParticipantsUpdate(row.groupJid, [adminJid], "promote"),
              { label: "adminPromote[" + adminJid.split("@")[0] + "]" }
            );
            await new Promise(r => setTimeout(r, 1000));
          } catch (e) {
            if (isRateLimitError(e)) { rateLimited = true; break; }
            row.statusMessage = appendNote(row.statusMessage, "admin_fail " + adminJid.split("@")[0] + ": " + (e?.message || e));
          }
        }
        _measureEnd("adminAddPromote", _tAdmin);
      }

      // Step 8 (batch add helpers) REMOVIDO: helpers já entraram no groupCreate.
      // Foi esse step adicional + o groupCreate com só [clientJid] que mudou
      // o pattern de IQs pro WhatsApp e disparou o device_removed.

      // 9. DM pros rejeitados (fluxo XLSX only — HubSpot já tratou no Step 3).
      if (!rateLimited && !isHubspotFlow && row.inviteLink && rejectedJids.length > 0) {
        let notified = 0;
        for (const pjid of rejectedJids) {
          try {
            const dmText = 'Olá! Criei o grupo "' + (spec.name || "") + '" mas '
              + 'suas configurações de privacidade não permitem que eu te adicione '
              + 'diretamente. Entra por este link: ' + row.inviteLink;
            await sock.sendMessage(pjid, { text: dmText });
            notified++;
            await new Promise(r => setTimeout(r, 2500));
          } catch (e) {
            if (isRateLimitError(e)) { rateLimited = true; break; }
          }
        }
        if (notified > 0) {
          row.statusMessage = appendNote(row.statusMessage,
            notified + "/" + rejectedJids.length + " não-adicionados receberam o link no privado");
        }
      }

      // 10. Welcome or fallback message in the group.
      // Se alguém NÃO entrou no grupo (cliente rejeitado/desmarcado, CX2
      // desmarcado, Escalada desmarcado), envia alt message listando quem
      // está de fora + WhatsApp do mentor pra contato direto. Senão, welcome
      // normal.
      if (!rateLimited && spec.welcomeMessage) {
        const clientName = (spec.name || "").split("|")[0].trim().split(" ")[0] || "cliente";
        const clientAbsent = (row.clientAdded === false && !!spec.clientPhone);
        const cx2Absent = !includeCx2;
        const escaladaAbsent = !includeEscalada;
        const anyAbsent = clientAbsent || cx2Absent || escaladaAbsent;

        if (anyAbsent) {
          const absentParts = [];
          if (clientAbsent) absentParts.push("cliente " + clientName + " (" + spec.clientPhone + ")");
          if (cx2Absent) absentParts.push("CX2 (" + CX2_DIGITS + ")");
          if (escaladaAbsent) absentParts.push("Escalada Ltda (" + ESCALADA_DIGITS + ")");
          const mentorWa = spec.mentorWhatsapp || spec.mentorSessionPhone || "";
          const mentorLine = mentorWa ? ("\n\nDúvidas ou ajuda: mentor " + (spec.hubspotMentor || "") + " (" + mentorWa + ")") : "";
          const altText = "⚠️ Ainda faltam entrar no grupo: " + absentParts.join(", ")
            + ". O link de convite já foi enviado no privado pra cada um." + mentorLine;
          const _tAltWelcome = _measureStart();
          try {
            await callWithTransientRetry(
              sessionId,
              (s) => s.sendMessage(row.groupJid, { text: altText }),
              { label: "alt_welcome[" + (spec.name || "").substring(0, 30) + "]" }
            );
            _measureEnd("altWelcome", _tAltWelcome);
            row.welcomeSent = false;
            row.statusMessage = appendNote(row.statusMessage, "welcome_substituído: alerta de membros pendentes enviado no grupo");
            _logEvent({
              type: "welcome:alt_sent",
              level: "info",
              message: "Alt welcome enviado (membros pendentes: " + absentParts.length + ") — " + (spec.name || "(sem nome)"),
              sessionId, sessionLabel: _sessInfo ? _sessInfo.label : null,
              sessionPhone: _sessInfo ? _sessInfo.phone : null,
              groupJid: row.groupJid, groupName: spec.name || null,
              metadata: {
                specHash: spec.specHash,
                absentCount: absentParts.length,
                clientAbsent, cx2Absent, escaladaAbsent,
                deltaMs: _stepDurations.altWelcome,
              },
            });
          } catch (e) {
            _measureEnd("altWelcome", _tAltWelcome);
            if (isRateLimitError(e)) { rateLimited = true; }
            row.statusMessage = appendNote(row.statusMessage, "alt_welcome_fail: " + (e?.message || e));
            _logEvent({
              type: "welcome:failed",
              level: "warn",
              message: "Falha no alt welcome: " + (e?.message || e),
              sessionId, sessionLabel: _sessInfo ? _sessInfo.label : null,
              groupJid: row.groupJid, groupName: spec.name || null,
              metadata: { specHash: spec.specHash, variant: "alt", error: e?.message || String(e) },
            });
          }
        } else {
          // Todo mundo entrou — welcome normal
          const text = String(spec.welcomeMessage).replace(/\{nome_grupo\}/g, spec.name || "");
          const _tWelcome = _measureStart();
          try {
            await callWithTransientRetry(
              sessionId,
              (s) => s.sendMessage(row.groupJid, { text }),
              { label: "welcome[" + (spec.name || "").substring(0, 30) + "]" }
            );
            _measureEnd("welcome", _tWelcome);
            row.welcomeSent = true;
            _logEvent({
              type: "welcome:sent",
              level: "info",
              message: "Welcome enviado no grupo — " + (spec.name || "(sem nome)"),
              sessionId, sessionLabel: _sessInfo ? _sessInfo.label : null,
              sessionPhone: _sessInfo ? _sessInfo.phone : null,
              groupJid: row.groupJid, groupName: spec.name || null,
              metadata: { specHash: spec.specHash, deltaMs: _stepDurations.welcome },
            });
          } catch (e) {
            _measureEnd("welcome", _tWelcome);
            if (isRateLimitError(e)) { rateLimited = true; }
            row.statusMessage = appendNote(row.statusMessage, "welcome_fail: " + (e?.message || e));
            _logEvent({
              type: "welcome:failed",
              level: "warn",
              message: "Falha ao enviar welcome: " + (e?.message || e),
              sessionId, sessionLabel: _sessInfo ? _sessInfo.label : null,
              groupJid: row.groupJid, groupName: spec.name || null,
              metadata: { specHash: spec.specHash, variant: "normal", error: e?.message || String(e) },
            });
          }
        }
      }

      // Monta membersList: registra TODOS os participantes esperados no grupo,
      // com role, phone, se entrou direto ou via DM, e status do DM.
      // Persistido em wa_group_creations.members_list (JSONB).
      const membersList = [];
      // Mentor = criador (sempre admin, sempre no grupo)
      if (spec.mentorSessionPhone) {
        membersList.push({
          role: "mentor",
          phone: String(spec.mentorSessionPhone).replace(/\D/g, ""),
          name: spec.hubspotMentor || null,
          in_group: true,
          dm_sent: null,
        });
      }
      // Cliente
      if (spec.clientPhone) {
        membersList.push({
          role: "client",
          phone: spec.clientPhone,
          name: (spec.name || "").split("|")[0].trim() || null,
          in_group: row.clientAdded === true,
          dm_sent: row.clientDmSent,
        });
      }
      // CX2
      membersList.push({
        role: "cx2",
        phone: CX2_DIGITS,
        name: "CX2",
        in_group: includeCx2,
        dm_sent: row.cx2DmSent,
      });
      // Escalada
      membersList.push({
        role: "escalada",
        phone: ESCALADA_DIGITS,
        name: "Escalada Ltda",
        in_group: includeEscalada,
        dm_sent: row.escaladaDmSent,
      });
      row.membersList = membersList;

      row.status = rateLimited ? "rate_limited" : "created";
      if (rateLimited && !row.statusMessage) {
        row.statusMessage = "Rate limit detectado durante polimento do grupo";
      }
    } catch (e) {
      if (isRateLimitError(e)) {
        rateLimited = true;
        row.status = "rate_limited";
        row.statusMessage = "Rate limit detectado — job abortado";
        console.warn("[BAILEYS] Rate limit during groupCreate at index", i, "name:", spec.name);
      } else {
        row.status = "failed";
        row.statusMessage = e?.message || String(e);
      }
    }

    // Activity log: resultado do spec (success / rate_limit / failed).
    // Metadata carrega flags úteis + stepDurations pra análise empírica de
    // qual step demora mais (photo geralmente) e detectar outliers/slowness.
    const _deltaMs = Date.now() - _specStartedAt;
    const _evType = row.status === "created" ? "group_create:success"
                  : row.status === "rate_limited" ? "group_create:rate_limit"
                  : "group_create:failed";
    const _evLevel = row.status === "created" ? "info"
                  : row.status === "rate_limited" ? "error" : "warn";
    _logEvent({
      type: _evType,
      level: _evLevel,
      message: (row.status === "created" ? "Grupo criado: " : (row.status === "rate_limited" ? "RATE-LIMIT no grupo: " : "Falha no grupo: ")) + (spec.name || "(sem nome)"),
      sessionId,
      sessionLabel: _sessInfo ? _sessInfo.label : null,
      sessionPhone: _sessInfo ? _sessInfo.phone : null,
      groupJid: row.groupJid || null,
      groupName: spec.name || null,
      metadata: (() => {
        // PR 2: snapshot do IQ counter no momento do evento.
        // Crítico pra correlacionar rate-limit com contagem de IQs acumulados.
        const _iqStats = _iqCounter.getStats(sessionId);
        return {
          specHash: spec.specHash,
          status: row.status,
          deltaMs: _deltaMs,
          stepDurations: _stepDurations,  // PR1 #4: breakdown de latência por step
          membersTotal: row.membersTotal || 0,
          membersAdded: row.membersAdded || 0,
          hasDescription: !!row.hasDescription,
          hasPhoto: !!row.hasPhoto,
          locked: !!row.locked,
          welcomeSent: !!row.welcomeSent,
          clientDmSent: row.clientDmSent,
          cx2DmSent: row.cx2DmSent,
          escaladaDmSent: row.escaladaDmSent,
          clientAdded: row.clientAdded,
          statusMessage: row.statusMessage,
          errorMessage: row.status === "failed" ? row.statusMessage : undefined,
          index: i,
          total,
          // PR 2 — snapshot IQ counter no momento do evento.
          // Total = acumulado desde pm2 start. lastHour = janela deslizante 1h.
          // Em rate_limit events, esses números são a métrica chave pra calibrar
          // hipótese empírica de "quantos IQs o WhatsApp tolera por sessão/hora".
          iqStats: _iqStats ? {
            total: _iqStats.total,
            lastHour: _iqStats.lastHour,
            iqByType: _iqStats.iqByType,
            lastHourByType: _iqStats.lastHourByType,
          } : null,
        };
      })(),
    });

    results.push(row);
    upsertGroupCreation(sessionId, row);

    if (onProgress) {
      try { onProgress({ processed, total, row, rateLimited }); } catch (_) {}
    }

    // Delay between groups (only if more to process and not aborting).
    // Usa waitWithHeartbeat em vez de setTimeout direto pra o botão Interromper
    // funcionar DURANTE o delay (sem precisar esperar os 10 min terminarem).
    // Jitter configurável: se user passou jitterMin/MaxSec, usa esse range
    // (0..60min) em vez do ±30s default. Sempre positivo (soma ao delay).
    if (i < total - 1 && !rateLimited && !(shouldCancel && shouldCancel())) {
      let jitterMs;
      const jMinSec = Number(options.jitterMinSec) || 0;
      const jMaxSec = Number(options.jitterMaxSec) || 0;
      if (jMaxSec > 0 && jMaxSec >= jMinSec) {
        // User-configured: random integer ms in [jMinSec*1000, jMaxSec*1000]
        const rangeMs = (jMaxSec - jMinSec) * 1000;
        jitterMs = (jMinSec * 1000) + Math.floor(Math.random() * (rangeMs + 1));
      } else {
        jitterMs = Math.floor((Math.random() - 0.5) * 60000); // ±30s default legado
      }
      const ok = await waitWithHeartbeat(baseDelayMs + jitterMs, {
        onProgress, shouldCancel, phase: "between_groups",
        onPauseCapture: options._onPauseCapture,
      });
      if (!ok) { cancelled = true; break; }
    }
  }

  } finally {
    if (rateLimited) {
      markRateLimit(sessionId);
      // Keep the session quarantined — photo-worker stays paused, handlers
      // stay gated, ezapweb routes keep returning 409. This prevents us
      // from re-probing a flagged number the moment the job aborts. User
      // must manually release via the grupos.html "▶️ Liberar" button after
      // the 30min cooldown is clearly past.
      console.warn("[BAILEYS] rate-limit during job for session " + sessionId + " — quarantine HELD for manual release (30min cooldown registered)");
    } else {
      releaseSession(sessionId);
    }
  }

  return { results, rateLimited, cancelled, total, processed };
}

function appendNote(existing, note) {
  if (!existing) return note;
  return existing + " | " + note;
}

// Validates a list of raw phone digits against WhatsApp and returns JIDs.
// Uses a single sock.onWhatsApp call for the whole batch.
async function validateMembersForCreate(sock, phones) {
  // 1. Filtra LIDs LOCALMENTE (antes de qualquer chamada remota). sock.onWhatsApp
  //    retorna exists=true pra LIDs que o contact store da sessão já conhece
  //    (common após history sync), então o check remoto sozinho não é suficiente.
  const clean = (Array.isArray(phones) ? phones : [])
    .map(p => String(p || "").replace(/\D/g, ""))
    .filter(p => !isLikelyLid(p));
  if (clean.length === 0) return [];
  try {
    const checks = await sock.onWhatsApp(...clean);
    const out = [];
    const seen = new Set();
    for (const c of (checks || [])) {
      // Defense: reject @lid JIDs caso o Baileys os devolva mesmo assim.
      if (c && c.exists && c.jid && !c.jid.endsWith("@lid") && !seen.has(c.jid)) {
        out.push(c.jid);
        seen.add(c.jid);
      }
    }
    return out;
  } catch (e) {
    console.error("[BAILEYS] validateMembersForCreate failed:", e.message);
    // Fallback SEGURO: sem validação = não adiciona. Prefere "grupo faltando
    // helpers" a "sessão morta por stanza malformada + welcome não enviado".
    return [];
  }
}

// Fetch an image URL and return a Buffer suitable for sock.updateProfilePicture.
// Baileys itself resizes internally via jimp, so we don't need sharp here.
async function fetchPhotoBuffer(url) {
  if (!url || typeof url !== "string") throw new Error("URL inválida");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("image/")) {
      throw new Error("Content-Type não é imagem: " + contentType);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error("Imagem vazia");
    if (buf.length > 5 * 1024 * 1024) throw new Error("Imagem maior que 5MB");
    return buf;
  } finally {
    clearTimeout(timeout);
  }
}

async function upsertGroupCreation(sessionId, row) {
  try {
    await supaRest(
      "/rest/v1/wa_group_creations?on_conflict=source_session_id,spec_hash",
      "POST",
      {
        source_session_id: sessionId,
        spec_hash: row.specHash,
        group_name: row.name,
        group_jid: row.groupJid || null,
        status: row.status,
        status_message: row.statusMessage || null,
        members_total: row.membersTotal || 0,
        members_added: row.membersAdded || 0,
        has_description: !!row.hasDescription,
        has_photo: !!row.hasPhoto,
        locked: !!row.locked,
        welcome_sent: !!row.welcomeSent,
        invite_link: row.inviteLink || null,
        // Campos HubSpot denormalizados (snapshot no momento da criação).
        // hubspot_pipeline_* ficam NULL aqui — são populados pelo trigger
        // sync_ticket_to_group_creations quando o webhook HubSpot atualiza
        // a tabela `mentorados`.
        hubspot_ticket_id: row.hubspotTicketId || null,
        hubspot_ticket_name: row.hubspotTicketName || null,
        hubspot_mentor: row.hubspotMentor || null,
        hubspot_tier: row.hubspotTier || null,
        client_phone: row.clientPhone || null,
        mentor_session_id: row.mentorSessionId || null,
        mentor_session_phone: row.mentorSessionPhone || null,
        // Lista completa de membros esperados no grupo (modo convite + direto).
        // Shape: [{role, phone, name, in_group, dm_sent}]. Roles: client|mentor|cx2|escalada.
        members_list: Array.isArray(row.membersList) ? row.membersList : null,
        updated_at: new Date().toISOString(),
      },
      "resolution=merge-duplicates,return=minimal"
    );
  } catch (e) {
    console.error("[BAILEYS] upsertGroupCreation failed:", e.message);
  }
}

async function getCachedGroupCreations(sessionId) {
  try {
    const rows = await supaRest(
      "/rest/v1/wa_group_creations?source_session_id=eq." + sessionId +
      "&select=spec_hash,group_name,group_jid,status,status_message,members_total,members_added,has_description,has_photo,locked,welcome_sent,invite_link,created_at,members_list&order=created_at.desc"
    );
    return rows || [];
  } catch (e) {
    console.error("[BAILEYS] getCachedGroupCreations failed:", e.message);
    return [];
  }
}

// ===== Stop session =====
async function stopSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    try {
      // Remove listeners ANTES de sock.end() — o WebSocket fecha async e o
      // Baileys pode emitir eventos tardios (connection.update com loggedOut,
      // creds.update com creds velhas). Sem removeAllListeners, esses eventos
      // disparam saveSessionCreds/etc e corrompem o estado de uma sessão
      // nova startada depois (bug observado no fresh-qr do Gustavo Netto).
      session.sock.ev.removeAllListeners();
    } catch (_) {}
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
      // Delay between reconnections. Each new session immediately streams
      // history sync (thousands of inserts) + group metadata sync. With 18
      // sessions, a short delay means 18 parallel upsert storms land on
      // Supabase simultaneously and saturate Kong/PostgREST. 15s per session
      // spaces them out so the in-flight queue drains between starts.
      await new Promise(r => setTimeout(r, 15000));
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
        await supaRest(
          "/rest/v1/wa_chats?on_conflict=session_id,chat_jid",
          "POST",
          chatBatch.slice(i, i + 100),
          "resolution=merge-duplicates,return=minimal"
        );
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
        await supaRest(
          "/rest/v1/wa_messages?on_conflict=session_id,message_id",
          "POST",
          batch.slice(i, i + 200),
          "resolution=merge-duplicates,return=minimal"
        );
        saved += batch.slice(i, i + 200).length;
      } catch(e) {
        console.error("[BAILEYS] History batch save error:", e.message);
      }
    }
    console.log("[BAILEYS] History sync saved", saved, "messages for", sessionId);
    // Photos for historical chats are fetched lazily when the contact sends
    // a new message (see handleIncomingMessage). No bulk enqueue here.
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
          await supaRest(
            "/rest/v1/group_members?on_conflict=group_jid,member_phone",
            "POST",
            chunk,
            "resolution=merge-duplicates,return=minimal"
          ).catch(() => {});
        }

        // No bulk photo enqueue for participants — lazy fetch on message arrival
      }
    }

    // No bulk photo enqueue for groups either — a group's photo is fetched
    // when someone sends a message in it (see handleIncomingMessage).

    console.log("[BAILEYS] Group metadata sync done for:", sessionId, "groups:", groups.length);
  } catch (e) {
    console.error("[BAILEYS] syncGroupMetadata error:", e.message);
  }
}

// ===== Download media from a WhatsApp message =====
async function downloadMedia(sessionId, messageJson) {
  const s = sessions.get(sessionId);
  if (!s || s.status !== "connected") throw new Error("Sessão não conectada");
  try {
    const buffer = await downloadMediaMessage(messageJson, "buffer", {}, {
      logger,
      reuploadRequest: s.sock.updateMediaMessage,
    });
    return buffer;
  } catch (e) {
    throw new Error("Erro ao baixar mídia: " + e.message);
  }
}

// ===== Get group metadata (participants, description, etc.) =====
async function getGroupInfo(sessionId, groupJid) {
  const s = sessions.get(sessionId);
  if (!s || s.status !== "connected") return null;
  try {
    const meta = await s.sock.groupMetadata(groupJid);
    return {
      jid: meta.id,
      subject: meta.subject,
      description: meta.desc || "",
      owner: meta.owner,
      creation: meta.creation,
      participants: (meta.participants || []).map(p => ({
        jid: p.id,
        phone: p.id.split("@")[0].split(":")[0],
        admin: p.admin || null,
      })),
      participantsCount: (meta.participants || []).length,
      announce: meta.announce,  // only admins can send
      restrict: meta.restrict,  // only admins can edit info
    };
  } catch (e) {
    console.error("[BAILEYS] getGroupInfo error:", e.message);
    return null;
  }
}

// ===== Resolve LID to contact name/phone =====
// LID (Linked ID) is WhatsApp's internal identifier, not a phone number.
// We try to resolve it via: 1) wa_contacts linked_jid, 2) lid_phone_map,
// 3) wa_chats/messages/contact store for a name fallback.
async function resolveLid(sessionId, lidJid) {
  if (!lidJid || !lidJid.endsWith("@lid")) return null;
  const lid = lidJid.split("@")[0];

  // 1. Check if we already have a mapping in wa_contacts
  try {
    const rows = await supaRest(
      "/rest/v1/wa_contacts?session_id=eq." + sessionId +
      "&contact_jid=eq." + encodeURIComponent(lidJid) +
      "&select=name,push_name,linked_jid&limit=1"
    );
    if (rows && rows[0]) {
      if (rows[0].linked_jid) {
        // We have the real JID — look up name
        const realRows = await supaRest(
          "/rest/v1/wa_contacts?session_id=eq." + sessionId +
          "&contact_jid=eq." + encodeURIComponent(rows[0].linked_jid) +
          "&select=name,push_name&limit=1"
        ).catch(() => []);
        if (realRows && realRows[0]) {
          return { name: realRows[0].name || realRows[0].push_name, phone: rows[0].linked_jid.split("@")[0], jid: rows[0].linked_jid };
        }
      }
      if (rows[0].name || rows[0].push_name) {
        return { name: rows[0].name || rows[0].push_name, phone: lid, jid: lidJid };
      }
    }
  } catch(e) {}

  // 2. Dedicated LID -> phone registry populated from participantPn.
  try {
    const lidRows = await supaRest(
      "/rest/v1/lid_phone_map?lid=eq." + encodeURIComponent(lidJid) +
      "&select=phone,contact_name&limit=1"
    );
    if (lidRows && lidRows[0] && lidRows[0].phone) {
      return {
        name: lidRows[0].contact_name || lid,
        phone: lidRows[0].phone,
        jid: lidRows[0].phone + "@s.whatsapp.net",
      };
    }
  } catch(e) {}

  // 3. Check wa_chats for a better name (same session)
  try {
    const chatRows = await supaRest(
      "/rest/v1/wa_chats?session_id=eq." + sessionId +
      "&chat_jid=eq." + encodeURIComponent(lidJid) +
      "&select=chat_name&limit=1"
    );
    if (chatRows && chatRows[0] && chatRows[0].chat_name && chatRows[0].chat_name !== lid) {
      return { name: chatRows[0].chat_name, phone: lid, jid: lidJid };
    }
  } catch(e) {}

  // 4. Cross-session: check if ANY session has this LID with a name or linked_jid
  try {
    const crossRows = await supaRest(
      "/rest/v1/wa_contacts?contact_jid=eq." + encodeURIComponent(lidJid) +
      "&or=(name.not.is.null,push_name.not.is.null)" +
      "&select=name,push_name,linked_jid&limit=1"
    );
    if (crossRows && crossRows[0] && (crossRows[0].name || crossRows[0].push_name)) {
      return { name: crossRows[0].name || crossRows[0].push_name, phone: lid, jid: lidJid };
    }
  } catch(e) {}

  // 5. Cross-session: check wa_chats in OTHER sessions for same LID
  try {
    const crossChats = await supaRest(
      "/rest/v1/wa_chats?chat_jid=eq." + encodeURIComponent(lidJid) +
      "&chat_name=not.eq." + lid +
      "&select=chat_name&limit=1"
    );
    if (crossChats && crossChats[0] && crossChats[0].chat_name) {
      return { name: crossChats[0].chat_name, phone: lid, jid: lidJid };
    }
  } catch(e) {}

  // 6. Last resort: search incoming messages for this LID to find sender pushName
  try {
    const msgRows = await supaRest(
      "/rest/v1/wa_messages?chat_jid=eq." + encodeURIComponent(lidJid) +
      "&from_me=eq.false&sender_name=neq." +
      "&select=sender_name&limit=1&order=timestamp.desc"
    );
    if (msgRows && msgRows[0] && msgRows[0].sender_name) {
      return { name: msgRows[0].sender_name, phone: lid, jid: lidJid };
    }
  } catch(e) {}

  // 7. Try Baileys sock contact store (if connected)
  const s = sessions.get(sessionId);
  if (s && s.status === "connected") {
    try {
      const contact = s.sock.store?.contacts?.[lidJid];
      if (contact && (contact.name || contact.notify)) {
        return { name: contact.name || contact.notify, phone: lid, jid: lidJid };
      }
    } catch(e) {}
  }

  return null; // Could not resolve
}

// Lightweight accessor for routes/sessions.js — returns metadata the UI needs
// without leaking the live sock object. Includes timing info for anti-rate-limit UX.
function getSessionMeta(sessionId) {
  const session = sessions.get(sessionId);
  const rl = getRateLimitStatus(sessionId);
  return {
    connected: !!(session && session.status === "connected"),
    status: session ? session.status : "disconnected",
    connectedAt: session && session.connectedAt ? new Date(session.connectedAt).toISOString() : null,
    rateLimitHitAt: rl ? new Date(rl.hitAt).toISOString() : null,
    rateLimitRemainingMs: rl ? rl.remainingMs : 0,
  };
}

module.exports = {
  setIO,
  startSession,
  stopSession,
  sendMessage,
  getActiveSessions,
  getSession,
  getSessionMeta,
  getIqStats: (sessionId) => _iqCounter.getStats(sessionId),
  getAllIqStats: () => _iqCounter.getAllStats(),
  getRateLimitStatus,
  markRateLimit,
  reconnectAllSessions,
  fetchGroupsWithInvites,
  addParticipantToAllGroups,
  createGroupsFromList,
  listAdminGroups,
  listAdminGroupsWithMembership,
  getCachedGroupLinks,
  getCachedGroupAdditions,
  getCachedGroupCreations,
  importLocalCache,
  getProfilePicture,
  readChatMessages,
  downloadMedia,
  getGroupInfo,
  resolveLid,
  quarantineSession,
  releaseSession,
  isQuarantined,
  getQuarantineStatus,
};
