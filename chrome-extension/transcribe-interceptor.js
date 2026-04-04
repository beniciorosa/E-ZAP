// ===== E-ZAP Audio Interceptor (MAIN world) =====
// Intercepts multiple browser APIs to capture WhatsApp audio data
(function() {
  if (window._ezapTrReady) return;
  window._ezapTrReady = true;
  window._ezapCaptured = []; // {blob, time, source}

  function store(blob, source) {
    window._ezapCaptured.push({ blob: blob, time: Date.now(), source: source });
    if (window._ezapCaptured.length > 30) window._ezapCaptured.shift();
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
