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
  var SCAN_INTERVAL_MS = 15000;    // Request messages every 15s
  var SYNC_INTERVAL_MS = 20000;    // Sync buffer to Supabase every 20s
  var MAX_BUFFER_SIZE = 200;       // Max buffered events before forced sync
  var DEDUP_CACHE_MAX = 15000;     // Max known message IDs in memory
  // OLD download-based transcription pipeline DISABLED (v1.9.17)
  // Auto-transcription now handled by interceptor (transcribe-interceptor.js)
  // var TR_QUEUE_INTERVAL_MS = 25000;
  // var TR_MAX_DURATION = 300;
  // var TR_DELAY_BETWEEN_MS = 3000;

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
  var _warmupScans = 0;            // Don't filter by timestamp during warmup (partial-load fix)

  // ===== TRANSCRIPTION STATE =====
  var _trDoneWids = {};            // wid -> true (already transcribed or attempted)
  var _trDoneCount = 0;
  var _trEnabled = false;          // set to true if user has 'transcribe' feature

  // ===== HELPERS =====
  function getUserId() {
    return (window.__wcrmAuth && window.__wcrmAuth.userId) || null;
  }

  function getMentorPhone() {
    // Priority: 1) userPhone from DB, 2) first allowedPhone (always has real number)
    if (window.__wcrmAuth) {
      if (window.__wcrmAuth.userPhone) return window.__wcrmAuth.userPhone;
      if (window.__wcrmAuth.allowedPhones && window.__wcrmAuth.allowedPhones.length) {
        return window.__wcrmAuth.allowedPhones[0].replace(/\D/g, '');
      }
    }
    return "";
  }

  var _extInvalidCount = 0;  // Track consecutive invalid checks
  var EXT_INVALID_MAX = 30;  // Only stop after 30 consecutive failures (~5 min)

  function isExtValid() {
    try {
      var valid = !!(chrome && chrome.runtime && chrome.runtime.id);
      if (valid) { _extInvalidCount = 0; return true; }
      _extInvalidCount++;
      console.warn("[EZAP-CAPTURE] Extension temporarily invalid (" + _extInvalidCount + "/" + EXT_INVALID_MAX + ")");
      return false;
    }
    catch (e) {
      _extInvalidCount++;
      return false;
    }
  }

  // Check if we should permanently stop (many consecutive failures)
  function shouldStop() {
    return _extInvalidCount >= EXT_INVALID_MAX;
  }

  // ===== BRIDGE: Request messages from MAIN world =====
  function requestMessages() {
    if (!getUserId()) return;
    if (document.hidden) return;
    if (_pendingReqId) return;

    var reqId = "cap_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);
    _pendingReqId = reqId;
    // During warmup (first 4 scans), don't filter by timestamp.
    // Fiber Store loads messages partially — first scan may get only a few msgs per chat,
    // setting _chatLastTs too high and filtering out messages that load later.
    var useTs = _warmupScans >= 4 ? _chatLastTs : {};
    window.postMessage({
      type: "_ezap_get_msgs_req",
      id: reqId,
      sinceTs: useTs,
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
    _warmupScans++;
    var d = event.data;
    console.log('[EZAP-CAPTURE] Response received: ok=' + d.ok + ', events=' + (d.events ? d.events.length : 0) + ', warmup=' + _warmupScans);

    if (!d.ok || !d.events || !d.events.length) return;

    var userId = getUserId();
    var mentorPhone = getMentorPhone() || (d.events.length && d.events[0].mentorPhone) || '';
    if (!userId) { console.warn('[EZAP-CAPTURE] No userId, skipping'); return; }

    var events = d.events;
    var newCount = 0;

    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (!e.wid) continue;

      // Dedup by WID (handles warmup duplicates)
      if (_knownWids[e.wid]) continue;
      _knownWids[e.wid] = true;
      _knownWidsCount++;

      // Track newest timestamp per chat (only after warmup to avoid partial-load issue)
      if (_warmupScans >= 4 && (!_chatLastTs[e.chatJid] || e.timestamp > _chatLastTs[e.chatJid])) {
        _chatLastTs[e.chatJid] = e.timestamp;
      }

      // Build Supabase row
      var row = {
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
        timestamp: new Date(e.timestamp * 1000).toISOString(),
        transcription_status: null  // Set to 'done' by auto-transcribe when played/sent
      };

      _buffer.push(row);
      newCount++;
      _totalCaptured++;
    }

    if (newCount > 0) {
      console.log("[EZAP-CAPTURE] Captured", newCount, "new messages (buffer:", _buffer.length, ", known:", _knownWidsCount, ")");
    } else {
      console.log("[EZAP-CAPTURE] 0 new (all", events.length, "deduplicated, known:", _knownWidsCount, ")");
    }

    // Sync LID->phone mappings if any were discovered
    if (d.lidMappings && d.lidMappings.length > 0) {
      syncLidMappings(d.lidMappings);
    }

    // Prevent memory bloat on dedup cache
    if (_knownWidsCount > DEDUP_CACHE_MAX) {
      _knownWids = {};
      _knownWidsCount = 0;
    }

    // Force sync if buffer is large
    if (_buffer.length >= MAX_BUFFER_SIZE) syncBuffer();
  });

  // ===== TRANSCRIPTION =====
  // Old download-based queue REMOVED (v1.9.17)
  // Transcription now happens via interceptor auto-capture (play/send)
  function hasTranscribeFeature() {
    return !!(window.__ezapHasFeature && window.__ezapHasFeature('transcribe'));
  }

  // ===== LID -> PHONE MAPPING SYNC =====
  var _lidSyncedCache = {};  // Prevent re-syncing same LIDs
  var _lidSyncedCount = 0;

  function syncLidMappings(mappings) {
    if (!isExtValid() || !mappings || !mappings.length) return;

    // Filter out already synced LIDs
    var toSync = [];
    for (var i = 0; i < mappings.length; i++) {
      var m = mappings[i];
      if (m.lid && m.phone && !_lidSyncedCache[m.lid]) {
        toSync.push({
          lid: m.lid,
          phone: m.phone,
          contact_name: m.contact_name || null,
          updated_at: new Date().toISOString()
        });
        _lidSyncedCache[m.lid] = true;
        _lidSyncedCount++;
      }
    }

    if (!toSync.length) return;

    try {
      chrome.runtime.sendMessage({
        action: "supabase_rest",
        path: "/rest/v1/lid_phone_map",
        method: "POST",
        body: toSync,
        prefer: "resolution=merge-duplicates,return=minimal"
      }, function(resp) {
        if (chrome.runtime.lastError) {
          // Revert cache on error so we retry next time
          for (var j = 0; j < toSync.length; j++) {
            delete _lidSyncedCache[toSync[j].lid];
            _lidSyncedCount--;
          }
        }
      });
    } catch(e) {}

    // Prevent cache bloat
    if (_lidSyncedCount > 2000) {
      _lidSyncedCache = {};
      _lidSyncedCount = 0;
    }
  }

  // ===== SYNC TO SUPABASE =====
  function syncBuffer() {
    console.log('[EZAP-CAPTURE] syncBuffer() called — buffer=' + _buffer.length + ', inProgress=' + _syncInProgress + ', userId=' + !!getUserId() + ', extValid=' + isExtValid());
    if (_syncInProgress) { console.log('[EZAP-CAPTURE] syncBuffer SKIP: _syncInProgress=true'); return; }
    if (_buffer.length === 0) return;
    if (!getUserId()) { console.log('[EZAP-CAPTURE] syncBuffer SKIP: no userId'); return; }
    if (!isExtValid()) { console.log('[EZAP-CAPTURE] syncBuffer SKIP: ext invalid'); return; }

    _syncInProgress = true;
    var batch = _buffer.splice(0, 50);  // Max 50 per request

    // Normalize keys: PostgREST requires all objects in a batch to have the same keys (PGRST102)
    // Some rows may have transcript/transcription_status from auto-transcribe, others don't
    var allKeys = {};
    for (var k = 0; k < batch.length; k++) {
      var rowKeys = Object.keys(batch[k]);
      for (var j = 0; j < rowKeys.length; j++) {
        allKeys[rowKeys[j]] = true;
      }
    }
    var keyList = Object.keys(allKeys);
    for (var k = 0; k < batch.length; k++) {
      for (var j = 0; j < keyList.length; j++) {
        if (!(keyList[j] in batch[k])) {
          batch[k][keyList[j]] = null;
        }
      }
    }

    console.log('[EZAP-CAPTURE] Sending batch of', batch.length, 'to Supabase...');
    try {
      chrome.runtime.sendMessage({
        action: "supabase_rest",
        path: "/rest/v1/message_events?on_conflict=user_id,message_wid",
        method: "POST",
        body: batch,
        prefer: "resolution=ignore-duplicates,return=minimal"
      }, function(resp) {
        _syncInProgress = false;
        console.log('[EZAP-CAPTURE] Sync callback fired — lastError:', chrome.runtime.lastError ? chrome.runtime.lastError.message : 'none', ', resp:', JSON.stringify(resp).substring(0, 200));
        if (chrome.runtime.lastError) {
          console.warn("[EZAP-CAPTURE] Sync error:", chrome.runtime.lastError.message);
          _buffer = batch.concat(_buffer);
          return;
        }
        if (resp && (resp.error || resp.message)) {
          var errStr = String(resp.error || resp.message || "");
          if (errStr.indexOf("duplicate") >= 0 || errStr.indexOf("unique") >= 0 || errStr.indexOf("already exists") >= 0 || errStr.indexOf("23505") >= 0) {
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
      console.error('[EZAP-CAPTURE] syncBuffer EXCEPTION:', e.message);
      _syncInProgress = false;
      _buffer = batch.concat(_buffer);
    }
  }

  // ===== INIT & LIFECYCLE =====
  function start() {
    if (_initialized) return;
    _initialized = true;

    // Check if transcription feature is enabled
    _trEnabled = hasTranscribeFeature();
    console.log("[EZAP-CAPTURE] Message capture started (user:", getUserId(), ", transcribe:", _trEnabled, ")");

    // Scan periodically via bridge
    _scanTimer = setInterval(function() {
      if (!isExtValid()) { if (shouldStop()) stop(); return; }
      requestMessages();
    }, SCAN_INTERVAL_MS);

    // Sync periodically
    _syncTimer = setInterval(function() {
      if (!isExtValid()) { if (shouldStop()) stop(); return; }
      syncBuffer();
    }, SYNC_INTERVAL_MS);

    // Listen for auto-transcription events from interceptor (MAIN world)
    if (_trEnabled) {
      window.addEventListener('message', function(event) {
        if (!event.data || event.source !== window) return;
        if (event.data.type !== '_ezap_auto_transcribe') return;
        handleAutoTranscribe(event.data);
      });
      console.log("[EZAP-CAPTURE] Auto-transcribe listener active");
    }

    // First scan after a short delay (let Store populate)
    setTimeout(requestMessages, 5000);
  }

  // Handle auto-transcription from interceptor (audio played or sent)
  var _autoTrProcessing = false;
  var _autoTrDone = {};

  // Store pending transcriptions for messages not yet in DB
  var _pendingTranscripts = {}; // wid -> { text, timestamp }

  function handleAutoTranscribe(data) {
    if (!data.wid || !data.base64) return;
    if (!_trEnabled || !isExtValid()) return;
    if (_autoTrDone[data.wid]) return;

    // Validate mime type — skip non-audio blobs (images, thumbnails, etc.)
    var mime = (data.mimeType || '').toLowerCase();
    if (mime && mime.indexOf('audio') < 0 && mime.indexOf('ogg') < 0 && mime.indexOf('opus') < 0 && mime.indexOf('video/mp4') < 0 && mime.indexOf('video/webm') < 0 && mime.indexOf('application/ogg') < 0) {
      console.log("[EZAP-CAPTURE] Auto-transcribe skipped non-audio mime:", mime, data.wid);
      return;
    }

    // Skip very small blobs (likely notification sounds, not voice messages)
    if (data.size && data.size < 3000) {
      console.log("[EZAP-CAPTURE] Auto-transcribe skipped tiny blob:", data.size, data.wid);
      return;
    }

    _autoTrDone[data.wid] = true;
    console.log("[EZAP-CAPTURE] Auto-transcribe received:", data.wid, "size:", data.size, "mime:", mime, "source:", data.source);

    // Step 1: Transcribe via Whisper (just transcribe, don't save yet)
    try {
      chrome.runtime.sendMessage({
        action: 'transcribe_audio',
        base64: data.base64,
        contentType: data.mimeType || 'audio/ogg'
      }, function(resp) {
        if (chrome.runtime.lastError) {
          console.warn("[EZAP-CAPTURE] Auto-transcribe send error:", chrome.runtime.lastError.message);
          delete _autoTrDone[data.wid];
          return;
        }
        if (resp && resp.error) {
          console.warn("[EZAP-CAPTURE] Auto-transcribe Whisper error:", data.wid, resp.error);
          return;
        }
        var text = (resp && resp.text || '').trim();
        if (!text) {
          console.warn("[EZAP-CAPTURE] Auto-transcribe empty result:", data.wid);
          return;
        }
        console.log("[EZAP-CAPTURE] Auto-transcribed:", data.wid, "=>", text.substring(0, 80));

        // Step 2: Apply transcript to buffer row if still pending, or save to DB
        applyTranscript(data.wid, text);
      });
    } catch(e) {
      console.warn("[EZAP-CAPTURE] Auto-transcribe exception:", e.message);
      delete _autoTrDone[data.wid];
    }
  }

  function applyTranscript(wid, text) {
    // Check if message is still in our local buffer (not yet synced to DB)
    var foundInBuffer = false;
    for (var i = 0; i < _buffer.length; i++) {
      if (_buffer[i].message_wid === wid) {
        _buffer[i].transcript = text;
        _buffer[i].transcription_status = 'done';
        foundInBuffer = true;
        console.log("[EZAP-CAPTURE] Transcript applied to buffer row:", wid);
        break;
      }
    }

    if (foundInBuffer) return; // Will be saved with next buffer sync

    // Message already in DB — PATCH directly
    try {
      chrome.runtime.sendMessage({
        action: "supabase_rest",
        path: "/rest/v1/message_events?message_wid=eq." + encodeURIComponent(wid),
        method: "PATCH",
        body: { transcript: text, transcription_status: "done" },
        prefer: "return=minimal"
      }, function(resp) {
        if (chrome.runtime.lastError) {
          // DB save failed, store for retry
          _pendingTranscripts[wid] = { text: text, ts: Date.now() };
          console.warn("[EZAP-CAPTURE] Transcript DB save failed, stored for retry:", wid);
          return;
        }
        console.log("[EZAP-CAPTURE] Transcript saved to DB:", wid);
      });
    } catch(e) {
      _pendingTranscripts[wid] = { text: text, ts: Date.now() };
    }

    // Also mark as done in transcription queue
    _trDoneWids[wid] = true;
  }

  // Retry pending transcripts periodically (for race condition cases)
  setInterval(function() {
    var wids = Object.keys(_pendingTranscripts);
    if (wids.length === 0 || !isExtValid()) return;
    for (var i = 0; i < wids.length; i++) {
      var w = wids[i];
      var p = _pendingTranscripts[w];
      // Retry if older than 10 seconds
      if (Date.now() - p.ts < 10000) continue;
      try {
        (function(wid, text) {
          chrome.runtime.sendMessage({
            action: "supabase_rest",
            path: "/rest/v1/message_events?message_wid=eq." + encodeURIComponent(wid),
            method: "PATCH",
            body: { transcript: text, transcription_status: "done" },
            prefer: "return=minimal"
          }, function(resp) {
            if (!chrome.runtime.lastError) {
              delete _pendingTranscripts[wid];
              console.log("[EZAP-CAPTURE] Pending transcript saved:", wid);
            }
          });
        })(w, p.text);
      } catch(e) {}
    }
  }, 15000);

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
      if (attempts > 120) { clearInterval(waitTimer); return; }
      if (!isExtValid()) return; // Skip this tick, but keep trying
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
      totalSynced: _totalSynced,
      transcribe: {
        enabled: _trEnabled,
        dedupCache: _trDoneCount,
        pendingRetries: Object.keys(_pendingTranscripts).length
      }
    };
  };

  // Resume scanning when tab becomes visible
  document.addEventListener("visibilitychange", function() {
    if (!document.hidden && _initialized) setTimeout(requestMessages, 1000);
  });

  waitAndStart();
})();
