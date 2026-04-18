// ===== E-ZAP - Authentication (Token + Device + Phone validation) =====
console.log("[EZAP AUTH] Loaded");

// ===== Constants =====
var AUTH_STORAGE_KEY = "wcrm_auth";
var DEVICE_ID_KEY = "ezap_device_id";

// ===== Generate or retrieve device fingerprint =====
function getDeviceId(callback) {
  chrome.storage.local.get(DEVICE_ID_KEY, function(result) {
    if (result[DEVICE_ID_KEY]) {
      callback(result[DEVICE_ID_KEY]);
    } else {
      // Generate a unique device ID (UUID v4)
      var id = "EZAP-" + crypto.randomUUID();
      var obj = {};
      obj[DEVICE_ID_KEY] = id;
      chrome.storage.local.set(obj, function() {
        callback(id);
      });
    }
  });
}

// ===== Get IP info from background =====
function getIpInfo(callback) {
  chrome.runtime.sendMessage({ action: "get_ip_info" }, function(resp) {
    if (chrome.runtime.lastError || !resp) {
      callback({ ip: null, location: null });
      return;
    }
    callback(resp);
  });
}

// ===== Detect WhatsApp phone number from localStorage =====
function detectWhatsAppPhone() {
  try {
    // Method 1: WhatsApp stores the user's WID in localStorage
    // Common key: "last-wid-md" with value like "5519993473149:XX@c.us"
    var widKeys = ["last-wid-md", "last-wid"];
    for (var i = 0; i < widKeys.length; i++) {
      var val = localStorage.getItem(widKeys[i]);
      if (val) {
        var match = val.match(/^(\d{10,15})/);
        if (match) return match[1];
      }
    }

    // Method 2: Search all localStorage keys containing 'wid'
    for (var j = 0; j < localStorage.length; j++) {
      var key = localStorage.key(j);
      if (key && (key.indexOf("wid") !== -1 || key.indexOf("Wid") !== -1)) {
        var v = localStorage.getItem(key);
        if (v) {
          var m = v.match(/(\d{10,15})[:@]/);
          if (m) return m[1];
        }
      }
    }

    // Method 3: Search for phone pattern in any localStorage value with @c.us
    for (var k = 0; k < localStorage.length; k++) {
      var lsKey = localStorage.key(k);
      var lsVal = localStorage.getItem(lsKey);
      if (lsVal && typeof lsVal === "string" && lsVal.indexOf("@c.us") !== -1) {
        var pm = lsVal.match(/(\d{10,15})@c\.us/);
        if (pm) return pm[1];
      }
    }
  } catch (e) {
    console.log("[EZAP AUTH] Error detecting WhatsApp phone:", e);
  }
  return null;
}

// ===== Detect phone from DOM (fallback) =====
function detectPhoneFromDOM() {
  try {
    // Inject script into page world to access WhatsApp's internal state
    var script = document.createElement("script");
    script.textContent = '(' + function() {
      function tryGet() {
        try {
          // Try Store.Conn.wid
          if (window.Store && window.Store.Conn && window.Store.Conn.wid) {
            var wid = window.Store.Conn.wid;
            var phone = wid.user || (wid._serialized && wid._serialized.split("@")[0]);
            if (phone) {
              window.postMessage({ type: "ezap-wid", phone: phone }, "*");
              return true;
            }
          }
        } catch (e) {}
        return false;
      }
      if (!tryGet()) { setTimeout(tryGet, 3000); }
    }.toString() + ')();';
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  } catch (e) {}
}

// ===== Phone matching =====
function phonesMatch(detected, allowedList) {
  if (!detected || !allowedList || !allowedList.length) return false;
  var d = detected.replace(/\D/g, "");
  if (d.length < 8) return false;

  for (var i = 0; i < allowedList.length; i++) {
    var a = allowedList[i].replace(/\D/g, "");
    if (!a) continue;
    // Exact match
    if (d === a) return true;
    // Suffix match (handles country code differences)
    if (d.endsWith(a) || a.endsWith(d)) return true;
    // Compare last 11 digits (area + number for Brazil)
    if (d.length >= 11 && a.length >= 11 && d.slice(-11) === a.slice(-11)) return true;
    // Compare last 10 digits
    if (d.length >= 10 && a.length >= 10 && d.slice(-10) === a.slice(-10)) return true;
  }
  return false;
}

// ===== Check auth on load =====
(function initAuth() {
  chrome.storage.local.get(AUTH_STORAGE_KEY, function(result) {
    var saved = result[AUTH_STORAGE_KEY];
    if (saved && saved.token && saved.userId) {
      // Has saved auth — activate immediately, re-validate silently
      setAuthGlobal(saved);
      dispatchAuthReady();
      silentRevalidate(saved.token);
      // Re-validate every 2 minutes to pick up feature changes from admin
      setInterval(function() { silentRevalidate(saved.token); }, 2 * 60 * 1000);
    } else {
      // No auth — show login overlay
      showLoginOverlay();
    }
  });
})();

// ===== Set global auth data =====
function setAuthGlobal(data) {
  window.__wcrmAuth = {
    userId: data.userId,
    userName: data.userName,
    userEmail: data.userEmail,
    userPhone: data.userPhone || "",
    userRole: data.userRole,
    token: data.token,
    features: data.features || [],
    allowedPhones: data.allowedPhones || [],
    signatureEnabled: data.signatureEnabled || false,
  };
}

// ===== Feature check helper (used by all content scripts) =====
// Admin always has ALL features regardless of what's in the DB
window.__ezapHasFeature = function(feature) {
  if (!window.__wcrmAuth) return false;
  if (window.__wcrmAuth.userRole === "admin") return true;
  return window.__wcrmAuth.features &&
         window.__wcrmAuth.features.indexOf(feature) !== -1;
};

// ===== Button config (label, colors, order) =====
window.__ezapDefaultButtonConfig = {
  crm:   { label: "CRM",   bgColor: "#00a884", textColor: "#111b21", order: 1 },
  msg:   { label: "MSG",   bgColor: "#4d96ff", textColor: "#ffffff", order: 2 },
  abas:  { label: "ABAS",  bgColor: "#8b5cf6", textColor: "#ffffff", order: 4 },
  geia:  { label: "GEIA",  bgColor: "#8b5cf6", textColor: "#ffffff", order: 5 },
  admin_overlay: { label: "SPV", bgColor: "#ff922b", textColor: "#ffffff", order: 6 }
};

window.__ezapButtonConfig = window.__ezapDefaultButtonConfig;

