// ===== E-ZAP Audio Transcription =====
// Content script (isolated world) - communicates with transcribe-interceptor.js (main world) via postMessage
(function() {
  "use strict";
  console.log("[EZAP-TR] Transcribe module loaded");

  var cache = {};  // rowId -> transcription text
  var busy = {};   // rowId -> true while processing
  var _dbCache = {}; // wid -> transcript text (from DB)
  var _dbChecked = {}; // wid -> true (already checked DB)

  // ===== Check DB for existing transcripts (batch) =====
  function checkDbTranscripts(wids) {
    if (!wids.length) return Promise.resolve({});
    // Filter out already checked WIDs
    var toCheck = [];
    for (var i = 0; i < wids.length; i++) {
      if (!_dbChecked[wids[i]]) toCheck.push(wids[i]);
    }
    if (!toCheck.length) return Promise.resolve({});

    return new Promise(function(resolve) {
      // Build OR filter for PostgREST: message_wid=in.(wid1,wid2,...)
      // Only check messages that have transcription_status=done
      var widList = toCheck.map(function(w) { return '"' + w.replace(/"/g, '') + '"'; }).join(',');
      var path = "/rest/v1/message_events?message_wid=in.(" + widList + ")&transcription_status=eq.done&select=message_wid,transcript";

      try {
        chrome.runtime.sendMessage({
          action: "supabase_rest",
          path: path,
          method: "GET"
        }, function(resp) {
          if (chrome.runtime.lastError) {
            console.warn("[EZAP-TR] DB check error:", chrome.runtime.lastError.message);
            resolve({});
            return;
          }
          var result = {};
          if (Array.isArray(resp)) {
            for (var r = 0; r < resp.length; r++) {
              if (resp[r].transcript) {
                result[resp[r].message_wid] = resp[r].transcript;
                _dbCache[resp[r].message_wid] = resp[r].transcript;
              }
            }
          }
          // Mark all as checked (even if no transcript found)
          for (var c = 0; c < toCheck.length; c++) {
            _dbChecked[toCheck[c]] = true;
          }
          resolve(result);
        });
      } catch(e) {
        resolve({});
      }
    });
  }

  // Check DB for a single WID
  function getTranscriptFromDb(wid) {
    if (_dbCache[wid]) return Promise.resolve(_dbCache[wid]);
    return new Promise(function(resolve) {
      var path = "/rest/v1/message_events?message_wid=eq." + encodeURIComponent(wid) + "&transcription_status=eq.done&select=transcript";
      try {
        chrome.runtime.sendMessage({
          action: "supabase_rest",
          path: path,
          method: "GET"
        }, function(resp) {
          if (chrome.runtime.lastError) { resolve(null); return; }
          if (Array.isArray(resp) && resp.length > 0 && resp[0].transcript) {
            _dbCache[wid] = resp[0].transcript;
            resolve(resp[0].transcript);
          } else {
            resolve(null);
          }
        });
      } catch(e) { resolve(null); }
    });
  }

  // ===== Scan for audio messages and inject buttons =====
  var _scanDebounce = null;
  function scan() {
    var selectors = [
      'span[data-icon="ptt"]', 'span[data-icon="ptt-out"]',
      'span[data-icon="audio-play"]', 'span[data-icon="ptt-play"]',
      '[data-testid="audio-play"]', '[data-testid="ptt-play"]',
      '[data-testid="ptt-duration"]', '[data-testid="audio-seekbar"]',
      'button[aria-label*="Ouvir"]', 'button[aria-label*="Reproduzir"]',
      'button[aria-label*="Play"]'
    ];
    var found = document.querySelectorAll(selectors.join(','));
    var newRows = [];
    var newWids = [];

    for (var i = 0; i < found.length; i++) {
      var msgRow = found[i].closest('div[role="row"]') ||
                   found[i].closest('div[data-id]');
      if (msgRow && !msgRow.querySelector('.ezap-tr-btn')) {
        newRows.push({ row: msgRow, indicator: found[i] });
        var wid = getRowId(msgRow);
        if (wid) newWids.push(wid);
      }
    }

    if (newRows.length === 0) return;

    // Check DB for existing transcripts in batch
    checkDbTranscripts(newWids).then(function(dbResults) {
      for (var j = 0; j < newRows.length; j++) {
        // Double-check it wasn't injected while we waited for DB
        if (!newRows[j].row.querySelector('.ezap-tr-btn')) {
          var wid = getRowId(newRows[j].row);
          var hasTranscript = !!(dbResults[wid] || _dbCache[wid]);
          injectButton(newRows[j].row, newRows[j].indicator, hasTranscript);
        }
      }
    });
  }

  function injectButton(msgRow, audioIndicator, hasTranscript) {
    var btn = document.createElement('div');
    btn.className = 'ezap-tr-btn';
    if (hasTranscript) btn.classList.add('ezap-tr-cached');
    btn.innerHTML = 'Aa';
    btn.title = hasTranscript ? 'Ver transcricao (salva)' : 'Transcrever audio';
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      onTranscribeClick(msgRow, btn);
    });

    // Find the actual audio bubble (the colored rounded container)
    var bubble = null;
    var el = audioIndicator;
    for (var i = 0; i < 12; i++) {
      if (!el.parentElement || el.parentElement === msgRow) break;
      el = el.parentElement;
      try {
        var bg = window.getComputedStyle(el).backgroundColor;
        if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)' &&
            el.offsetWidth > 100 && el.offsetWidth < 600) {
          bubble = el;
          break;
        }
      } catch(e2) {}
    }

    if (!bubble) {
      bubble = msgRow.querySelector('[data-testid="msg-container"]') || msgRow;
    }

    bubble.setAttribute('data-ezap-bubble', '1');
    bubble.style.position = 'relative';
    bubble.appendChild(btn);
  }

  // ===== Click handler =====
  function onTranscribeClick(row, btn) {
    var id = getRowId(row);

    // Check local cache first
    if (cache[id]) {
      var existing = row.querySelector('.ezap-tr-box');
      if (existing) {
        existing.style.display = existing.style.display === 'none' ? '' : 'none';
      } else {
        renderTranscript(row, cache[id]);
      }
      return;
    }

    if (busy[id]) return;
    busy[id] = true;

    btn.innerHTML = '';
    var spinner = document.createElement('span');
    spinner.className = 'ezap-tr-spin';
    btn.appendChild(spinner);
    btn.style.pointerEvents = 'none';

    doTranscribe(row)
      .then(function(text) {
        cache[id] = text;
        renderTranscript(row, text);
        btn.innerHTML = 'Aa';
        btn.classList.add('ezap-tr-done');
        btn.classList.add('ezap-tr-cached');
      })
      .catch(function(err) {
        console.error('[EZAP-TR]', err);
        renderError(row, err.message || 'Erro na transcricao');
        btn.innerHTML = 'Aa';
      })
      .finally(function() {
        btn.style.pointerEvents = '';
        delete busy[id];
      });
  }

  // ===== Core transcription flow =====
  async function doTranscribe(row) {
    var messageWid = getRowId(row);

    // Step 1: Check DB for existing transcript (instant, no Whisper cost)
    var dbText = await getTranscriptFromDb(messageWid);
    if (dbText && dbText.trim()) {
      console.log('[EZAP-TR] Found transcript in DB, skipping Whisper:', messageWid);
      return dbText.trim();
    }

    // Step 2: No transcript in DB — do the full flow (play + Whisper + save)
    var b64 = await getAudioBase64(row);
    if (!b64) throw new Error('Audio nao encontrado');

    var userId = (window.__wcrmAuth && window.__wcrmAuth.userId) || null;

    var result = await new Promise(function(resolve) {
      chrome.runtime.sendMessage({
        action: 'transcribe_and_save',
        base64: b64.data,
        contentType: b64.type,
        messageWid: messageWid,
        userId: userId
      }, function(resp) {
        resolve(resp || { error: 'Sem resposta do background' });
      });
    });

    if (result.error) throw new Error(result.error);
    if (!result.text || !result.text.trim()) throw new Error('Transcricao vazia');

    // Cache locally and in DB cache
    var text = result.text.trim();
    _dbCache[messageWid] = text;

    return text;
  }

  // ===== Audio extraction (via main world interceptor) =====
  async function getAudioBase64(row) {
    // Mute all media
    muteAll();

    // Get blob count before triggering play
    var countBefore = await getBlobCount();
    console.log('[EZAP-TR] Blob count before play:', countBefore);

    // Find and click play
    var playBtn = findPlayButton(row);
    if (!playBtn) {
      unmuteAll();
      throw new Error('Botao play nao encontrado');
    }

    // Tell interceptor to mute the next play call
    window.postMessage({ type: '_ezap_mute_next' }, '*');

    console.log('[EZAP-TR] Clicking play (muted)...');
    playBtn.click();

    // Wait for new audio blob to be captured by interceptor
    var result = await waitForNewAudio(countBefore, 12000);

    // Stop playback and restore
    stopAll();
    unmuteAll();

    return result;
  }

  function findPlayButton(row) {
    var btn = row.querySelector('button[aria-label*="Play" i]') ||
              row.querySelector('button[aria-label*="Reproduzir"]') ||
              row.querySelector('button[aria-label*="Ouvir"]') ||
              row.querySelector('[data-testid="audio-play"]') ||
              row.querySelector('[data-testid="ptt-play"]');

    if (!btn) {
      var icon = row.querySelector('span[data-icon="audio-play"]') ||
                 row.querySelector('span[data-icon="ptt-play"]');
      if (icon) btn = icon.closest('button') || icon.parentElement;
    }

    return btn;
  }

  function getBlobCount() {
    return new Promise(function(resolve) {
      var checkId = '_chk_' + Math.random().toString(36).substr(2, 6);

      function handler(e) {
        if (e.data && e.data.type === '_ezap_blob_count' && e.data.id === checkId) {
          window.removeEventListener('message', handler);
          resolve(e.data.count);
        }
      }
      window.addEventListener('message', handler);
      window.postMessage({ type: '_ezap_blob_count_req', id: checkId }, '*');

      setTimeout(function() {
        window.removeEventListener('message', handler);
        resolve(0);
      }, 2000);
    });
  }

  function waitForNewAudio(countBefore, timeoutMs) {
    return new Promise(function(resolve) {
      var deadline = Date.now() + timeoutMs;
      var resolved = false;

      function check() {
        if (resolved) return;
        if (Date.now() > deadline) {
          resolved = true;
          console.warn('[EZAP-TR] Timeout, trying to get latest blob anyway...');
          requestBlob(null).then(resolve);
          return;
        }

        muteAll();

        var checkId = '_chk_' + Math.random().toString(36).substr(2, 6);

        function handler(e) {
          if (resolved) return;
          if (e.data && e.data.type === '_ezap_blob_count' && e.data.id === checkId) {
            window.removeEventListener('message', handler);
            if (e.data.count > countBefore) {
              resolved = true;
              console.log('[EZAP-TR] New blob captured! Count:', e.data.count);
              requestBlob(null).then(resolve);
            } else {
              // Check for media elements with blob src
              var media = document.querySelector('audio[src^="blob:"], video[src^="blob:"]');
              if (media && media.src) {
                resolved = true;
                console.log('[EZAP-TR] Found media element:', media.tagName, media.src.substr(0, 40));
                requestBlob(media.src).then(resolve);
              } else {
                setTimeout(check, 250);
              }
            }
          }
        }
        window.addEventListener('message', handler);
        window.postMessage({ type: '_ezap_blob_count_req', id: checkId }, '*');
      }

      check();
    });
  }

  function requestBlob(url) {
    return new Promise(function(resolve) {
      var cbId = '_gb_' + Math.random().toString(36).substr(2, 8);

      function handler(e) {
        if (e.data && e.data.type === '_ezap_audio_result' && e.data.id === cbId) {
          window.removeEventListener('message', handler);
          if (e.data.error) {
            console.warn('[EZAP-TR] Blob error:', e.data.error);
            resolve(null);
          } else {
            resolve({ data: e.data.base64, type: e.data.mimeType });
          }
        }
      }
      window.addEventListener('message', handler);
      window.postMessage({ type: '_ezap_get_audio', id: cbId, url: url }, '*');

      setTimeout(function() {
        window.removeEventListener('message', handler);
        resolve(null);
      }, 8000);
    });
  }

  function muteAll() {
    document.querySelectorAll('audio, video').forEach(function(el) {
      el.volume = 0; el.muted = true;
    });
  }
  function unmuteAll() {
    document.querySelectorAll('audio, video').forEach(function(el) {
      el.volume = 1; el.muted = false;
    });
  }
  function stopAll() {
    document.querySelectorAll('audio, video').forEach(function(el) {
      try { el.pause(); el.currentTime = 0; } catch(e) {}
    });
  }

  // ===== Render transcript =====
  function renderTranscript(row, text) {
    var old = row.querySelector('.ezap-tr-box');
    if (old) old.remove();

    var box = document.createElement('div');
    box.className = 'ezap-tr-box';

    var truncated = text.length > 300;
    var shortText = truncated ? text.substring(0, 300).trim() + '...' : text;

    // Transcript text
    var textDiv = document.createElement('div');
    textDiv.className = 'ezap-tr-text';
    textDiv.textContent = '\uD83E\uDD16 ' + shortText;
    box.appendChild(textDiv);

    // Action buttons row
    var actions = document.createElement('div');
    actions.className = 'ezap-tr-actions';

    if (truncated) {
      var moreBtn = document.createElement('span');
      moreBtn.className = 'ezap-tr-action';
      moreBtn.textContent = 'Ler mensagem completa';
      moreBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (moreBtn.textContent === 'Ler mensagem completa') {
          textDiv.textContent = '\uD83E\uDD16 ' + text;
          moreBtn.textContent = 'Ver menos';
        } else {
          textDiv.textContent = '\uD83E\uDD16 ' + shortText;
          moreBtn.textContent = 'Ler mensagem completa';
        }
      });
      actions.appendChild(moreBtn);
    }

    var copyBtn = document.createElement('span');
    copyBtn.className = 'ezap-tr-action';
    copyBtn.textContent = 'Copiar';
    copyBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      navigator.clipboard.writeText(text).then(function() {
        copyBtn.textContent = 'Copiado!';
        setTimeout(function() { copyBtn.textContent = 'Copiar'; }, 2000);
      });
    });
    actions.appendChild(copyBtn);

    box.appendChild(actions);

    // Insert INSIDE the bubble, locking its width so transcript doesn't expand it
    var bubble = row.querySelector('[data-ezap-bubble]') ||
                 row.querySelector('[data-testid="msg-container"]') || row;
    if (!bubble.style.maxWidth) {
      bubble.style.maxWidth = bubble.offsetWidth + 'px';
    }
    bubble.appendChild(box);

    // Scroll into view
    setTimeout(function() {
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
  }

  function renderError(row, msg) {
    var old = row.querySelector('.ezap-tr-box');
    if (old) old.remove();

    var box = document.createElement('div');
    box.className = 'ezap-tr-box ezap-tr-err';
    box.textContent = msg;

    var bubble = row.querySelector('[data-ezap-bubble]') ||
                 row.querySelector('[data-testid="msg-container"]') || row;
    bubble.appendChild(box);

    setTimeout(function() { if (box.parentElement) box.remove(); }, 6000);
  }

  // ===== Helpers =====
  function getRowId(row) {
    var id = row.getAttribute('data-id');
    if (id) return id;
    var child = row.querySelector('[data-id]');
    if (child) return child.getAttribute('data-id');
    return 'tr_' + Array.from(row.parentElement.children).indexOf(row);
  }

  // ===== Observer =====
  function start() {
    console.log('[EZAP-TR] Starting observer');

    var debounceTimer = null;
    var observer = new MutationObserver(function() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(scan, 300);
    });

    var app = document.getElementById('app');
    if (app) {
      observer.observe(app, { childList: true, subtree: true });
    }

    scan();
    setInterval(scan, 4000);
  }

  // ===== Init =====
  function tryStart() {
    if (window.__ezapHasFeature && window.__ezapHasFeature('transcribe')) {
      console.log('[EZAP-TR] Feature enabled, starting');
      setTimeout(start, 1500);
    } else {
      console.log('[EZAP-TR] Feature "transcribe" not enabled for this user');
    }
  }

  document.addEventListener('wcrm-auth-ready', function() {
    console.log('[EZAP-TR] Auth ready');
    tryStart();
  });

  if (window.__wcrmAuth) setTimeout(tryStart, 3000);
})();
