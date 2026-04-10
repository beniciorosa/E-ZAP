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

async function fetchGroupsWithInvites(sessionId, skipJids = [], maxCalls = 10) {
  const session = sessions.get(sessionId);
  if (!session || session.status !== "connected") {
    throw new Error("Sessão não conectada: " + sessionId);
  }

  const sock = session.sock;
  // WhatsApp uses TWO identities for the same user: phone JID (@s.whatsapp.net)
  // and LID (@lid). In newer groups, participants are listed by LID instead of phone.
  const myJid = sock.user?.id || "";
  const myLid = sock.user?.lid || "";
  const myPhoneBase = extractBase(myJid); // digits only, e.g. "5511999999999"
  const myLidBase = extractBase(myLid);

  // JIDs to skip — caller already has the invite link cached for these
  const skipSet = new Set(Array.isArray(skipJids) ? skipJids : []);
  // Max number of groupInviteCode calls in this single request (batch limit to avoid HTTP timeout)
  const maxCallsThisBatch = Math.max(1, Math.min(50, Number(maxCalls) || 10));
  let callsMade = 0;
  let batchLimitReached = false;

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
      // Delay 55-65s (jitter ±5s) between IQ requests — "safe zone" strategy.
      // Empirically the WhatsApp server tolerates ~60-120 group IQ calls per
      // hour before rate-limiting. 60s/call gives us ~60/hour, comfortably
      // below the threshold. Jitter breaks up bot-like patterns.
      if (!rateLimited && callsMade < maxCallsThisBatch) {
        const baseMs = 60000;
        const jitterMs = Math.floor((Math.random() - 0.5) * 10000); // ±5000ms
        await new Promise(r => setTimeout(r, baseMs + jitterMs));
      }
      // After the last call in this batch, stop processing further admin groups
      if (callsMade >= maxCallsThisBatch) batchLimitReached = true;
    } else {
      inviteError = "Sem permissão (não é admin)";
    }

    results.push({
      jid: g.id,
      name: g.subject || "(sem nome)",
      participants: Array.isArray(g.participants) ? g.participants.length : 0,
      isAdmin,
      inviteLink,
      inviteError,
      skipped,
    });
  }

  const debug = {
    myJid,
    myLid,
    myPhoneBase,
    myLidBase,
    adminDetectedAny,
    firstGroupSample,
  };

  return { groups: results, rateLimited, total, processed, callsMade, batchLimitReached, debug };
}

// ===== List groups where the session is admin (lightweight, no extra IQ calls) =====
async function listAdminGroups(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.status !== "connected") {
    throw new Error("Sessão não conectada: " + sessionId);
  }
  const sock = session.sock;

  const myJid = sock.user?.id || "";
  const myLid = sock.user?.lid || "";
  const myPhoneBase = extractBase(myJid);
  const myLidBase = extractBase(myLid);

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
async function addParticipantToAllGroups(sessionId, phoneToAdd, skipJids = [], maxCalls = 10, options = {}) {
  const session = sessions.get(sessionId);
  if (!session || session.status !== "connected") {
    throw new Error("Sessão não conectada: " + sessionId);
  }
  const sock = session.sock;
  const promoteToAdmin = options && options.promoteToAdmin === true;
  const onlyJids = options && Array.isArray(options.onlyJids) ? options.onlyJids : null;
  const onlyJidsSet = onlyJids ? new Set(onlyJids) : null;

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
  const myJid = sock.user?.id || "";
  const myLid = sock.user?.lid || "";
  const myPhoneBase = extractBase(myJid);
  const myLidBase = extractBase(myLid);

  const skipSet = new Set(Array.isArray(skipJids) ? skipJids : []);
  // maxCalls counts INDIVIDUAL WhatsApp API calls (add + promote are 2 separate calls)
  const maxCallsThisBatch = Math.max(1, Math.min(50, Number(maxCalls) || 10));
  let callsMade = 0;
  let batchLimitReached = false;

  const groupsMap = await sock.groupFetchAllParticipating();
  const groupList = Object.values(groupsMap || {});
  const total = groupList.length;

  const results = [];
  let rateLimited = false;
  let processed = 0;

  // Small helper to wait 20s between IQ calls (unless we just hit rate limit or batch limit)
  async function rateLimitDelay() {
    if (!rateLimited && callsMade < maxCallsThisBatch) {
      await new Promise(r => setTimeout(r, 20000));
    }
  }

  for (const g of groupList) {
    processed++;

    // If a whitelist filter is active, skip groups not in the list (do not return them)
    if (onlyJidsSet && !onlyJidsSet.has(g.id)) continue;

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

    results.push({
      jid: g.id,
      name: g.subject || "(sem nome)",
      participants: Array.isArray(g.participants) ? g.participants.length : 0,
      isAdmin,
      status,
      statusMessage,
    });
  }

  return { groups: results, rateLimited, total, processed, callsMade, batchLimitReached };
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
  fetchGroupsWithInvites,
  addParticipantToAllGroups,
  listAdminGroups,
};