window.__ezapGetButtonConfig = function(key) {
  var cfg = (window.__ezapButtonConfig && window.__ezapButtonConfig[key]) || {};
  var def = window.__ezapDefaultButtonConfig[key] || {};
  return {
    label: cfg.label || def.label || key.toUpperCase(),
    bgColor: cfg.bgColor || def.bgColor || "#00a884",
    textColor: cfg.textColor || def.textColor || "#ffffff",
    order: (typeof cfg.order === "number") ? cfg.order : (def.order || 0)
  };
};

window.__ezapApplyButtonStyle = function(btn, key) {
  var c = window.__ezapGetButtonConfig(key);
  btn.textContent = c.label;
  btn.style.background = c.bgColor;
  btn.style.color = c.textColor;
  btn.style.order = c.order;
  // Auto-size font based on label length
  var len = (c.label || "").length;
  var fs = len <= 3 ? "12px" : (len === 4 ? "11px" : (len === 5 ? "9px" : "8px"));
  btn.style.fontSize = fs;
};

function loadButtonConfig() {
  chrome.runtime.sendMessage({
    action: "supabase_rest",
    path: "/rest/v1/app_settings?key=eq.button_config&select=value",
    method: "GET"
  }, function(resp) {
    if (chrome.runtime.lastError) return;
    if (!resp || !Array.isArray(resp) || resp.length === 0) return;
    try {
      var val = resp[0].value;
      var parsed = typeof val === "string" ? JSON.parse(val) : val;
      if (parsed && typeof parsed === "object") {
        // Merge with defaults (don't lose keys)
        var merged = {};
        var keys = ["crm", "msg", "abas", "geia"];
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          merged[k] = Object.assign({}, window.__ezapDefaultButtonConfig[k], parsed[k] || {});
        }
        var prev = JSON.stringify(window.__ezapButtonConfig);
        window.__ezapButtonConfig = merged;
        // Re-apply to existing buttons if any
        applyConfigToExistingButtons();
        if (prev !== JSON.stringify(merged)) {
          console.log("[EZAP AUTH] Button config loaded", merged);
        }
      }
    } catch (e) {
      console.warn("[EZAP AUTH] Failed to parse button_config", e);
    }
  });
}

function applyConfigToExistingButtons() {
  var map = {
    crm: "wcrm-toggle",
    msg: "wcrm-msg-toggle",
    abas: "wcrm-abas-toggle",
    geia: "geia-toggle"
  };
  Object.keys(map).forEach(function(k) {
    var el = document.getElementById(map[k]);
    if (el) window.__ezapApplyButtonStyle(el, k);
  });
}

// Expose reload function for manual refresh
window.__ezapReloadButtonConfig = loadButtonConfig;

// Load on init and every 2 minutes
loadButtonConfig();
setInterval(loadButtonConfig, 2 * 60 * 1000);

// ===== Widget config (top floating widget for Pin/Abas/Tags) =====
window.__ezapDefaultWidgetConfig = {
  position: "sidebar", // "sidebar" | "floating"
  style: "pill",        // "pill" | "glass" | "minimal" | "solid"
  widgets: {
    pin:  { enabled: true,  order: 1 },
    abas: { enabled: true,  order: 2 },
    tags: { enabled: true,  order: 3 },
    sig:  { enabled: false, order: 4 }
  }
};

window.__ezapWidgetConfig = window.__ezapDefaultWidgetConfig;

function loadWidgetConfig() {
  chrome.runtime.sendMessage({
    action: "supabase_rest",
    path: "/rest/v1/app_settings?key=eq.widget_config&select=value",
    method: "GET"
  }, function(resp) {
    if (chrome.runtime.lastError) return;
    if (!resp || !Array.isArray(resp) || resp.length === 0) return;
    try {
      var val = resp[0].value;
      var parsed = typeof val === "string" ? JSON.parse(val) : val;
      if (parsed && typeof parsed === "object") {
        var prev = JSON.stringify(window.__ezapWidgetConfig);
        window.__ezapWidgetConfig = {
          position: parsed.position || window.__ezapDefaultWidgetConfig.position,
          style: parsed.style || window.__ezapDefaultWidgetConfig.style,
          widgets: Object.assign({}, window.__ezapDefaultWidgetConfig.widgets, parsed.widgets || {})
        };
        if (prev !== JSON.stringify(window.__ezapWidgetConfig)) {
          console.log("[EZAP AUTH] Widget config loaded", window.__ezapWidgetConfig);
          if (typeof window.__ezapRefreshWidget === "function") window.__ezapRefreshWidget();
        }
      }
    } catch (e) {
      console.warn("[EZAP AUTH] Failed to parse widget_config", e);
    }
  });
}

window.__ezapReloadWidgetConfig = loadWidgetConfig;
loadWidgetConfig();
setInterval(loadWidgetConfig, 2 * 60 * 1000);

// ===== Theme config (responsive vs custom accent color) =====
window.__ezapDefaultThemeConfig = { mode: "responsive", primaryColor: "#00a884" };
window.__ezapThemeConfig = JSON.parse(JSON.stringify(window.__ezapDefaultThemeConfig));

function loadThemeConfig() {
  chrome.runtime.sendMessage({
    action: "supabase_rest",
    path: "/rest/v1/app_settings?key=eq.theme_config&select=value",
    method: "GET"
  }, function(resp) {
    if (chrome.runtime.lastError) return;
    if (!resp || !Array.isArray(resp) || resp.length === 0) return;
    try {
      var val = resp[0].value;
      var parsed = typeof val === "string" ? JSON.parse(val) : val;
      if (parsed && typeof parsed === "object") {
        var prev = JSON.stringify(window.__ezapThemeConfig);
        window.__ezapThemeConfig = {
          mode: parsed.mode || window.__ezapDefaultThemeConfig.mode,
          primaryColor: parsed.primaryColor || window.__ezapDefaultThemeConfig.primaryColor
        };
        if (prev !== JSON.stringify(window.__ezapThemeConfig)) {
          console.log("[EZAP AUTH] Theme config loaded", window.__ezapThemeConfig);
          // Notify abas/slice to re-apply theme
          if (typeof window.__ezapRefreshTheme === "function") window.__ezapRefreshTheme();
        }
      }
    } catch (e) {
      console.warn("[EZAP AUTH] Failed to parse theme_config", e);
    }
  });
}

window.__ezapReloadThemeConfig = loadThemeConfig;
loadThemeConfig();
setInterval(loadThemeConfig, 2 * 60 * 1000);

// ===== Overlay config (custom chat list overlay) =====
window.__ezapOverlayEnabled = false;

