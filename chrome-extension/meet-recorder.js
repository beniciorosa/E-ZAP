// ===== E-ZAP Meet Auto-Recorder =====
// Detects when user joins a Google Meet call and auto-starts recording.
// Only active for allowed users (hardcoded for now, later via DB feature flag).
//
// Flow:
// 1. Detect meeting joined (no longer on waiting screen)
// 2. Show floating badge: "Gravação automática" with option to skip
// 3. Click: Activities > Record > checkboxes > Start > Confirm
// 4. Show recording status badge (red, with timer)
// 5. When meeting ends, log to Supabase
// 6. If user leaves and returns, detect active recording and resume banner
(function() {
  "use strict";

  // ===== CONFIG =====
  // Allowed domain for auto-record
  var ALLOWED_DOMAIN = "grupoescalada.com.br";

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
  // When partial=true, uses indexOf instead of exact match
  function findByText(tag, texts, partial) {
    var els = document.querySelectorAll(tag);
    for (var i = els.length - 1; i >= 0; i--) {
      var t = (els[i].textContent || "").trim();
      for (var j = 0; j < texts.length; j++) {
        if (partial) {
          if (t.toLowerCase().indexOf(texts[j].toLowerCase()) >= 0) return els[i];
        } else {
          if (t === texts[j]) return els[i];
        }
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

  // Check if already recording (robust — multiple strategies)
  function isAlreadyRecording() {
    // Strategy 1: aria-label on divs (original check)
    var divs = document.querySelectorAll("div");
    for (var i = 0; i < divs.length; i++) {
      var label = divs[i].getAttribute("aria-label") || "";
      if (
        (label.indexOf("sendo gravada") >= 0 || label.indexOf("being recorded") >= 0 ||
         label.indexOf("gravação") >= 0 || label.indexOf("recording") >= 0) &&
        divs[i].style.display !== "none"
      ) {
        // Make sure it's a recording indicator, not just any element mentioning recording
        var txt = (divs[i].textContent || "").trim().toLowerCase();
        if (txt.indexOf("interromper") >= 0 || txt.indexOf("stop") >= 0 ||
            txt.indexOf("gravando") >= 0 || txt.indexOf("recording") >= 0 ||
            txt.indexOf("sendo gravada") >= 0 || txt.indexOf("being recorded") >= 0 ||
            txt.length < 5) {
          log("isAlreadyRecording: found via aria-label '" + label.substring(0, 60) + "'");
          return true;
        }
      }
    }

    // Strategy 2: data attributes
    var recDot = document.querySelector('[data-recording-indicator], [data-is-recording="true"]');
    if (recDot) {
      log("isAlreadyRecording: found via data attribute");
      return true;
    }

    // Strategy 3: text content check — look for recording status text
    var allSpans = document.querySelectorAll("span, div");
    for (var s = 0; s < allSpans.length; s++) {
      var spanTxt = (allSpans[s].textContent || "").trim();
      // Must be a short label, not a big container
      if (spanTxt.length > 3 && spanTxt.length < 60) {
        var lower = spanTxt.toLowerCase();
        if ((lower === "gravando" || lower === "recording" ||
             lower.indexOf("esta reunião está sendo gravada") >= 0 ||
             lower.indexOf("this meeting is being recorded") >= 0 ||
             lower.indexOf("esta reunião está sendo transcrita") >= 0)) {
          log("isAlreadyRecording: found via text '" + spanTxt + "'");
          return true;
        }
      }
    }

    // Strategy 4: red recording dot icon (pulsing circle)
    var icons = document.querySelectorAll('i.google-material-icons, i.material-icons-extended');
    for (var ic = 0; ic < icons.length; ic++) {
      var iconTxt = (icons[ic].textContent || "").trim();
      if (iconTxt === "fiber_manual_record" || iconTxt === "radio_button_checked") {
        // Check if it's in a recording context (near top of page, small container)
        var parent = icons[ic].parentElement;
        if (parent) {
          var rect = parent.getBoundingClientRect();
          // Recording indicator is usually at the top of the screen, small
          if (rect.top < 100 && rect.height < 60) {
            log("isAlreadyRecording: found via red dot icon");
            return true;
          }
        }
      }
    }

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
        var checkboxes = document.querySelectorAll('input[type="checkbox"], [role="checkbox"], [role="switch"]');
        log("Found " + checkboxes.length + " checkboxes/switches");
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
            var inp = lbl.querySelector('input[type="checkbox"]') || lbl.querySelector('[role="checkbox"]') || lbl.querySelector('[role="switch"]');
            if (inp && !inp.checked && inp.getAttribute("aria-checked") !== "true") {
              inp.click();
              log("Checked: " + txt);
            }
          }
        }

        // Step 4: Click "Começar a gravar" button (aria-label based)
        setTimeout(function() {
          var startBtn = document.querySelector(
            'button[aria-label*="Começar a gravar"], button[aria-label*="Start recording"], ' +
            'button[aria-label*="Iniciar gravação"], button[aria-label*="Iniciar gravacao"]'
          );
          // Fallback: find by text content (partial match)
          if (!startBtn) {
            var btns = document.querySelectorAll('button');
            for (var b = 0; b < btns.length; b++) {
              var bt = (btns[b].textContent || "").trim().toLowerCase();
              if (bt.indexOf("começar a gravar") >= 0 || bt.indexOf("start recording") >= 0 ||
                  bt.indexOf("iniciar gravação") >= 0 || bt.indexOf("iniciar gravacao") >= 0) {
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
            if (!confirmBtn) confirmBtn = document.querySelector(
              'button[aria-label*="Iniciar"], button[aria-label*="Start"], ' +
              'button[aria-label*="Confirmar"], button[data-mdc-dialog-action]'
            );
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
          }, 2000);
        }, 1000);
      }, 1500);
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
    document.body.appendChild(_banner);
  }

  function updateBanner(type, message) {
    createBanner();
    // Limpa display:none deixado por hideBanner anterior
    _banner.style.display = "";

    if (type === "ready") {
      _banner.className = "ezap-meet-banner";
      _banner.innerHTML =
        '<span class="ezap-meet-banner-icon">🎬</span>' +
        '<span>E-ZAP: Gravação automática</span>' +
        '<button id="ezap-meet-start" class="ezap-meet-banner-btn ezap-meet-banner-btn--record">▶ Gravar</button>' +
        '<button id="ezap-meet-skip" class="ezap-meet-banner-btn ezap-meet-banner-btn--skip">Pular</button>';

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
      // Only reset start time if not already set (preserves time on reconnect)
      if (!_recordingStartTime) _recordingStartTime = Date.now();
      _banner.innerHTML =
        '<span class="ezap-meet-banner-icon">🔴</span>' +
        '<span>E-ZAP Gravando</span>' +
        '<span id="ezap-meet-timer" style="font-variant-numeric:tabular-nums;min-width:56px;font-size:16px;letter-spacing:1px">00:00</span>';
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

  // Try to recover recording start time from Supabase (for reconnect scenarios)
  function tryRecoverStartTime(callback) {
    var meetUrl = window.location.href.split("?")[0]; // Remove query params
    try {
      chrome.runtime.sendMessage({
        action: "supabase_rest",
        path: "/rest/v1/meet_recordings?meet_url=like.*" + encodeURIComponent(meetUrl.split("/").pop()) +
              "*&event_type=eq.recording_started&order=created_at.desc&limit=1",
        method: "GET"
      }, function(response) {
        if (chrome.runtime.lastError || !response || !response.length) {
          log("Could not recover start time, using current time");
          callback(Date.now());
          return;
        }
        var recordedAt = new Date(response[0].recorded_at).getTime();
        if (recordedAt && !isNaN(recordedAt) && (Date.now() - recordedAt) < 14400000) { // Max 4 hours
          log("Recovered recording start time: " + response[0].recorded_at);
          callback(recordedAt);
        } else {
          callback(Date.now());
        }
      });
    } catch(e) {
      log("Error recovering start time: " + e.message);
      callback(Date.now());
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
        updateBanner("done", "Reunião encerrada. Processando resumo...");
        clearInterval(_checkInterval);

        // Schedule summary processing (5 min delay for Gemini to generate)
        try {
          chrome.runtime.sendMessage({
            action: "schedule_meet_summary",
            meetingTitle: _meetingTitle || getMeetingTitle(),
            userId: _userId
          }, function() {
            if (chrome.runtime.lastError) {
              log("Failed to schedule summary: " + chrome.runtime.lastError.message);
            } else {
              log("Summary processing scheduled (5 min delay)");
            }
          });
        } catch(e) {
          log("Error scheduling summary: " + e.message);
        }
      }
      return;
    }

    // Not in call yet? Wait
    if (isOnWaitingScreen() || !isInCall()) return;

    // In call! Check if already recording (e.g. user left and came back)
    if (isAlreadyRecording()) {
      log("Recording already in progress — recovering state and showing banner");
      _state = "recording";
      _meetingTitle = _meetingTitle || getMeetingTitle();

      // Try to recover the original start time from Supabase
      tryRecoverStartTime(function(startTime) {
        _recordingStartTime = startTime;
        updateBanner("recording", "🔴 Gravação em andamento");
      });
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

      // Check if user email domain is allowed
      var emailAllowed = false;
      if (_userEmail) {
        var parts = _userEmail.toLowerCase().split("@");
        emailAllowed = parts.length === 2 && parts[1] === ALLOWED_DOMAIN;
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
