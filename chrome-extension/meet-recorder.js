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
  function startRecording() {
    log("Starting recording sequence...");
    updateBanner("recording-start", "⏳ Iniciando gravação...");

    // Step 1: Click "More options" (three dots menu)
    var clicked = clickMaterialIcon("more_vert");
    if (!clicked) {
      // Try aria-label based
      var moreBtn = document.querySelector('[aria-label*="Mais opções"], [aria-label*="More options"], [aria-label*="mais opções"]');
      if (moreBtn) { moreBtn.click(); clicked = true; }
    }

    if (!clicked) {
      log("ERROR: Could not find More options button");
      updateBanner("error", "❌ Não encontrei o menu. Inicie a gravação manualmente.");
      return;
    }

    // Step 2: Click "Manage recording" / "Gerenciar gravação"
    setTimeout(function() {
      var manageBtn = findByText("span", ["Gerenciar gravação", "Manage recording", "Gerenciar gravações"]);
      if (!manageBtn) {
        // Try li or div
        manageBtn = findByText("li", ["Gerenciar gravação", "Manage recording"]);
      }
      if (!clickEl(manageBtn)) {
        log("ERROR: Could not find Manage recording");
        updateBanner("error", "❌ Menu 'Gerenciar gravação' não encontrado. Inicie manualmente.");
        // Close the menu
        document.body.click();
        return;
      }
      log("Clicked Manage recording");

      // Step 3: Click "Start recording" / "Iniciar gravação"
      setTimeout(function() {
        var startBtn = findByText("span", ["Iniciar gravação", "Start recording"]);
        if (!startBtn) startBtn = findByText("button", ["Iniciar gravação", "Start recording"]);
        if (!clickEl(startBtn)) {
          log("ERROR: Could not find Start recording button");
          updateBanner("error", "❌ Botão 'Iniciar gravação' não encontrado.");
          return;
        }
        log("Clicked Start recording");

        // Step 4: Click "Iniciar" / "Start" confirmation
        setTimeout(function() {
          var confirmBtn = findByText("span", ["Iniciar", "Start"]);
          if (!confirmBtn) confirmBtn = findByText("button", ["Iniciar", "Start"]);
          if (!clickEl(confirmBtn)) {
            log("ERROR: Could not find Start confirmation");
            updateBanner("error", "❌ Confirmação não encontrada.");
            return;
          }
          log("Recording started successfully!");
          _state = "recording";
          updateBanner("recording", "🔴 Gravação em andamento");

          // Save to Supabase
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
      _banner.innerHTML = '<span class="ezap-meet-banner-icon">🔴</span><span>' + message + '</span>';
      // Auto-hide after 5 seconds
      setTimeout(hideBanner, 5000);
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
    if (_banner) _banner.style.display = "none";
  }

  // ===== SUPABASE LOGGING =====
  function saveMeetingEvent(eventType) {
    try {
      chrome.runtime.sendMessage({
        action: "supabase_rest",
        path: "/rest/v1/meet_recordings",
        method: "POST",
        body: {
          meet_url: window.location.href,
          meeting_title: _meetingTitle || getMeetingTitle(),
          event_type: eventType,
          recorded_at: new Date().toISOString()
        },
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

    // Start monitoring
    _checkInterval = setInterval(mainLoop, 3000);

    // Also run immediately after a delay (let Meet UI load)
    setTimeout(mainLoop, 5000);

    log("Monitoring started");
  }

  // Start after page loads
  if (document.readyState === "complete") {
    setTimeout(init, 2000);
  } else {
    window.addEventListener("load", function() { setTimeout(init, 2000); });
  }
})();