// Retry overlay activation until Store is ready and overlay renders (max 30s)
function _retryOverlayActivation(attempt) {
  if (attempt > 30) {
    // Give up after 30 attempts (~30s) — remove loading class to show native
    if (document.body) document.body.classList.remove('ezap-overlay-loading');
    return;
  }
  // Wait for the overlay function to exist
  if (typeof window._wcrmApplyOverlay !== "function") {
    setTimeout(function() { _retryOverlayActivation(attempt + 1); }, 1000);
    return;
  }
  // Wait for pane-side to exist (WA still loading)
  if (!document.getElementById("pane-side")) {
    setTimeout(function() { _retryOverlayActivation(attempt + 1); }, 1000);
    return;
  }
  // Try to apply
  window._wcrmApplyOverlay();
  // Check if overlay rendered (custom list appeared)
  setTimeout(function() {
    var customList = document.getElementById("wcrm-custom-list");
    if (!customList) {
      // Overlay didn't render — Store probably not ready, retry
      _retryOverlayActivation(attempt + 1);
    }
    // If rendered, early-hide is removed by slice.js automatically
  }, 800);
}

function loadOverlayConfig() {
  chrome.runtime.sendMessage({
    action: "supabase_rest",
    path: "/rest/v1/app_settings?key=eq.overlay_config&select=value",
    method: "GET"
  }, function(resp) {
    if (chrome.runtime.lastError) return;
    if (!resp || !Array.isArray(resp) || resp.length === 0) return;
    try {
      var val = resp[0].value;
      var parsed = typeof val === "string" ? JSON.parse(val) : val;
      if (parsed && typeof parsed === "object") {
        var prev = window.__ezapOverlayEnabled;
        window.__ezapOverlayEnabled = parsed.enabled === true;
        // Cache overlay state for early-hide on next reload
        try { chrome.storage.local.set({ ezap_overlay_enabled: window.__ezapOverlayEnabled }); } catch(e) {}
        if (prev !== window.__ezapOverlayEnabled) {
          console.log("[EZAP AUTH] Overlay config loaded, enabled:", window.__ezapOverlayEnabled);
          // If overlay was just enabled and no ABA filter active, activate it
          if (window.__ezapOverlayEnabled) {
            var hasAbaFilter = typeof selectedAbaId !== "undefined" && selectedAbaId !== null;
            if (!hasAbaFilter) {
              _retryOverlayActivation(0);
            }
          }
          // If overlay was just disabled, remove overlay
          if (!window.__ezapOverlayEnabled && typeof clearAbasFilter === "function") {
            clearAbasFilter();
          }
        }
      }
    } catch (e) {
      console.warn("[EZAP AUTH] Failed to parse overlay_config", e);
    }
  });
}

window.__ezapReloadOverlayConfig = loadOverlayConfig;
loadOverlayConfig();
setInterval(loadOverlayConfig, 2 * 60 * 1000);

// ===== Dispatch auth ready event =====
function dispatchAuthReady() {
  console.log("[EZAP AUTH] Authenticated as:", window.__wcrmAuth.userName,
    "(" + window.__wcrmAuth.userRole + ")",
    "features:", (window.__wcrmAuth.features || []).join(","));
  setTimeout(function() {
    document.dispatchEvent(new CustomEvent("wcrm-auth-ready"));
    // Start phone validation after a delay (WhatsApp needs time to load)
    setTimeout(validateWhatsAppPhone, 4000);
  }, 0);
}

// ===== Validate WhatsApp phone number =====
function validateWhatsAppPhone() {
  if (!window.__wcrmAuth) return;

  // Admin ALWAYS skips phone validation — free to use any WhatsApp number
  if (window.__wcrmAuth.userRole === "admin") {
    window.__ezapPhoneVerified = true;
    console.log("[EZAP AUTH] Admin user — phone validation skipped");
    return;
  }

  var allowedPhones = window.__wcrmAuth.allowedPhones || [];

  // No phones configured — block access (admin must register phone numbers)
  if (allowedPhones.length === 0) {
    console.log("[EZAP AUTH] No phone configured for user, blocking access");
    showPhoneBlockOverlay("Nenhum numero de telefone cadastrado para este usuario. Solicite ao administrador que configure seu numero.");
    return;
  }

  // Try detecting phone
  var detected = detectWhatsAppPhone();

  if (detected) {
    checkPhoneMatch(detected, allowedPhones);
  } else {
    // Start DOM-based detection as fallback
    detectPhoneFromDOM();

    // Listen for page-world detection
    var phoneListener = function(event) {
      if (event.data && event.data.type === "ezap-wid" && event.data.phone) {
        window.removeEventListener("message", phoneListener);
        checkPhoneMatch(event.data.phone, allowedPhones);
      }
    };
    window.addEventListener("message", phoneListener);

    // Retry: wait for WhatsApp to be logged in, then validate
    setTimeout(function() {
      if (window.__ezapPhoneVerified) return;
      var retryPhone = detectWhatsAppPhone();
      if (retryPhone) {
        window.removeEventListener("message", phoneListener);
        checkPhoneMatch(retryPhone, allowedPhones);
      } else {
        console.log("[EZAP AUTH] Could not detect WhatsApp phone number, retrying...");
        // Keep retrying every 10 seconds — no hard limit
        // If WhatsApp is not logged in (QR code screen), wait patiently
        var retryCount = 0;
        var retryInterval = setInterval(function() {
          retryCount++;
          if (window.__ezapPhoneVerified) {
            clearInterval(retryInterval);
            return;
          }
          var p = detectWhatsAppPhone();
          if (p) {
            clearInterval(retryInterval);
            window.removeEventListener("message", phoneListener);
            checkPhoneMatch(p, allowedPhones);
            return;
          }
          // Check if WhatsApp is logged in (chat list visible = logged in)
          var isLoggedIn = !!document.querySelector('[data-icon="new-chat-outline"]') ||
                           !!document.querySelector('[aria-label="Lista de conversas"]') ||
                           !!document.querySelector('[data-icon="menu"]');
          if (!isLoggedIn) {
            // Still on QR code screen — keep waiting without blocking
            console.log("[EZAP AUTH] WhatsApp not logged in yet, waiting...");
            return;
          }
          // WhatsApp IS logged in but we still can't detect phone — give more retries
          if (retryCount > 18) { // ~3 minutes after WhatsApp login
            clearInterval(retryInterval);
            console.log("[EZAP AUTH] Phone detection failed after retries, blocking access");
            showPhoneBlockOverlay("Nao foi possivel verificar o numero do WhatsApp. Abra o perfil do WhatsApp e tente novamente.");
          }
        }, 10000);
      }
    }, 8000);
  }
}

