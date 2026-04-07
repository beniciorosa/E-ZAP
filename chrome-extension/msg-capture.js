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
  var TR_QUEUE_INTERVAL_MS = 25000; // Process transcription queue every 25s
  var TR_MAX_DURATION = 300;       // Max audio duration to transcribe (5 min)
  var TR_DELAY_BETWEEN_MS = 3000;  // Delay between transcriptions

  // ===== STATE =====
  var _buffer = [];                // Pending events to sync
  var _knownWids = {};             // message_wid -> true (dedup)
  var _knownWidsCount = 0;
  var _scanTimer = null;
  var _syncTimer = null;
  var _trTimer = null;             // Transcription queue timer
  var _initialized = false;
  var _chatLastTs = {};            // chat_jid -> last captured timestamp (unix s)
  var _syncInProgress = false;
  var _totalCaptured = 0;
  var _totalSynced = 0;
  var _pendingReqId = null;

  // ===== TRANSCRIPTION STATE =====
  var _trQueue = [];               // [{wid, duration}] audio msgs to transcribe
  var _trProcessing = false;       // true while transcribing
  var _trDoneWids = {};            // wid -> true (already transcribed or attempted)
  var _trDoneCount = 0;
  var _trTotalDone = 0;
  var _trTotalErrors = 0;
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

  function isExtValid() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
  }

  // ===== BRIDGE: Request messages from MAIN world =====
  function requestMessages() {
    if (!getUserId()) return;
    if (document.hidden) return;
    if (_pendingReqId) return;

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
    // Bridge response received

    if (!d.ok || !d.events || !d.events.length) return;

    var userId = getUserId();
    // mentorPhone: prefer allowedPhones (real number), bridge may return LID
    var mentorPhone = getMentorPhone() || (d.events.length && d.events[0].mentorPhone) || '';
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
        transcription_status: (e.messageType === 'audio' && _trEnabled) ? 'pending' : null
      };

      _buffer.push(row);
      newCount++;
      _totalCaptured++;
    }

    if (newCount > 0) {
      console.log("[EZAP-CAPTURE] Captured", newCount, "new messages (buffer:", _buffer.length, ")");
    }

    // Queue audio messages for transcription
    if (_trEnabled && events.length > 0) {
      queueForTranscription(events);
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

  // ===== TRANSCRIPTION QUEUE =====
  function hasTranscribeFeature() {
    return !!(window.__ezapHasFeature && window.__ezapHasFeature('transcribe'));
  }

  function queueForTranscription(events) {
    if (!_trEnabled) return;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      // Only queue audio/ptt messages that haven't been processed
      if ((e.messageType === 'audio') && !_trDoneWids[e.wid]) {
        // Skip very long audios to save costs
        if (e.duration && e.duration > TR_MAX_DURATION) {
          _trDoneWids[e.wid] = true;
          _trDoneCount++;
          continue;
        }
        _trQueue.push({ wid: e.wid, duration: e.duration || 0 });
      }
    }
    if (_trQueue.length > 0) {
      console.log("[EZAP-CAPTURE] Queued", _trQueue.length, "audio msgs for transcription");
    }
  }

  function processTranscribeQueue() {
    if (_trProcessing || _trQueue.length === 0) return;
    if (!getUserId() || !isExtValid()) return;
    if (!_trEnabled) return;
    if (document.hidden) return; // Don't transcribe when tab is hidden

    _trProcessing = true;
    var item = _trQueue.shift();
    item.retries = item.retries || 0;

    // Skip if already done (might have been added twice)
    if (_trDoneWids[item.wid]) {
      _trProcessing = false;
      if (_trQueue.length > 0) setTimeout(processTranscribeQueue, 500);
      return;
    }

    console.log("[EZAP-CAPTURE] Transcribing audio:", item.wid, "dur:", item.duration + "s", "retry:", item.retries);

    // Step 1: Download audio from WA Store via bridge
    downloadAudioFromBridge(item.wid)
      .then(function(audioData) {
        if (!audioData || !audioData.base64) {
          throw new Error('Audio download failed');
        }
        // Step 2: Send to background for transcription + save
        return new Promise(function(resolve) {
          if (!isExtValid()) { resolve({ error: 'Extension invalidated' }); return; }
          try {
            chrome.runtime.sendMessage({
              action: 'transcribe_and_save',
              base64: audioData.base64,
              contentType: audioData.mimeType || 'audio/ogg',
              messageWid: item.wid,
              userId: getUserId()
            }, function(resp) {
              if (chrome.runtime.lastError) {
                resolve({ error: chrome.runtime.lastError.message });
              } else {
                resolve(resp || { error: 'No response' });
              }
            });
          } catch(e) {
            resolve({ error: e.message });
          }
        });
      })
      .then(function(result) {
        _trDoneWids[item.wid] = true;
        _trDoneCount++;
        if (result && result.error) {
          _trTotalErrors++;
          console.warn("[EZAP-CAPTURE] Transcription error:", item.wid, result.error);
        } else {
          _trTotalDone++;
          console.log("[EZAP-CAPTURE] Transcribed:", item.wid, "=>", (result && result.text || '').substring(0, 60));
        }
      })
      .catch(function(err) {
        // Re-queue for retry if download failed (max 3 retries, with increasing delay)
        if (item.retries < 3) {
          item.retries++;
          _trQueue.push(item); // Push to end of queue for later retry
          console.log("[EZAP-CAPTURE] Audio download failed, re-queued (retry " + item.retries + "/3):", item.wid);
        } else {
          _trDoneWids[item.wid] = true;
          _trDoneCount++;
          _trTotalErrors++;
          console.warn("[EZAP-CAPTURE] Transcription failed after 3 retries:", item.wid, err.message);
          // Update DB status to error so we know it failed
          try {
            chrome.runtime.sendMessage({
              action: "supabase_rest",
              path: "/rest/v1/message_events?message_wid=eq." + encodeURIComponent(item.wid),
              method: "PATCH",
              body: { transcription_status: "error" },
              prefer: "return=minimal"
            });
          } catch(e) {}
        }
      })
      .finally(function() {
        _trProcessing = false;
        // Prevent dedup cache bloat
        if (_trDoneCount > 5000) {
          _trDoneWids = {};
          _trDoneCount = 0;
        }
        // Process next with delay (longer delay for retries)
        if (_trQueue.length > 0) {
          setTimeout(processTranscribeQueue, TR_DELAY_BETWEEN_MS);
        }
      });
  }

  // Download audio blob from MAIN world via postMessage bridge
  function downloadAudioFromBridge(wid) {
    return new Promise(function(resolve) {
      var dlId = "dl_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);
      var resolved = false;

      function handler(event) {
        if (!event.data || event.source !== window) return;
        if (event.data.type !== '_ezap_download_audio_res') return;
        if (event.data.id !== dlId) return;
        resolved = true;
        window.removeEventListener('message', handler);

        if (event.data.ok) {
          resolve({
            base64: event.data.base64,
            mimeType: event.data.mimeType,
            duration: event.data.duration || 0
          });
        } else {
          console.warn("[EZAP-CAPTURE] Audio download failed:", event.data.error);
          resolve(null);
        }
      }

      window.addEventListener('message', handler);
      window.postMessage({
        type: '_ezap_download_audio_req',
        id: dlId,
        wid: wid
      }, '*');

      // Timeout after 15s
      setTimeout(function() {
        if (!resolved) {
          resolved = true;
          window.removeEventListener('message', handler);
          console.warn("[EZAP-CAPTURE] Audio download timeout:", wid);
          resolve(null);
        }
      }, 15000);
    });
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

    // Check if transcription feature is enabled
    _trEnabled = hasTranscribeFeature();
    console.log("[EZAP-CAPTURE] Message capture started (user:", getUserId(), ", transcribe:", _trEnabled, ")");

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

    // Transcription queue processor
    if (_trEnabled) {
      _trTimer = setInterval(function() {
        if (!isExtValid()) { stop(); return; }
        processTranscribeQueue();
      }, TR_QUEUE_INTERVAL_MS);
    }

    // First scan after a short delay (let Store populate)
    setTimeout(requestMessages, 5000);
  }

  function stop() {
    if (_scanTimer) { clearInterval(_scanTimer); _scanTimer = null; }
    if (_syncTimer) { clearInterval(_syncTimer); _syncTimer = null; }
    if (_trTimer) { clearInterval(_trTimer); _trTimer = null; }
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
      totalSynced: _totalSynced,
      transcribe: {
        enabled: _trEnabled,
        queue: _trQueue.length,
        processing: _trProcessing,
        done: _trTotalDone,
        errors: _trTotalErrors,
        dedupCache: _trDoneCount
      }
    };
  };

  // Resume scanning when tab becomes visible
  document.addEventListener("visibilitychange", function() {
    if (!document.hidden && _initialized) setTimeout(requestMessages, 1000);
  });

  waitAndStart();
})();
