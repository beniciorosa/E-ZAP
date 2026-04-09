// ===== E-ZAP Meet Auto-Recorder =====
// Detects when user joins a Google Meet call and auto-starts recording.
// Only active for allowed users (hardcoded for now, later via DB feature flag).
//
// Flow:
// 1. Detect meeting joined (no longer on waiting screen)
// 2. Show banner: "Gravação iniciando..." with option to skip
// 3. Click: More options > Manage recording > Start recording > Start
// 4. Show recording status banner
// 5. When meeting ends, log to Supabase
(function() {
  "use strict";

  // ===== CONFIG =====
  // Allowed emails for auto-record (hardcoded for testing)
  var ALLOWED_EMAILS = [
    "tools@grupoescalada.com.br",
    "dhiego@grupoescalada.com.br"
  ];

  var _state = "idle"; // idle | waiting | recording | done | skipped
  var _banner = null;
  var _checkInterval = null;
  var _meetingTitle = "";
  var _recordingStartTime = 0;
  var _timerInterval = null;
  var _userId = null;
  var _userEmail = null;

  // ===== UTILS =====
  function log(msg) { console.log("[EZAP-MEET] " + msg); }

  // Find element by tag + text content (supports PT-BR and EN)
  function findByText(tag, texts) {
    var els = document.querySelectorAll(tag);
    for (var i = els.length - 1; i >= 0; i--) {
      var t = (els[i].textContent || "").trim();
      for (var j = 0; j < texts.length; j++) {
        if (t === texts[j]) return els[i];
      }
    }
    return null;
  }

  // Click an element safely
  function clickEl(el) {
    if (!el) return false;
    el.click();
    return true;
  }

  // Find Google Material icon by text
  function clickMaterialIcon(iconText) {
    var icons = document.querySelectorAll('i.google-material-icons[aria-hidden="true"], i.material-icons-extended');
    for (var i = icons.length - 1; i >= 0; i--) {
      if ((icons[i].textContent || "").trim() === iconText) {
        icons[i].click();
        log("Clicked icon: " + iconText);
        return true;
      }
    }
    log("Icon not found: " + iconText);
    return false;
  }

  // ===== DETECTION =====
  // Check if user is on the waiting screen (not yet in the call)
  function isOnWaitingScreen() {
    return !!(
      findByText("span", ["Participar agora", "Join now", "Pedir para participar", "Ask to join"]) ||
      findByText("button", ["Participar agora", "Join now"])
    );
  }

  // Check if already recording
  function isAlreadyRecording() {
    var divs = document.querySelectorAll("div");
    for (var i = 0; i < divs.length; i++) {
      var label = divs[i].getAttribute("aria-label") || "";
      if (
        (label.indexOf("sendo gravada") >= 0 || label.indexOf("being recorded") >= 0) &&
        divs[i].style.display !== "none"
      ) return true;
    }
    // Also check for the red recording indicator
    var recDot = document.querySelector('[data-recording-indicator], [data-is-recording="true"]');
    if (recDot) return true;
    return false;
  }

  // Check if user is in the call (not waiting, not ended)
  function isInCall() {
    // Has video/audio controls visible
    var micBtn = document.querySelector('[data-testid="mute-button"], [aria-label*="microfone"], [aria-label*="microphone"]');
    return !!micBtn && !isOnWaitingScreen();
  }

  // Get meeting title from page
  function getMeetingTitle() {
    var titleEl = document.querySelector('[data-meeting-title]');
    if (titleEl) return titleEl.getAttribute("data-meeting-title") || "";
    // Fallback: page title
    var t = document.title || "";
    return t.replace(" - Google Meet", "").replace("Meet - ", "").trim();
  }

  // ===== RECORDING SEQUENCE =====
  // New Meet UI (2025+): Activities panel (grid icon in footer) > "Gravar"
  function startRecording() {
    log("Starting recording sequence...");
    updateBanner("recording-start", "⏳ Iniciando gravação...");

    // Step 1: Open "Activities" / "Ferramentas da reunião" panel
    // The grid icon in the bottom bar (4 dots / squares icon)
    var activitiesBtn =
      document.querySelector('[aria-label*="Atividades"], [aria-label*="Activities"], [aria-label*="Ferramentas"]') ||
      document.querySelector('[data-panel-id="activities"]') ||
      document.querySelector('[aria-label*="atividades"]');

    // Fallback: find the grid/apps icon in the bottom bar
    if (!activitiesBtn) {
      var icons = document.querySelectorAll('i.google-material-icons[aria-hidden="true"], i.material-icons-extended');
      for (var i = icons.length - 1; i >= 0; i--) {
        var txt = (icons[i].textContent || "").trim();
        if (txt === "apps" || txt === "grid_view" || txt === "dashboard") {
          activitiesBtn = icons[i].closest('button') || icons[i];
          break;
        }
      }
    }

    if (!activitiesBtn) {
      log("ERROR: Could not find Activities button. Trying old method...");
      startRecordingLegacy();
      return;
    }

    activitiesBtn.click();
    log("Clicked Activities panel");

    // Step 2: Click "Gravar" — retry up to 5 times with 1s interval (panel takes time to render)
    var _recAttempt = 0;
    var _recTimer = setInterval(function() {
      _recAttempt++;
      log("Looking for Record button (attempt " + _recAttempt + ")");

      // Find by aria-label containing "Gravar Grave" (specific to record card)
      var recordBtn = document.querySelector('[aria-label*="Gravar Grave"], [aria-label*="Record Record"]');

      // Fallback: find any element with "Grave a reunião" text
      if (!recordBtn) {
        var all = document.querySelectorAll('div, span, li, a, button');
        for (var ai = 0; ai < all.length; ai++) {
          var el = all[ai];
          var tx = (el.textContent || '').trim();
          // Must contain "Grave a reunião" but not too much text (avoid the whole panel)
          if (tx.indexOf('Grave a reunião') >= 0 && tx.length < 50) {
            recordBtn = el.closest('[role="button"], [tabindex]') || el;
            break;
          }
        }
      }

      if (recordBtn) {
        clearInterval(_recTimer);
        recordBtn.click();
        log("Clicked Record card");
        afterRecordClick();
        return;
      }

      if (_recAttempt >= 5) {
        clearInterval(_recTimer);
        log("ERROR: Could not find Record button after 5 attempts");
        updateBanner("error", "❌ Botão 'Gravar' não encontrado no painel.");
      }
    }, 1000);

    function afterRecordClick() {
      log("Clicked Record");

      // Step 3: Ensure all checkboxes are checked (legendas, transcrição, Gemini)
      setTimeout(function() {
        var checkboxes = document.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
        log("Found " + checkboxes.length + " checkboxes");
        for (var ci = 0; ci < checkboxes.length; ci++) {
          var cb = checkboxes[ci];
          var isChecked = cb.checked || cb.getAttribute("aria-checked") === "true";
          if (!isChecked) {
            cb.click();
            log("Checked checkbox #" + ci);
          }
        }
        // Also try label-based checkboxes (Meet sometimes uses custom elements)
        var labels = document.querySelectorAll('label');
        for (var li = 0; li < labels.length; li++) {
          var lbl = labels[li];
          var txt = (lbl.textContent || "").trim().toLowerCase();
          if (txt.indexOf("legenda") >= 0 || txt.indexOf("transcrição") >= 0 || txt.indexOf("gemini") >= 0 || txt.indexOf("caption") >= 0 || txt.indexOf("transcript") >= 0) {
            var inp = lbl.querySelector('input[type="checkbox"]') || lbl.querySelector('[role="checkbox"]');
            if (inp && !inp.checked && inp.getAttribute("aria-checked") !== "true") {
              inp.click();
              log("Checked: " + txt);
            }
          }
        }

        // Step 4: Click "Começar a gravar" button (aria-label based)
        setTimeout(function() {
          var startBtn = document.querySelector('button[aria-label*="Começar a gravar"], button[aria-label*="Start recording"]');
          // Fallback: find by text content
          if (!startBtn) {
            var btns = document.querySelectorAll('button');
            for (var b = 0; b < btns.length; b++) {
              var bt = (btns[b].textContent || "").trim();
              if (bt.indexOf("Começar a gravar") >= 0 || bt.indexOf("Start recording") >= 0) {
                startBtn = btns[b];
                break;
              }
            }
          }

          if (!clickEl(startBtn)) {
            log("ERROR: Could not find 'Começar a gravar' button");
            updateBanner("error", "❌ Botão 'Começar a gravar' não encontrado.");
            return;
          }
          log("Clicked 'Começar a gravar'");

          // Step 5: Handle "Confirme se todos estão prontos" dialog → click "Iniciar"
          setTimeout(function() {
            // The confirmation dialog has "Cancelar" and "Iniciar" buttons
            var confirmBtn = findByText("button", ["Iniciar", "Start"]);
            if (!confirmBtn) confirmBtn = findByText("span", ["Iniciar", "Start"]);
            // Also try aria-label
            if (!confirmBtn) confirmBtn = document.querySelector('button[aria-label*="Iniciar"], button[aria-label*="Start"]');
            if (confirmBtn) {
              clickEl(confirmBtn);
              log("Clicked 'Iniciar' confirmation");
            } else {
              log("No confirmation dialog found (may have auto-started)");
            }

            setTimeout(function() {
              log("Recording started!");
              _state = "recording";
              updateBanner("recording", "🔴 Gravação em andamento");
              saveMeetingEvent("recording_started");
            }, 2000);
          }, 1500);
        }, 500);
      }, 1000);
    }
  }

  // Legacy method: More options > Manage recording (old Meet UI)
  function startRecordingLegacy() {
    var clicked = clickMaterialIcon("more_vert");
    if (!clicked) {
      var moreBtn = document.querySelector('[aria-label*="Mais opções"], [aria-label*="More options"]');
      if (moreBtn) { moreBtn.click(); clicked = true; }
    }
    if (!clicked) {
      updateBanner("error", "❌ Não encontrei o menu. Inicie a gravação manualmente.");
      return;
    }
    setTimeout(function() {
      var manageBtn = findByText("span", ["Gerenciar gravação", "Manage recording"]);
      if (!clickEl(manageBtn)) {
        updateBanner("error", "❌ Menu 'Gerenciar gravação' não encontrado.");
        document.body.click();
        return;
      }
      setTimeout(function() {
        var startBtn = findByText("span", ["Iniciar gravação", "Start recording"]);
        clickEl(startBtn);
        setTimeout(function() {
          var confirmBtn = findByText("span", ["Iniciar", "Start"]);
          clickEl(confirmBtn);
          _state = "recording";
          updateBanner("recording", "🔴 Gravação em andamento");
          saveMeetingEvent("recording_started");
        }, 1200);
      }, 800);
    }, 600);
  }

  // ===== BANNER UI =====
  function createBanner() {
    if (_banner) return;
    _banner = document.createElement("div");
    _banner.id = "ezap-meet-banner";
    _banner.className = "ezap-meet-banner";
    document.body.prepend(_banner);
  }

  function updateBanner(type, message) {
    createBanner();

    if (type === "ready") {
      _banner.className = "ezap-meet-banner";
      _banner.innerHTML =
        '<span class="ezap-meet-banner-icon">🎬</span>' +
        '<span>E-ZAP: Gravação automática</span>' +
        '<button id="ezap-meet-start" class="ezap-meet-banner-btn ezap-meet-banner-btn--record">▶ Gravar agora</button>' +
        '<button id="ezap-meet-skip" class="ezap-meet-banner-btn ezap-meet-banner-btn--skip">Não gravar</button>';

      document.getElementById("ezap-meet-start").addEventListener("click", function() {
        startRecording();
      });
      document.getElementById("ezap-meet-skip").addEventListener("click", function() {
        _state = "skipped";
        hideBanner();
        log("User skipped recording");
      });
    } else if (type === "recording-start") {
      _banner.className = "ezap-meet-banner";
      _banner.innerHTML = '<span class="ezap-meet-banner-icon">⏳</span><span>' + message + '</span>';
    } else if (type === "recording") {
      _banner.className = "ezap-meet-banner ezap-meet-banner--recording";
      _banner.style.display = "flex";
      _recordingStartTime = Date.now();
      _banner.innerHTML =
        '<span class="ezap-meet-banner-icon">🔴</span>' +
        '<span>E-ZAP Gravando</span>' +
        '<span id="ezap-meet-timer" style="font-variant-numeric:tabular-nums;min-width:56px">00:00</span>';
      // Start timer
      if (_timerInterval) clearInterval(_timerInterval);
      _timerInterval = setInterval(function() {
        var el = document.getElementById("ezap-meet-timer");
        if (!el) return;
        var elapsed = Math.floor((Date.now() - _recordingStartTime) / 1000);
        var h = Math.floor(elapsed / 3600);
        var m = Math.floor((elapsed % 3600) / 60);
        var s = elapsed % 60;
        var pad = function(n) { return n < 10 ? "0" + n : "" + n; };
        el.textContent = h > 0 ? pad(h) + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s);
      }, 1000);
    } else if (type === "error") {
      _banner.className = "ezap-meet-banner ezap-meet-banner--recording";
      _banner.innerHTML = '<span>⚠️ ' + message + '</span>';
      setTimeout(hideBanner, 8000);
    } else if (type === "done") {
      _banner.className = "ezap-meet-banner ezap-meet-banner--done";
      _banner.innerHTML = '<span>✅ ' + message + '</span>';
      setTimeout(hideBanner, 5000);
    }
  }

  function hideBanner() {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    if (_banner) _banner.style.display = "none";
  }

  // ===== SUPABASE LOGGING =====
  function saveMeetingEvent(eventType) {
    try {
      var body = {
        meet_url: window.location.href,
        meeting_title: _meetingTitle || getMeetingTitle(),
        event_type: eventType,
        recorded_at: new Date().toISOString()
      };
      if (_userId) body.user_id = _userId;
      if (eventType === "meeting_ended" && _recordingStartTime) {
        body.duration_seconds = Math.floor((Date.now() - _recordingStartTime) / 1000);
      }
      chrome.runtime.sendMessage({
        action: "supabase_rest",
        path: "/rest/v1/meet_recordings",
        method: "POST",
        body: body,
        prefer: "return=minimal"
      }, function() {
        if (chrome.runtime.lastError) {
          log("Failed to save meeting event: " + chrome.runtime.lastError.message);
        }
      });
    } catch(e) {
      log("Error saving meeting event: " + e.message);
    }
  }

  // ===== MAIN LOOP =====
  function mainLoop() {
    if (_state === "skipped" || _state === "done") return;

    // Already recording? Just monitor
    if (_state === "recording") {
      if (!isInCall()) {
        log("Meeting ended");
        _state = "done";
        saveMeetingEvent("meeting_ended");
        updateBanner("done", "Reunião encerrada. Gravação salva no Drive.");
        clearInterval(_checkInterval);
      }
      return;
    }

    // Not in call yet? Wait
    if (isOnWaitingScreen() || !isInCall()) return;

    // In call! Check if already recording
    if (isAlreadyRecording()) {
      log("Already recording, nothing to do");
      _state = "recording";
      return;
    }

    // Show banner and wait for user action (semi-auto approach)
    if (_state === "idle") {
      _state = "waiting";
      _meetingTitle = getMeetingTitle();
      log("In call! Meeting: " + _meetingTitle);
      updateBanner("ready");

      // Auto-start after 10 seconds if user doesn't interact
      setTimeout(function() {
        if (_state === "waiting") {
          log("Auto-starting recording (10s timeout)");
          startRecording();
        }
      }, 10000);
    }
  }

  // ===== INIT =====
  function init() {
    log("Meet recorder loaded on: " + window.location.href);

    // Only run on actual meeting pages (not the home page)
    if (!window.location.pathname || window.location.pathname === "/") {
      log("Not a meeting page, skipping");
      return;
    }

    // Load user info from extension storage and validate access
    chrome.storage.local.get("wcrm_auth", function(result) {
      var auth = result.wcrm_auth;
      if (auth && auth.userId) {
        _userId = auth.userId;
        _userEmail = auth.userEmail || "";
        log("User: " + (auth.userName || "unknown") + " (" + _userEmail + ")");
      }

      // Check if user email is in the allowed list
      var emailAllowed = false;
      for (var i = 0; i < ALLOWED_EMAILS.length; i++) {
        if (_userEmail && _userEmail.toLowerCase() === ALLOWED_EMAILS[i].toLowerCase()) {
          emailAllowed = true;
          break;
        }
      }

      if (!emailAllowed) {
        log("User email not in allowed list, skipping auto-record");
        return;
      }

      // Start monitoring
      _checkInterval = setInterval(mainLoop, 3000);

      // Also run immediately after a delay (let Meet UI load)
      setTimeout(mainLoop, 5000);

      log("Monitoring started");
    });
  }

  // Start after page loads
  if (document.readyState === "complete") {
    setTimeout(init, 2000);
  } else {
    window.addEventListener("load", function() { setTimeout(init, 2000); });
  }
})();