function checkPhoneMatch(detected, allowedPhones) {
  if (phonesMatch(detected, allowedPhones)) {
    window.__ezapPhoneVerified = true;
    console.log("[EZAP AUTH] WhatsApp phone verified:", detected);
  } else {
    console.log("[EZAP AUTH] PHONE MISMATCH! Detected:", detected, "Allowed:", allowedPhones);
    // Log the mismatch to the server
    getIpInfo(function(info) {
      chrome.runtime.sendMessage({
        action: "log_phone_mismatch",
        userId: window.__wcrmAuth.userId,
        detectedPhone: detected,
        ip: info.ip,
        location: info.location,
      });
    });
    showPhoneBlockOverlay("Este token está vinculado a outro número de WhatsApp. Número detectado: +" + detected + ". Solicite ao administrador a atualização do seu número.");
  }
}

// ===== Phone block overlay =====
function showPhoneBlockOverlay(message) {
  // Remove any existing overlay
  var existing = document.getElementById("ezap-phone-block");
  if (existing) existing.remove();

  var overlay = document.createElement("div");
  overlay.id = "ezap-phone-block";
  Object.assign(overlay.style, {
    position: "fixed", top: "0", left: "0", width: "100%", height: "100%",
    background: "rgba(17,27,33,0.97)", zIndex: "99999999",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  });

  var card = document.createElement("div");
  Object.assign(card.style, {
    background: "#202c33", borderRadius: "16px", padding: "40px 36px",
    width: "420px", maxWidth: "90%", textAlign: "center",
    boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
  });

  card.innerHTML =
    '<div style="width:64px;height:64px;border-radius:50%;background:#ff6b6b;display:flex;align-items:center;justify-content:center;margin:0 auto 16px">' +
      '<svg viewBox="0 0 24 24" width="32" height="32" fill="#fff"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>' +
    '</div>' +
    '<h2 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#ff6b6b">Acesso Bloqueado</h2>' +
    '<p style="margin:0 0 20px;font-size:14px;color:#8696a0;line-height:1.6">' + message + '</p>' +
    '<button onclick="window.__wcrmLogout()" style="padding:12px 24px;background:#ff6b6b;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">Sair</button>';

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Disable all E-ZAP functionality
  window.__wcrmAuth = null;
}

// ===== Silent re-validation =====
// POLICY: NEVER auto-logout for transient errors (network, service worker restart,
// API hiccup, token revoked by admin, etc). The ONLY condition that triggers an
// auto-logout is `response.blocked === true`, which means the same token was
// redeemed in another browser (device_mismatch). In that case, the user gets
// a dedicated overlay. Any other error is ignored — stale sessions are fine.
// The user logs out manually via the popup if they want to.

function silentRevalidate(token) {
  getDeviceId(function(deviceId) {
    chrome.runtime.sendMessage({
      action: "validate_token",
      token: token,
      deviceId: deviceId,
      skipLog: true,
    }, function(response) {
      // Runtime error (service worker dead/zombie) — ignore, try again next cycle
      if (chrome.runtime.lastError) {
        console.log("[EZAP AUTH] silentRevalidate: runtime error (ignored):",
          chrome.runtime.lastError.message);
        return;
      }

      if (!response || !response.ok) {
        // ONLY condition that forces a logout: another browser took over this token.
        if (response && response.blocked) {
          showPhoneBlockOverlay(response.error || "Token em uso em outro navegador.");
          chrome.storage.local.remove(AUTH_STORAGE_KEY);
          return;
        }
        // Any other error (network/API/revoked/etc) — keep the session alive.
        console.log("[EZAP AUTH] silentRevalidate: non-blocked error (ignored):",
          (response && response.error) || "empty");
        return;
      } else if (response.data) {
        // Success — update features and allowed phones from server
        var saved = {};
        saved[AUTH_STORAGE_KEY] = {
          token: token,
          userId: response.data.user_id,
          userName: response.data.user_name,
          userEmail: response.data.user_email,
          userPhone: response.data.user_phone || "",
          userRole: response.data.user_role,
          features: response.data.user_features || [],
          allowedPhones: response.data.user_allowed_phones || [],
          signatureEnabled: response.data.user_signature_enabled || false,
          validatedAt: new Date().toISOString(),
        };
        chrome.storage.local.set(saved);
        var oldFeatures = (window.__wcrmAuth && window.__wcrmAuth.features || []).slice().sort().join(",");
        setAuthGlobal(saved[AUTH_STORAGE_KEY]);
        var newFeatures = (window.__wcrmAuth.features || []).slice().sort().join(",");
        if (oldFeatures !== newFeatures) {
          console.log("[EZAP AUTH] Features changed, reloading page. Old:", oldFeatures, "New:", newFeatures);
          location.reload();
        }
      }
    });
  });
}

// ===== Login Overlay =====
function showLoginOverlay() {
  if (document.getElementById("wcrm-auth-overlay")) return;

  var overlay = document.createElement("div");
  overlay.id = "wcrm-auth-overlay";
  Object.assign(overlay.style, {
    position: "fixed", top: "0", left: "0", width: "100%", height: "100%",
    background: "#111b21", zIndex: "9999999",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  });

  var card = document.createElement("div");
  Object.assign(card.style, {
    background: "#202c33", borderRadius: "16px", padding: "40px 36px",
    width: "380px", maxWidth: "90%",
    boxShadow: "0 8px 32px rgba(0,0,0,0.4)", textAlign: "center",
  });

  card.innerHTML =
    '<div style="margin-bottom:24px">' +
      '<div style="width:64px;height:64px;border-radius:50%;background:#00a884;display:flex;align-items:center;justify-content:center;margin:0 auto 16px">' +
        '<svg viewBox="0 0 24 24" width="32" height="32" fill="#111b21"><path d="M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2z"/></svg>' +
      '</div>' +
      '<h2 style="margin:0;font-size:22px;font-weight:700;color:#e9edef">E-ZAP</h2>' +
      '<p style="margin:6px 0 0;font-size:13px;color:#8696a0">Insira seu token de acesso para continuar</p>' +
    '</div>' +
    '<div style="margin-bottom:16px;text-align:left">' +
      '<label style="font-size:11px;color:#8696a0;display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Token de Acesso</label>' +
      '<input id="wcrm-auth-token" type="text" placeholder="Cole seu token aqui" maxlength="30" autocomplete="off" spellcheck="false" style="width:100%;padding:12px 14px;background:#111b21;border:2px solid #3b4a54;border-radius:10px;color:#e9edef;font-size:16px;font-family:monospace;letter-spacing:1px;outline:none;box-sizing:border-box;text-align:center;transition:border-color 0.2s">' +
    '</div>' +
    '<button id="wcrm-auth-login" style="width:100%;padding:14px;background:#00a884;color:#111b21;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;transition:background 0.2s;margin-bottom:12px">Entrar</button>' +
    '<div id="wcrm-auth-status" style="font-size:13px;min-height:20px;color:#ff6b6b"></div>' +
    '<div style="margin-top:20px;padding-top:16px;border-top:1px solid #2a3942">' +
      '<p style="margin:0;font-size:11px;color:#8696a0">Solicite seu token ao administrador da equipe</p>' +
    '</div>';

  overlay.appendChild(card);

  function inject() {
    document.body.appendChild(overlay);
    setupLoginEvents();
  }

  if (document.body) { inject(); }
  else { document.addEventListener("DOMContentLoaded", inject); }
}

