// ===== E-ZAP Message Capture =====
// Captura mensagens enviadas e recebidas do WhatsApp Web em background.
// Popula a tabela message_events no Supabase para analytics de performance.
//
// Funciona via:
//   1. Polling do Store (Fiber + Webpack) a cada 10s pra detectar novas msgs
//   2. Buffer local com dedup por message_wid
//   3. Batch insert no Supabase a cada 15s via background.js
//   4. Nao interfere na UI — tudo e leitura passiva
//
// Depende de: api.js (ezapSupaRest, ezapUserId), store-bridge.js (Store access)

(function() {
  "use strict";

  // ===== CONFIG =====
  var SCAN_INTERVAL_MS = 10000;    // Scan chats every 10s
  var SYNC_INTERVAL_MS = 15000;    // Sync buffer to Supabase every 15s
  var MAX_BUFFER_SIZE = 200;       // Max buffered events before forced sync
  var MAX_MSGS_PER_CHAT = 30;      // Max messages to scan per chat (most recent)
  var INITIAL_HISTORY_MSGS = 50;   // On first scan of a chat, capture last N msgs
  var DEDUP_CACHE_MAX = 10000;     // Max known message IDs in memory

  // ===== STATE =====
  var _buffer = [];                // Pending events to sync
  var _knownWids = {};             // message_wid -> true (dedup)
  var _knownWidsCount = 0;
  var _scanTimer = null;
  var _syncTimer = null;
  var _initialized = false;
  var _lastScanAt = 0;
  var _chatLastTs = {};            // chat_jid -> last captured timestamp (unix s)
  var _syncInProgress = false;
  var _totalCaptured = 0;
  var _totalSynced = 0;

  // ===== HELPERS =====
  function getUserId() {
    return (window.__wcrmAuth && window.__wcrmAuth.userId) || null;
  }

  function getMentorPhone() {
    return (window.__wcrmAuth && window.__wcrmAuth.userPhone) || "";
  }

  function isExtValid() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
  }

  function supaRest(path, method, body) {
    return new Promise(function(resolve) {
      if (!isExtValid()) { resolve(null); return; }
      try {
        chrome.runtime.sendMessage({
          action: "supabase_rest",
          path: path,
          method: method || "GET",
          body: body,
          prefer: "return=minimal"  // Faster — no response body needed
        }, function(resp) {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(resp);
        });
      } catch (e) { resolve(null); }
    });
  }

  // Batch insert with duplicate ignore (uses Supabase resolution=ignore-duplicates)
  function supaRestBatch(path, body) {
    return new Promise(function(resolve) {
      if (!isExtValid()) { resolve(null); return; }
      try {
        chrome.runtime.sendMessage({
          action: "supabase_rest",
          path: path,
          method: "POST",
          body: body,
          prefer: "resolution=ignore-duplicates,return=minimal"
        }, function(resp) {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(resp);
        });
      } catch (e) { resolve(null); }
    });
  }

  // Extract phone from JID: "5511999999999@c.us" -> "5511999999999"
  function phoneFromJid(jid) {
    if (!jid || typeof jid !== "string") return "";
    return jid.split("@")[0].replace(/[^0-9]/g, "");
  }

  // Safe property access with obfuscation fallback
  function prop(obj) {
    // prop(msg, "body") checks msg.body, msg.__x_body
    if (!obj) return undefined;
    for (var i = 1; i < arguments.length; i++) {
      var key = arguments[i];
      var val = obj[key];
      if (val !== undefined && val !== null) return val;
      val = obj["__x_" + key];
      if (val !== undefined && val !== null) return val;
    }
    return undefined;
  }

  // Normalize message type to our enum
  function normalizeType(type) {
    if (!type) return "other";
    type = String(type).toLowerCase();
    var map = {
      chat: "text", text: "text",
      ptt: "audio", audio: "audio",
      image: "image",
      video: "video",
      document: "document",
      sticker: "sticker",
      vcard: "contact", multi_vcard: "contact",
      location: "location", liveLocation: "location"
    };
    return map[type] || "other";
  }

  // ===== STORE ACCESS =====
  // Gets all chats from Fiber Store (same as store-bridge.js uses)
  function getChatsFromStore() {
    // Strategy 1: Fiber Store (primary — covers 95% of setups)
    try {
      var pane = document.getElementById("pane-side");
      if (!pane) return null;
      var rows = pane.querySelectorAll('[role="row"]');
      if (!rows.length) return null;
      for (var r = 0; r < Math.min(rows.length, 3); r++) {
        var row = rows[r];
        var keys = Object.keys(row);
        var fiberKey = null;
        for (var kk = 0; kk < keys.length; kk++) {
          if (keys[kk].indexOf("__reactFiber") === 0) { fiberKey = keys[kk]; break; }
        }
        if (!fiberKey) continue;
        var cur = row[fiberKey];
        var depth = 0;
        while (cur && depth < 25) {
          var p = cur.memoizedProps;
          if (p && p.chats && Array.isArray(p.chats) && p.chats.length) return p.chats;
          cur = cur.return;
          depth++;
        }
      }
    } catch (e) {}

    // Strategy 2: Webpack Store (fallback)
    try {
      if (window._ezapStore && window._ezapStore.Chat) {
        var models = window._ezapStore.Chat.getModelsArray();
        if (models && Array.isArray(models) && models.length) return models;
      }
    } catch (e) {}

    return null;
  }

  // Get messages from a chat object
  function getChatMessages(chat) {
    var msgs = prop(chat, "msgs");
    if (!msgs) return [];
    if (msgs._models && Array.isArray(msgs._models)) return msgs._models;
    if (Array.isArray(msgs)) return msgs;
    if (typeof msgs.getModelsArray === "function") {
      try { return msgs.getModelsArray() || []; } catch (e) {}
    }
    return [];
  }

  // Get chat JID as string
  function getChatJid(chat) {
    if (!chat || !chat.id) return "";
    try {
      if (chat.id._serialized) return chat.id._serialized;
      if (typeof chat.id === "string") return chat.id;
      if (chat.id.toString) return chat.id.toString();
    } catch (e) {}
    return "";
  }

  // Get chat display name
  function getChatName(chat) {
    try {
      var c = chat.contact || chat.__x_contact;
      if (c) {
        var n = c.name || c.__x_name || c.pushname || c.__x_pushname ||
                c.formattedName || c.__x_formattedName || c.shortName || c.__x_shortName;
        if (n) return String(n);
      }
      var n2 = chat.name || chat.__x_name || chat.formattedTitle || chat.__x_formattedTitle;
      if (n2) return String(n2);
    } catch (e) {}
    return "";
  }

  // Get message WID (unique ID string)
  function getMsgWid(msg) {
    if (!msg || !msg.id) return null;
    try {
      if (msg.id._serialized) return msg.id._serialized;
      if (typeof msg.id === "string") return msg.id;
      if (msg.id.toString) return msg.id.toString();
    } catch (e) {}
    return null;
  }

  // Get sender name from message
  function getSenderName(msg) {
    try {
      var sObj = prop(msg, "senderObj");
      if (sObj) {
        return sObj.pushname || sObj.name || sObj.shortName ||
               sObj.formattedName || sObj.verifiedName || "";
      }
      return prop(msg, "notifyName") || "";
    } catch (e) {}
    return "";
  }

  // Get message body text (filters out binary/base64 junk)
  function getMsgBody(msg) {
    var body = prop(msg, "caption") || "";
    if (!body) {
      var raw = prop(msg, "body") || "";
      // Filter out base64 thumbnails and binary data
      if (raw && raw.length < 5000 && !/^\/9j\/|^data:|^[A-Za-z0-9+\/]{100,}/.test(raw)) {
        body = raw;
      }
    }
    return body ? String(body).substring(0, 4000) : "";  // Cap at 4KB
  }

  // Get message timestamp (unix seconds)
  function getMsgTimestamp(msg) {
    var t = prop(msg, "t") || prop(msg, "timestamp");
    if (t) return Number(t);
    // Some messages store timestamp in id
    if (msg.id && msg.id.t) return Number(msg.id.t);
    return 0;
  }

  // ===== SCAN LOGIC =====
  function scanChats() {
    if (!getUserId()) return;
    if (document.hidden) return;  // Don't scan when tab is background

    var chats = getChatsFromStore();
    if (!chats || !chats.length) return;

    var now = Date.now();
    _lastScanAt = now;
    var userId = getUserId();
    var mentorPhone = getMentorPhone();

    for (var ci = 0; ci < chats.length; ci++) {
      var chat = chats[ci];
      var chatJid = getChatJid(chat);
      if (!chatJid) continue;
      // Skip status broadcasts and system chats
      if (chatJid === "status@broadcast" || chatJid.indexOf("@lid") >= 0) continue;

      var chatName = getChatName(chat);
      var isGroup = chatJid.indexOf("@g.us") >= 0;
      var msgs = getChatMessages(chat);
      if (!msgs.length) continue;

      // Determine how many messages to scan
      var isFirstScan = !_chatLastTs[chatJid];
      var maxMsgs = isFirstScan ? INITIAL_HISTORY_MSGS : MAX_MSGS_PER_CHAT;
      var startIdx = Math.max(0, msgs.length - maxMsgs);
      var lastKnownTs = _chatLastTs[chatJid] || 0;
      var newestTs = lastKnownTs;

      for (var mi = startIdx; mi < msgs.length; mi++) {
        var msg = msgs[mi];
        if (!msg) continue;

        var wid = getMsgWid(msg);
        if (!wid) continue;

        // Dedup: skip already-captured messages
        if (_knownWids[wid]) continue;

        var msgTs = getMsgTimestamp(msg);
        if (!msgTs) continue;

        // On subsequent scans, only capture messages newer than last known
        if (!isFirstScan && msgTs <= lastKnownTs) continue;

        // Skip system messages (protocol, e2e_notification, etc.)
        var msgType = prop(msg, "type") || "other";
        var typeStr = String(msgType).toLowerCase();
        if (typeStr === "e2e_notification" || typeStr === "notification_template" ||
            typeStr === "gp2" || typeStr === "protocol" || typeStr === "ciphertext" ||
            typeStr === "notification" || typeStr === "call_log") continue;

        var isSent = !!(msg.id && msg.id.fromMe) || !!prop(msg, "isSentByMe");
        var body = getMsgBody(msg);
        var normalizedType = normalizeType(typeStr);
        var duration = Number(prop(msg, "duration") || 0);

        // Build client phone
        var clientPhone = "";
        if (isGroup) {
          clientPhone = phoneFromJid(chatJid);
        } else {
          clientPhone = phoneFromJid(chatJid);
        }

        // Group participant (who sent in group)
        var groupParticipant = "";
        if (isGroup) {
          var author = prop(msg, "author");
          if (author) {
            groupParticipant = typeof author === "string" ? phoneFromJid(author) :
              (author._serialized ? phoneFromJid(author._serialized) : "");
          } else if (msg.id && msg.id.participant) {
            var part = msg.id.participant;
            groupParticipant = typeof part === "string" ? phoneFromJid(part) :
              (part._serialized ? phoneFromJid(part._serialized) : "");
          }
        }

        var senderName = isSent ? (window.__wcrmAuth && window.__wcrmAuth.userName || "Eu") : getSenderName(msg);

        // Build event object
        var event = {
          user_id: userId,
          message_wid: wid,
          chat_jid: chatJid,
          chat_name: chatName || null,
          phone_mentor: mentorPhone || null,
          phone_client: clientPhone || null,
          direction: isSent ? "sent" : "received",
          message_type: normalizedType,
          body: body || null,
          caption: prop(msg, "caption") ? String(prop(msg, "caption")).substring(0, 1000) : null,
          char_count: body ? body.length : 0,
          sender_name: senderName || null,
          is_group: isGroup,
          group_participant: groupParticipant || null,
          duration_seconds: duration > 0 ? Math.round(duration) : null,
          media_mime: prop(msg, "mimetype") || null,
          timestamp: new Date(msgTs * 1000).toISOString()
        };

        _buffer.push(event);
        _knownWids[wid] = true;
        _knownWidsCount++;
        _totalCaptured++;

        if (msgTs > newestTs) newestTs = msgTs;
      }

      if (newestTs > lastKnownTs) _chatLastTs[chatJid] = newestTs;
    }

    // Prevent memory bloat on dedup cache
    if (_knownWidsCount > DEDUP_CACHE_MAX) {
      _knownWids = {};
      _knownWidsCount = 0;
    }

    // Force sync if buffer is large
    if (_buffer.length >= MAX_BUFFER_SIZE) syncBuffer();
  }

  // ===== SYNC TO SUPABASE =====
  function syncBuffer() {
    if (_syncInProgress) return;
    if (_buffer.length === 0) return;
    if (!getUserId()) return;

    _syncInProgress = true;
    var batch = _buffer.splice(0, 50);  // Max 50 per request

    supaRestBatch("/rest/v1/message_events", batch).then(function(resp) {
      _syncInProgress = false;
      if (resp && resp.error) {
        // Check for unique constraint violations (duplicates) — that's OK
        if (String(resp.error || resp.message || "").indexOf("duplicate") >= 0 ||
            String(resp.error || resp.message || "").indexOf("unique") >= 0) {
          // Duplicates are expected on first run — ignore
        } else {
          console.warn("[EZAP-CAPTURE] Sync error:", resp.error || resp.message);
          // Put failed events back in buffer for retry (at the front)
          _buffer = batch.concat(_buffer);
        }
      } else {
        _totalSynced += batch.length;
      }

      // Continue syncing if buffer still has data
      if (_buffer.length > 0) {
        setTimeout(syncBuffer, 500);
      }
    });
  }

  // ===== INIT & LIFECYCLE =====
  function start() {
    if (_initialized) return;
    _initialized = true;

    console.log("[EZAP-CAPTURE] Message capture started");

    // Scan periodically
    _scanTimer = setInterval(function() {
      if (!isExtValid()) { stop(); return; }
      scanChats();
    }, SCAN_INTERVAL_MS);

    // Sync periodically
    _syncTimer = setInterval(function() {
      if (!isExtValid()) { stop(); return; }
      syncBuffer();
    }, SYNC_INTERVAL_MS);

    // First scan after a short delay (let Store populate)
    setTimeout(scanChats, 5000);
  }

  function stop() {
    if (_scanTimer) { clearInterval(_scanTimer); _scanTimer = null; }
    if (_syncTimer) { clearInterval(_syncTimer); _syncTimer = null; }
    _initialized = false;
    // Final sync attempt
    if (_buffer.length > 0) syncBuffer();
  }

  // ===== WAIT FOR AUTH THEN START =====
  // Only start capturing after user is authenticated
  function waitAndStart() {
    var waitTimer = setInterval(function() {
      if (!isExtValid()) { clearInterval(waitTimer); return; }
      if (getUserId()) {
        clearInterval(waitTimer);
        // Wait a bit more for Store to be ready
        setTimeout(start, 3000);
      }
    }, 2000);
  }

  // Expose stats for debugging
  window._ezapCaptureStats = function() {
    return {
      initialized: _initialized,
      buffer: _buffer.length,
      knownWids: _knownWidsCount,
      trackedChats: Object.keys(_chatLastTs).length,
      totalCaptured: _totalCaptured,
      totalSynced: _totalSynced,
      lastScan: _lastScanAt ? new Date(_lastScanAt).toISOString() : "never"
    };
  };

  // Pause when tab goes to background, resume when visible
  document.addEventListener("visibilitychange", function() {
    if (document.hidden) return;
    // Tab became visible — do a scan
    if (_initialized) setTimeout(scanChats, 1000);
  });

  waitAndStart();
})();
