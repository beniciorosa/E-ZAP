// ===== E-ZAP Audio Interceptor (MAIN world) =====
// Intercepts multiple browser APIs to capture WhatsApp audio data
(function() {
  if (window._ezapTrReady) return;
  window._ezapTrReady = true;
  window._ezapCaptured = []; // {blob, time, source}

  function store(blob, source) {
    window._ezapCaptured.push({ blob: blob, time: Date.now(), source: source });
    if (window._ezapCaptured.length > 30) window._ezapCaptured.shift();

    // Auto-transcription: notify content script about new audio blob
    // Only for audio blobs larger than 2KB (skip tiny sounds/notifications)
    if (blob.size > 2000 && isAudioBlob(blob, source)) {
      notifyAutoTranscribe(blob, source);
    }
  }

  function isAudioBlob(blob, source) {
    var type = (blob.type || '').toLowerCase();
    if (type.indexOf('audio') >= 0 || type.indexOf('ogg') >= 0 || type.indexOf('opus') >= 0) return true;
    // createObjectURL blobs from WhatsApp are often audio even without proper MIME
    if (source.indexOf('play:') === 0 || source.indexOf('decodeAudio') === 0) return true;
    if (source.indexOf('srcSet:') === 0) return true;
    // Large blobs from createObjectURL are likely media
    if (source.indexOf('createObjectURL') === 0 && blob.size > 5000) return true;
    return false;
  }

  // Find the currently playing audio message WID from the DOM
  function findPlayingMsgWid() {
    // Look for playing/paused audio elements and trace back to msg row
    var audioEls = document.querySelectorAll('audio, video, [data-testid="audio-play"], span[data-icon="audio-pause"], span[data-icon="ptt-pause"]');
    for (var i = 0; i < audioEls.length; i++) {
      try {
        // Walk up to find the message row with data-id
        var el = audioEls[i];
        for (var j = 0; j < 20; j++) {
          if (!el) break;
          var dataId = el.getAttribute('data-id');
          if (dataId && dataId.indexOf('@') >= 0) return dataId;
          el = el.parentElement;
        }
      } catch(e) {}
    }
    // Also check for recently active audio rows
    try {
      var rows = document.querySelectorAll('div[data-id]');
      for (var r = rows.length - 1; r >= 0 && r >= rows.length - 50; r--) {
        var row = rows[r];
        var id = row.getAttribute('data-id');
        if (!id || id.indexOf('@') < 0) continue;
        // Check if this row has an audio element
        if (row.querySelector('span[data-icon*="ptt"], span[data-icon*="audio"], [data-testid*="ptt"], [data-testid*="audio"]')) {
          return id;
        }
      }
    } catch(e) {}
    return null;
  }

  var _autoTrSent = {}; // Track which WIDs we already sent for auto-transcription
  var _autoTrDebounce = null;

  function notifyAutoTranscribe(blob, source) {
    // Debounce: wait 500ms to let the DOM update with the playing state
    clearTimeout(_autoTrDebounce);
    _autoTrDebounce = setTimeout(function() {
      try {
        var wid = findPlayingMsgWid();
        if (!wid) {
          console.log('[EZAP-TR-AUTO] Audio captured but no playing WID found, source:', source);
          return;
        }
        if (_autoTrSent[wid]) return; // Already sent
        _autoTrSent[wid] = true;

        // Convert blob to base64 and notify content script
        var reader = new FileReader();
        reader.onload = function() {
          var b64 = reader.result.split(',')[1];
          window.postMessage({
            type: '_ezap_auto_transcribe',
            wid: wid,
            base64: b64,
            mimeType: blob.type || 'audio/ogg',
            size: blob.size,
            source: source
          }, '*');
          console.log('[EZAP-TR-AUTO] Sent for auto-transcription:', wid, 'size:', blob.size, 'source:', source);
        };
        reader.onerror = function() {
          delete _autoTrSent[wid]; // Allow retry
        };
        reader.readAsDataURL(blob);
      } catch(e) {
        console.warn('[EZAP-TR-AUTO] Error:', e.message);
      }
    }, 500);
  }

  // === 1. Intercept URL.createObjectURL — capture ALL blobs (not just audio-typed) ===
  var _createURL = URL.createObjectURL;
  URL.createObjectURL = function(obj) {
    var url = _createURL.call(URL, obj);
    try {
      if (obj instanceof Blob && obj.size > 1000) {
        store(obj, 'createObjectURL:' + (obj.type || 'unknown'));
      }
    } catch(e) {}
    return url;
  };

  // === 2. Intercept HTMLMediaElement.play — fetch blob + mute if requested ===
  window._ezapMuteNext = false;
  var _play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function() {
    var shouldMute = window._ezapMuteNext;
    if (shouldMute) {
      window._ezapMuteNext = false;
      this.volume = 0;
      this.muted = true;
      var self = this;
      // Auto-pause after 500ms (enough to trigger download)
      setTimeout(function() {
        try { self.pause(); self.currentTime = 0; self.volume = 1; self.muted = false; } catch(e) {}
      }, 500);
    }
    try {
      var src = this.src || this.currentSrc;
      if (src && src.startsWith('blob:')) {
        fetch(src).then(function(r) { return r.blob(); }).then(function(blob) {
          if (blob.size > 500) {
            store(blob, 'play:' + (blob.type || 'media'));
          }
        }).catch(function() {});
      }
    } catch(e) {}
    return _play.apply(this, arguments);
  };

  // === 3. Intercept AudioContext.decodeAudioData — capture raw audio before decoding ===
  try {
    var _decode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function(buf) {
      try {
        if (buf && buf.byteLength > 1000) {
          store(new Blob([buf.slice(0)], { type: 'audio/ogg' }), 'decodeAudioData');
        }
      } catch(e) {}
      return _decode.apply(this, arguments);
    };
  } catch(e) {}

  // === 4. Intercept HTMLMediaElement.src setter — capture blob URLs set on media ===
  try {
    var desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (desc && desc.set) {
      var _set = desc.set, _get = desc.get;
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        set: function(val) {
          try {
            if (val && val.startsWith('blob:')) {
              fetch(val).then(function(r) { return r.blob(); }).then(function(blob) {
                if (blob.size > 500) store(blob, 'srcSet:' + (blob.type || 'unknown'));
              }).catch(function() {});
            }
          } catch(e) {}
          return _set.call(this, val);
        },
        get: function() { return _get.call(this); },
        configurable: true
      });
    }
  } catch(e) {}

  // === Handle requests from content script ===
  window.addEventListener('message', function(event) {
    if (!event.data) return;

    if (event.data.type === '_ezap_get_audio') {
      var id = event.data.id;
      var audios = window._ezapCaptured;

      if (audios.length === 0) {
        window.postMessage({ type: '_ezap_audio_result', id: id, error: 'Nenhum audio capturado' }, '*');
        return;
      }

      // Get the latest captured blob
      var latest = audios[audios.length - 1];

      var reader = new FileReader();
      reader.onload = function() {
        window.postMessage({
          type: '_ezap_audio_result', id: id,
          base64: reader.result.split(',')[1],
          mimeType: latest.blob.type || 'audio/ogg',
          source: latest.source
        }, '*');
      };
      reader.onerror = function() {
        window.postMessage({ type: '_ezap_audio_result', id: id, error: 'Erro ao ler blob' }, '*');
      };
      reader.readAsDataURL(latest.blob);
    }

    if (event.data.type === '_ezap_blob_count_req') {
      window.postMessage({
        type: '_ezap_blob_count',
        id: event.data.id,
        count: window._ezapCaptured.length
      }, '*');
    }

    // Mute next play request
    if (event.data.type === '_ezap_mute_next') {
      window._ezapMuteNext = true;
    }

    // Debug: list all captured blobs
    if (event.data.type === '_ezap_debug') {
      var info = window._ezapCaptured.map(function(a) {
        return { source: a.source, size: a.blob.size, type: a.blob.type, ago: Math.round((Date.now() - a.time) / 1000) + 's' };
      });
      window.postMessage({ type: '_ezap_debug_result', data: info }, '*');
    }
  });

  console.log('[EZAP-TR] Interceptor ready (4 hooks)');
})();