// ===== Login Events =====
function setupLoginEvents() {
  var input = document.getElementById("wcrm-auth-token");
  var btn = document.getElementById("wcrm-auth-login");
  var status = document.getElementById("wcrm-auth-status");
  if (!input || !btn) return;

  input.addEventListener("input", function() { input.value = input.value.trim(); });
  input.addEventListener("focus", function() { input.style.borderColor = "#00a884"; });
  input.addEventListener("blur", function() { input.style.borderColor = "#3b4a54"; });
  input.addEventListener("keydown", function(e) { if (e.key === "Enter") doLogin(); });
  btn.addEventListener("click", doLogin);
  setTimeout(function() { input.focus(); }, 200);

  function doLogin() {
    var token = input.value.trim();
    status.textContent = "";
    status.style.color = "#ff6b6b";

    if (!/^WCRM-.{5,}$/i.test(token)) {
      status.textContent = "Token invalido. Deve comecar com WCRM-";
      input.style.borderColor = "#ff6b6b";
      return;
    }

    btn.disabled = true;
    btn.textContent = "Verificando...";
    btn.style.opacity = "0.7";
    input.style.borderColor = "#3b4a54";

    // Get device ID and IP info in parallel, then validate
    getDeviceId(function(deviceId) {
      getIpInfo(function(ipInfo) {
        chrome.runtime.sendMessage({
          action: "validate_token",
          token: token,
          deviceId: deviceId,
          ipAddress: ipInfo.ip,
          location: ipInfo.location,
          userAgent: navigator.userAgent,
        }, function(response) {
          if (chrome.runtime.lastError) {
            status.textContent = "Erro de conexão. Tente novamente.";
            resetButton();
            return;
          }

          if (response && response.ok) {
            var authData = {
              token: token,
              userId: response.data.user_id,
              userName: response.data.user_name,
              userEmail: response.data.user_email,
              userPhone: response.data.user_phone || "",
              userRole: response.data.user_role,
              features: response.data.user_features || [],
              allowedPhones: response.data.user_allowed_phones || [],
              signatureEnabled: response.data.user_signature_enabled || false,
              validatedAt: new Date().toISOString(),
            };

            var saveObj = {};
            saveObj[AUTH_STORAGE_KEY] = authData;
            chrome.storage.local.set(saveObj, function() {
              status.style.color = "#00a884";
              status.textContent = "Bem-vindo, " + authData.userName + "!";
              btn.textContent = "Conectado!";
              btn.style.background = "#00a884";

              setAuthGlobal(authData);

              setTimeout(function() {
                var overlay = document.getElementById("wcrm-auth-overlay");
                if (overlay) {
                  overlay.style.transition = "opacity 0.4s";
                  overlay.style.opacity = "0";
                  setTimeout(function() {
                    overlay.remove();
                    dispatchAuthReady();
                  }, 400);
                }
              }, 800);
            });
          } else {
            status.textContent = response && response.error ? response.error : "Token invalido ou desativado.";
            input.style.borderColor = "#ff6b6b";
            resetButton();
          }
        });
      });
    });

    function resetButton() {
      btn.disabled = false;
      btn.textContent = "Entrar";
      btn.style.opacity = "1";
    }
  }
}

// ===== Logout =====
window.__wcrmLogout = function() {
  chrome.storage.local.remove(AUTH_STORAGE_KEY, function() {
    window.__wcrmAuth = null;
    location.reload();
  });
};

chrome.runtime.onMessage.addListener(function(request) {
  if (request.action === "wcrm_logout") {
    window.__wcrmLogout();
  }
  if (request.action === "ezap_update_available") {
    // Se force_replace, remove banner existente pra mostrar versao mais nova
    if (request.force_replace) {
      var oldBanner = document.getElementById("ezap-update-banner");
      if (oldBanner) oldBanner.remove();
    }
    showUpdateBanner(request.version, request.message, request.download_url);
  }

  // ===== Toggle Overlay Visibility (admin only) =====
  if (request.action === "ezap_toggle_overlay") {
    _ezapApplyOverlayHidden(request.hidden);
  }

  // ===== Start Impersonation (admin only) =====
  if (request.action === "ezap_start_impersonate") {
    _ezapStartImpersonate(request.userId, request.userName, request.userPhone);
  }

  // ===== Stop Impersonation =====
  if (request.action === "ezap_stop_impersonate") {
    _ezapStopImpersonate();
  }
});

// ===== Overlay Hide/Show =====
// "Overlay" = the left panel custom chat list (#wcrm-custom-list) + quick aba bar
// that replaces the native WhatsApp chat list. Hiding it restores native WA.
function _ezapApplyOverlayHidden(hidden) {
  if (hidden) {
    // Disable the overlay flag so slice.js stops re-rendering
    window.__ezapOverlayEnabled = false;
    window.__ezapOverlayForceHidden = true;

    // Hide the custom list and restore native WA chat list
    if (typeof _hideCustomAbaList === "function") {
      _hideCustomAbaList();
    } else {
      // Fallback: hide directly
      var custom = document.getElementById("wcrm-custom-list");
      if (custom) { custom.style.display = "none"; custom.innerHTML = ""; }
      // Restore native list
      var hidden2 = document.querySelector('[data-ezap-hidden="1"]');
      if (hidden2) {
        hidden2.style.overflow = hidden2.getAttribute("data-ezap-orig-overflow") || "";
        hidden2.style.pointerEvents = hidden2.getAttribute("data-ezap-orig-pointerevents") || "";
        hidden2.removeAttribute("data-ezap-hidden");
      }
    }

    // Hide the quick aba bar (pills)
    var abaBar = document.getElementById("wcrm-quick-aba-bar");
    if (abaBar) abaBar.style.display = "none";

    // Clear active aba filter
    if (typeof selectedAbaId !== "undefined") {
      selectedAbaId = null;
    }

    // Stop custom list polling
    if (typeof _stopCustomListPolling === "function") _stopCustomListPolling();
  } else {
    // Re-enable overlay
    window.__ezapOverlayEnabled = true;
    delete window.__ezapOverlayForceHidden;

    // Restore quick aba bar
    var abaBar = document.getElementById("wcrm-quick-aba-bar");
    if (abaBar) abaBar.style.display = "";

    // Re-inject the aba bar if missing
    if (typeof injectQuickAbaSelector === "function") injectQuickAbaSelector();

    // Re-apply conversation filters (will show custom list if overlay enabled)
    if (typeof applyConversationFilters === "function") {
      applyConversationFilters();
    }
  }
}

