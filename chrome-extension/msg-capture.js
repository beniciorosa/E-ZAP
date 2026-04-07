// ===== E-ZAP Message Capture (ISOLATED world) =====
// Captura mensagens enviadas e recebidas do WhatsApp Web em background.
// Popula a tabela message_events no Supabase para analytics de performance.
//
// Arquitetura:
//   - store-bridge.js (MAIN world) le as mensagens do Store via _ezap_get_msgs_req
//   - msg-capture.js (ISOLATED world) recebe via postMessage, faz dedup e sync
//   - Supabase sync via chrome.runtime.sendMessage -> background.js
//
// Depende de: store-bridge.js (MAIN world bridge), auth.js (__wcrmAuth)

(function() {
  "use strict";

  // ===== CONFIG =====
  var SCAN_INTERVAL_MS = 12000;    // Request messages every 12s
  var SYNC_INTERVAL_MS = 15000;    // Sync buffer to Supabase every 15s
  var MAX_BUFFER_SIZE = 200;       // Max buffered events before forced sync
  var DEDUP_CACHE_MAX = 15000;     // Max known message IDs in memory

  // ===== STATE =====
  var _buffer = [];                // Pending events to sync
  var _knownWids = {};             // message_wid -> true (dedup)
  var _knownWidsCount = 0;
  var _scanTimer = null;
  var _syncTimer = null;
  var _initialized = false;
  var _chatLastTs = {};            // chat_jid -> last captured timestamp (unix s)
  var _syncInProgress = false;
  var _totalCaptured = 0;
  var _totalSynced = 0;
  var _pendingReqId = null;

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

  // ===== BRIDGE: Request messages from MAIN world =====
  function requestMessages() {
    if (!getUserId()) return;
    if (document.hidden) return;
    if (_pendingReqId) return;  // Still waiting for previous response

    var reqId = "cap_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);
    _pendingReqId = reqId;

    window.postMessage({
      type: "_ezap_get_msgs_req",
      id: reqId,
      sinceTs: _chatLastTs,
      maxPerChat: 30,
      initialMax: 50
    }, "*");

    // Timeout: clear pending if no response in 10s
    setTimeout(function() {
      if (_pendingReqId === reqId) _pendingReqId = null;
    }, 10000);
  }

  // ===== BRIDGE: Listen for response from MAIN world =====
  window.addEventListener("message", function(event) {
    if (!event.data || event.source !== window) return;
    if (event.data.type !== "_ezap_get_msgs_res") return;
    if (event.data.id !== _pendingReqId) return;

    _pendingReqId = null;
    var d = event.data;

    if (!d.ok || !d.events || !d.events.length) return;

    var userId = getUserId();
    var mentorPhone = getMentorPhone();
    if (!userId) return;

    var events = d.events;
    var newCount = 0;

    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (!e.wid) continue;

      // Dedup
      if (_knownWids[e.wid]) continue;
      _knownWids[e.wid] = true;
      _knownWidsCount++;

      // Track newest timestamp per chat
      if (!_chatLastTs[e.chatJid] || e.timestamp > _chatLastTs[e.chatJid]) {
        _chatLastTs[e.chatJid] = e.timestamp;
      }

      // Build Supabase row
      _buffer.push({
        user_id: userId,
        message_wid: e.wid,
        chat_jid: e.chatJid,
        chat_name: e.chatName || null,
        phone_mentor: mentorPhone || null,
        phone_client: e.clientPhone || null,
        direction: e.direction,
        message_type: e.messageType,
        body: e.body || null,
        caption: e.caption || null,
        char_count: e.charCount || 0,
        sender_name: e.senderName || null,
        is_group: e.isGroup || false,
        group_participant: e.groupParticipant || null,
        duration_seconds: e.duration > 0 ? e.duration : null,
        media_mime: e.mediaMime || null,
        timestamp: new Date(e.timestamp * 1000).toISOString()
      });

      newCount++;
      _totalCaptured++;
    }

    if (newCount > 0) {
      console.log("[EZAP-CAPTURE] Captured", newCount, "new messages (buffer:", _buffer.length, ")");
    }

    // Prevent memory bloat on dedup cache
    if (_knownWidsCount > DEDUP_CACHE_MAX) {
      _knownWids = {};
      _knownWidsCount = 0;
    }

    // Force sync if buffer is large
    if (_buffer.length >= MAX_BUFFER_SIZE) syncBuffer();
  });

  // ===== SYNC TO SUPABASE =====
  function syncBuffer() {
    if (_syncInProgress) return;
    if (_buffer.length === 0) return;
    if (!getUserId()) return;
    if (!isExtValid()) return;

    _syncInProgress = true;
    var batch = _buffer.splice(0, 50);  // Max 50 per request

    try {
      chrome.runtime.sendMessage({
        action: "supabase_rest",
        path: "/rest/v1/message_events",
        method: "POST",
        body: batch,
        prefer: "resolution=ignore-duplicates,return=minimal"
      }, function(resp) {
        _syncInProgress = false;
        if (chrome.runtime.lastError) {
          console.warn("[EZAP-CAPTURE] Sync error:", chrome.runtime.lastError.message);
          _buffer = batch.concat(_buffer);
          return;
        }
        if (resp && (resp.error || resp.message)) {
          var errStr = String(resp.error || resp.message || "");
          if (errStr.indexOf("duplicate") >= 0 || errStr.indexOf("unique") >= 0) {
            // Duplicates are normal — count as synced
            _totalSynced += batch.length;
          } else {
            console.warn("[EZAP-CAPTURE] Sync error:", errStr);
            _buffer = batch.concat(_buffer);
          }
        } else {
          _totalSynced += batch.length;
          console.log("[EZAP-CAPTURE] Synced", batch.length, "events (total:", _totalSynced, ")");
        }

        // Continue syncing if buffer still has data
        if (_buffer.length > 0) {
          setTimeout(syncBuffer, 1000);
        }
      });
    } catch (e) {
      _syncInProgress = false;
      _buffer = batch.concat(_buffer);
    }
  }

  // ===== INIT & LIFECYCLE =====
  function start() {
    if (_initialized) return;
    _initialized = true;

    console.log("[EZAP-CAPTURE] Message capture started (user:", getUserId(), ")");

    // Scan periodically via bridge
    _scanTimer = setInterval(function() {
      if (!isExtValid()) { stop(); return; }
      requestMessages();
    }, SCAN_INTERVAL_MS);

    // Sync periodically
    _syncTimer = setInterval(function() {
      if (!isExtValid()) { stop(); return; }
      syncBuffer();
    }, SYNC_INTERVAL_MS);

    // First scan after a short delay (let Store populate)
    setTimeout(requestMessages, 5000);
  }

  function stop() {
    if (_scanTimer) { clearInterval(_scanTimer); _scanTimer = null; }
    if (_syncTimer) { clearInterval(_syncTimer); _syncTimer = null; }
    _initialized = false;
    // Final sync attempt
    if (_buffer.length > 0) syncBuffer();
  }

  // ===== WAIT FOR AUTH THEN START =====
  function waitAndStart() {
    var attempts = 0;
    var waitTimer = setInterval(function() {
      attempts++;
      if (!isExtValid() || attempts > 120) { clearInterval(waitTimer); return; }
      if (getUserId()) {
        clearInterval(waitTimer);
        setTimeout(start, 5000);  // Wait for Store to be ready
      }
    }, 2000);
  }

  // Expose stats for debugging (call _ezapCaptureStats() in console)
  window._ezapCaptureStats = function() {
    return {
      initialized: _initialized,
      buffer: _buffer.length,
      knownWids: _knownWidsCount,
      trackedChats: Object.keys(_chatLastTs).length,
      totalCaptured: _totalCaptured,
      totalSynced: _totalSynced
    };
  };

  // Resume scanning when tab becomes visible
  document.addEventListener("visibilitychange", function() {
    if (!document.hidden && _initialized) setTimeout(requestMessages, 1000);
  });

  waitAndStart();
})();