// ===== Impersonation =====
function _ezapStartImpersonate(userId, userName, userPhone) {
  if (!window.__wcrmAuth) return;
  // Save original auth if not already saved
  if (!window.__wcrmOriginalAuth) {
    window.__wcrmOriginalAuth = {
      userId: window.__wcrmAuth.userId,
      userName: window.__wcrmAuth.userName,
      userRole: window.__wcrmAuth.userRole,
      features: window.__wcrmAuth.features,
    };
  }
  // Override auth with impersonated user
  window.__wcrmAuth.userId = userId;
  window.__wcrmAuth.userName = userName;
  window.__wcrmAuth._impersonating = true;
  window.__wcrmAuth._impersonatePhone = userPhone || "";

  // Show impersonation banner
  _ezapShowImpersonationBanner(userName);

  // Reload CRM data for new userId
  _ezapReloadCrmData();
}

function _ezapStopImpersonate() {
  if (window.__wcrmOriginalAuth) {
    window.__wcrmAuth.userId = window.__wcrmOriginalAuth.userId;
    window.__wcrmAuth.userName = window.__wcrmOriginalAuth.userName;
    window.__wcrmAuth.userRole = window.__wcrmOriginalAuth.userRole;
    window.__wcrmAuth.features = window.__wcrmOriginalAuth.features;
    delete window.__wcrmAuth._impersonating;
    delete window.__wcrmAuth._impersonatePhone;
    window.__wcrmOriginalAuth = null;
  }

  // Remove banner
  var banner = document.getElementById("ezap-impersonate-banner");
  if (banner) banner.remove();

  // Reload CRM data back to admin
  _ezapReloadCrmData();
}

function _ezapShowImpersonationBanner(userName) {
  var existing = document.getElementById("ezap-impersonate-banner");
  if (existing) existing.remove();

  var banner = document.createElement("div");
  banner.id = "ezap-impersonate-banner";
  banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;background:#ff922b;color:#fff;padding:6px 16px;font-size:13px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
  banner.innerHTML =
    '<span>👁 Visualizando como: ' + (userName || "Usuário") + '</span>' +
    '<button id="ezap-impersonate-stop" style="background:rgba(255,255,255,0.2);border:none;color:#fff;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600">Voltar ao meu perfil ✕</button>';
  document.body.appendChild(banner);

  // Push WhatsApp content down
  var appEl = document.getElementById("app");
  if (appEl) appEl.style.marginTop = "32px";

  document.getElementById("ezap-impersonate-stop").addEventListener("click", function() {
    _ezapStopImpersonate();
    // Also update storage
    chrome.storage.local.remove("ezap_impersonate");
  });
}

function _ezapReloadCrmData() {
  // 1. Reload abas for new userId
  if (typeof loadAbasData === "function") {
    loadAbasData().then(function(data) {
      if (typeof renderAbasList === "function") renderAbasList(data);
      if (typeof updateAbasIndicator === "function") updateAbasIndicator();
      // Re-inject the quick aba bar with new user's abas
      if (typeof injectQuickAbaSelector === "function") injectQuickAbaSelector();
      // Re-apply conversation filters with new abas
      if (typeof applyConversationFilters === "function") applyConversationFilters();
    }).catch(function() {});
  }

  // 2. Trigger labels reload via event bus
  if (window.ezapEventBus) {
    window.ezapEventBus.emit("impersonate:changed");
  }

  // 3. Force CRM sidebar refresh if open
  if (typeof window.__wcrmRefreshSidebar === "function") {
    window.__wcrmRefreshSidebar();
  }

  // 4. Reload message templates
  if (typeof loadMsgSequences === "function") {
    loadMsgSequences();
  }

  // 5. Reload pinned contacts
  if (typeof loadPinnedContacts === "function") {
    loadPinnedContacts();
  }
}

// ===== Auto-apply overlay/impersonation on page load =====
(function() {
  // Wait a bit for auth to be ready
  setTimeout(function() {
    chrome.storage.local.get(["ezap_overlay_hidden", "ezap_impersonate"], function(data) {
      if (data.ezap_overlay_hidden) {
        _ezapApplyOverlayHidden(true);
      }
      if (data.ezap_impersonate && data.ezap_impersonate.userId && window.__wcrmAuth && window.__wcrmAuth.userRole === "admin") {
        _ezapStartImpersonate(data.ezap_impersonate.userId, data.ezap_impersonate.userName, data.ezap_impersonate.userPhone);
      }
    });
  }, 2000);
})();

// ===== Version Update Notification Banner =====
function showUpdateBanner(version, message, downloadUrl) {
  // Don't show if already showing
  if (document.getElementById("ezap-update-banner")) return;

  var banner = document.createElement("div");
  banner.id = "ezap-update-banner";
  banner.setAttribute("data-ezap-version", version);
  Object.assign(banner.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100%",
    zIndex: "99999998",
    background: "linear-gradient(135deg, #111b21 0%, #1a2b34 100%)",
    borderBottom: "2px solid #00a884",
    padding: "12px 20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "16px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
    animation: "ezapSlideDown 0.4s ease-out",
  });

  // Add animation keyframes
  if (!document.getElementById("ezap-update-style")) {
    var style = document.createElement("style");
    style.id = "ezap-update-style";
    style.textContent =
      "@keyframes ezapSlideDown { from { transform: translateY(-100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }" +
      "@keyframes ezapPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }";
    document.head.appendChild(style);
  }

  var msgText = message ? " — " + message : "";

  banner.innerHTML =
    '<div style="display:flex;align-items:center;gap:10px">' +
      '<div style="width:32px;height:32px;border-radius:50%;background:#00a884;display:flex;align-items:center;justify-content:center;flex-shrink:0;animation:ezapPulse 2s infinite">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="#111b21"><path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z"/></svg>' +
      '</div>' +
      '<div>' +
        '<div style="font-size:13px;font-weight:600;color:#e9edef">Nova versão disponível: <span style="color:#00a884">v' + version + '</span>' + msgText + '</div>' +
      '</div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;align-items:center;flex-shrink:0">' +
      '<a href="' + (downloadUrl || "#") + '" target="_blank" style="padding:8px 18px;background:#00a884;color:#111b21;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;text-decoration:none;white-space:nowrap">Baixar Atualização</a>' +
      '<button id="ezap-update-dismiss" style="padding:6px;background:transparent;border:none;cursor:pointer;color:#8696a0;font-size:18px;line-height:1" title="Fechar">&times;</button>' +
    '</div>';

  document.body.appendChild(banner);

  // Dismiss button
  document.getElementById("ezap-update-dismiss").addEventListener("click", function() {
    banner.style.transition = "transform 0.3s ease-in, opacity 0.3s";
    banner.style.transform = "translateY(-100%)";
    banner.style.opacity = "0";
    setTimeout(function() { banner.remove(); }, 300);
    // Store dismissal for this version so it doesn't keep showing
    chrome.storage.local.set({ ezap_update_dismissed: version });
  });
}

// Check for stored update info on load (after auth is ready)
function checkStoredUpdate() {
  chrome.storage.local.get(["ezap_update", "ezap_update_dismissed"], function(result) {
    if (result.ezap_update && result.ezap_update.version) {
      // Don't show if user already dismissed THIS EXACT version
      if (result.ezap_update_dismissed === result.ezap_update.version) return;
      // Se banner existente mostra versao anterior, remove pra atualizar
      var existing = document.getElementById("ezap-update-banner");
      if (existing) {
        var shownVer = existing.getAttribute("data-ezap-version") || "";
        if (shownVer && shownVer !== result.ezap_update.version) {
          existing.remove();
        }
      }
      showUpdateBanner(
        result.ezap_update.version,
        result.ezap_update.message,
        result.ezap_update.download_url
      );
    }
  });
}

// Trigger update check + notification check after auth is ready
document.addEventListener("wcrm-auth-ready", function() {
  setTimeout(checkStoredUpdate, 3000);
  setTimeout(checkAdminNotifications, 4000);
  // Re-check notifications every 10 seconds for near-instant delivery
  setInterval(checkAdminNotifications, 10 * 1000);
});

// ===== Admin Notifications System =====
function authSupaRest(path, method, body) {
  return new Promise(function(resolve) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) { resolve(null); return; }
      chrome.runtime.sendMessage({
        action: "supabase_rest", path: path, method: method || "GET", body: body
      }, function(resp) {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp);
      });
    } catch (e) { resolve(null); }
  });
}

function checkAdminNotifications() {
  if (!window.__wcrmAuth || !window.__wcrmAuth.userId) return;
  var userId = window.__wcrmAuth.userId;
  var now = new Date();

  // Fetch active notifications (for all users OR targeting this user) + dismissed_at is null
  var notifQuery = "/rest/v1/global_messages?is_notification=eq.true&active=eq.true&dismissed_at=is.null" +
    "&or=(target_users.is.null,target_users.cs.[\"" + userId + "\"])" +
    "&select=id,title,content,notification_type,created_at,scheduled_at,is_pinned,pin_start,pin_end&order=created_at.desc";
  Promise.all([
    authSupaRest(notifQuery),
    authSupaRest("/rest/v1/notification_reads?user_id=eq." + userId + "&select=message_id")
  ]).then(function(results) {
    var notifications = results[0];
    var reads = results[1];
    if (!Array.isArray(notifications) || notifications.length === 0) {
      // If no active notifications, remove any existing pinned banner
      var existing = document.getElementById("ezap-notif-banner");
      if (existing && existing.dataset.dismissed === "true") {
        existing.remove();
      }
      return;
    }

    // Build set of already-read message IDs
    var readSet = {};
    if (Array.isArray(reads)) {
      reads.forEach(function(r) { readSet[r.message_id] = true; });
    }

    // Filter: only show if scheduled_at is null or in the past
    var ready = notifications.filter(function(n) {
      if (n.scheduled_at && new Date(n.scheduled_at) > now) return false;
      return true;
    });

    // Separate pinned (active right now) vs regular
    var pinnedNotif = null;
    var regularNotif = null;

    for (var i = 0; i < ready.length; i++) {
      var n = ready[i];
      if (n.is_pinned && n.pin_start && n.pin_end) {
        var start = new Date(n.pin_start);
        var end = new Date(n.pin_end);
        if (now >= start && now <= end) {
          pinnedNotif = n;
          break; // Pinned takes priority
        }
        continue; // Pinned but not in range, skip
      }
    }

    // If no active pin, show ONLY the most recent unread notification.
    // Older unread ones are auto-marked as read so new users don't get
    // a flood of old messages one after another.
    if (!pinnedNotif) {
      chrome.storage.local.get("ezap_notif_dismissed", function(stored) {
        var localDismissed = (stored && stored.ezap_notif_dismissed) || {};
        var olderToAutoRead = [];
        for (var i = 0; i < ready.length; i++) {
          var n = ready[i];
          if (n.is_pinned) continue;
          if (readSet[n.id] || localDismissed[n.id]) continue;
          if (!regularNotif) {
            regularNotif = n; // primeira (mais recente, query ja ordena desc)
          } else {
            olderToAutoRead.push(n.id); // mais antigas: marca como lida
          }
        }
        // Auto-marca as mais antigas como lidas (silencioso, sem banner)
        olderToAutoRead.forEach(function(msgId) {
          markNotificationRead(msgId, userId);
        });
        if (regularNotif) {
          showNotificationBanner(regularNotif, userId, false);
        }
      });
    } else {
      showNotificationBanner(pinnedNotif, userId, true);
    }
  });

  // Also check if current pinned banner has expired
  var existingBanner = document.getElementById("ezap-notif-banner");
  if (existingBanner && existingBanner.dataset.pinEnd) {
    var endTime = new Date(existingBanner.dataset.pinEnd);
    if (now > endTime) {
      existingBanner.remove();
    }
  }
}

function showNotificationBanner(notif, userId, isPinned) {
  // Don't stack on top of update banner — wait
  if (document.getElementById("ezap-update-banner")) {
    setTimeout(function() { showNotificationBanner(notif, userId, isPinned); }, 5000);
    return;
  }

  // If same notification already showing, skip
  var existing = document.getElementById("ezap-notif-banner");
  if (existing) {
    if (existing.dataset.notifId === notif.id) return;
    existing.remove(); // Replace with new one
  }

  var typeColors = {
    info: { bg: "#228be6", icon: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" },
    warning: { bg: "#fab005", icon: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" },
    success: { bg: "#00a884", icon: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" }
  };
  var tc = typeColors[notif.notification_type] || typeColors.info;

  var banner = document.createElement("div");
  banner.id = "ezap-notif-banner";
  banner.dataset.notifId = notif.id;
  if (isPinned && notif.pin_end) banner.dataset.pinEnd = notif.pin_end;

  Object.assign(banner.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100%",
    zIndex: "99999997",
    background: "linear-gradient(135deg, #111b21 0%, #1a2b34 100%)",
    borderBottom: "2px solid " + tc.bg,
    padding: "12px 20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "16px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
    animation: "ezapSlideDown 0.4s ease-out",
  });

  // Ensure animation keyframes exist
  if (!document.getElementById("ezap-update-style")) {
    var style = document.createElement("style");
    style.id = "ezap-update-style";
    style.textContent =
      "@keyframes ezapSlideDown { from { transform: translateY(-100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }" +
      "@keyframes ezapPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }";
    document.head.appendChild(style);
  }

  // Truncate content for banner display
  var shortContent = notif.content.length > 80 ? notif.content.substring(0, 80) + "..." : notif.content;

  // Build buttons: pinned = only "Ver mais" (no close), regular = "Ver mais" + X
  var buttonsHtml = '<button id="ezap-notif-expand" style="padding:8px 18px;background:' + tc.bg + ';color:#111b21;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap">Ver mais</button>';
  if (!isPinned) {
    buttonsHtml += '<button id="ezap-notif-dismiss" style="padding:6px;background:transparent;border:none;cursor:pointer;color:#8696a0;font-size:18px;line-height:1" title="Fechar">&times;</button>';
  }

  var pinLabel = isPinned ? '<span style="font-size:10px;background:' + tc.bg + '30;color:' + tc.bg + ';padding:2px 6px;border-radius:4px;margin-left:6px">FIXADA</span>' : '';

  banner.innerHTML =
    '<div style="display:flex;align-items:center;gap:10px">' +
      '<div style="width:32px;height:32px;border-radius:50%;background:' + tc.bg + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;animation:ezapPulse 2s infinite">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="#111b21"><path d="' + tc.icon + '"/></svg>' +
      '</div>' +
      '<div>' +
        '<div style="font-size:14px;font-weight:600;color:#e9edef"><span style="color:' + tc.bg + '">' + escHtml(notif.title) + '</span>' + pinLabel + ' — ' + escHtml(shortContent) + '</div>' +
      '</div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;align-items:center;flex-shrink:0">' +
      buttonsHtml +
    '</div>';

  document.body.appendChild(banner);

  function dismissBanner() {
    markNotificationRead(notif.id, userId);
    banner.style.transition = "transform 0.3s ease-in, opacity 0.3s";
    banner.style.transform = "translateY(-100%)";
    banner.style.opacity = "0";
    setTimeout(function() {
      banner.remove();
      // Check for next unread notification
      setTimeout(checkAdminNotifications, 500);
    }, 300);
  }

  // "Ver mais" — show full notification (pinned: no dismiss on close)
  document.getElementById("ezap-notif-expand").addEventListener("click", function() {
    if (isPinned) {
      showNotificationDetail(notif, tc, null); // No dismiss callback for pinned
    } else {
      showNotificationDetail(notif, tc, dismissBanner);
    }
  });

  // Dismiss button (only exists for non-pinned)
  var dismissBtn = document.getElementById("ezap-notif-dismiss");
  if (dismissBtn) {
    dismissBtn.addEventListener("click", dismissBanner);
  }
}

function showNotificationDetail(notif, tc, onDismiss) {
  if (document.getElementById("ezap-notif-detail")) return;

  var overlay = document.createElement("div");
  overlay.id = "ezap-notif-detail";
  Object.assign(overlay.style, {
    position: "fixed",
    top: "0", left: "0", width: "100%", height: "100%",
    background: "rgba(0,0,0,0.6)",
    zIndex: "99999999",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  });

  var dateStr = new Date(notif.created_at).toLocaleDateString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
  });

  overlay.innerHTML =
    '<div style="background:#202c33;border:1px solid #2a3942;border-radius:14px;padding:24px;max-width:480px;width:90%;max-height:70vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.4)">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">' +
        '<div style="width:36px;height:36px;border-radius:50%;background:' + tc.bg + ';display:flex;align-items:center;justify-content:center;flex-shrink:0">' +
          '<svg viewBox="0 0 24 24" width="20" height="20" fill="#111b21"><path d="' + tc.icon + '"/></svg>' +
        '</div>' +
        '<div style="flex:1">' +
          '<div style="font-size:16px;font-weight:700;color:#e9edef">' + escHtml(notif.title) + '</div>' +
          '<div style="font-size:11px;color:#8696a0">' + dateStr + '</div>' +
        '</div>' +
      '</div>' +
      '<div style="font-size:14px;color:#d1d7db;line-height:1.6;white-space:pre-wrap">' + escHtml(notif.content) + '</div>' +
      '<div style="margin-top:20px;text-align:right">' +
        '<button id="ezap-notif-detail-close" style="padding:8px 20px;background:' + tc.bg + ';color:#111b21;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer">Entendi</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  function closeAndDismiss() {
    overlay.remove();
    if (onDismiss) onDismiss();
  }

  overlay.addEventListener("click", function(e) {
    if (e.target === overlay) closeAndDismiss();
  });
  document.getElementById("ezap-notif-detail-close").addEventListener("click", closeAndDismiss);
}

function markNotificationRead(messageId, userId) {
  // Save to Supabase
  authSupaRest("/rest/v1/notification_reads", "POST", {
    message_id: messageId,
    user_id: userId
  });
  // Also save locally to avoid re-showing before Supabase syncs
  chrome.storage.local.get("ezap_notif_dismissed", function(stored) {
    var dismissed = (stored && stored.ezap_notif_dismissed) || {};
    dismissed[messageId] = true;
    chrome.storage.local.set({ ezap_notif_dismissed: dismissed });
  });
}

function escHtml(s) {
  var d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}
