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

  // No phones configured for this user — skip validation
  if (allowedPhones.length === 0) {
    console.log("[EZAP AUTH] No phone restrictions configured, skipping phone validation");
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

    // Final attempt after delay — try localStorage again
    setTimeout(function() {
      if (window.__ezapPhoneVerified) return;
      var retryPhone = detectWhatsAppPhone();
      if (retryPhone) {
        window.removeEventListener("message", phoneListener);
        checkPhoneMatch(retryPhone, allowedPhones);
      } else {
        console.log("[EZAP AUTH] Could not detect WhatsApp phone number, retrying...");
        // Keep retrying every 10 seconds for 2 minutes
        var retryCount = 0;
        var retryInterval = setInterval(function() {
          retryCount++;
          if (retryCount > 12 || window.__ezapPhoneVerified) {
            clearInterval(retryInterval);
            if (!window.__ezapPhoneVerified) {
              console.log("[EZAP AUTH] Phone detection failed after retries, blocking access");
              showPhoneBlockOverlay("Nao foi possivel verificar o numero do WhatsApp. Abra o perfil do WhatsApp e tente novamente.");
            }
            return;
          }
          var p = detectWhatsAppPhone();
          if (p) {
            clearInterval(retryInterval);
            window.removeEventListener("message", phoneListener);
            checkPhoneMatch(p, allowedPhones);
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
    showPhoneBlockOverlay("Este token esta vinculado a outro numero de WhatsApp. Numero detectado: +" + detected + ". Solicite ao administrador a atualizacao do seu numero.");
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
function silentRevalidate(token) {
  getDeviceId(function(deviceId) {
    chrome.runtime.sendMessage({
      action: "validate_token",
      token: token,
      deviceId: deviceId,
    }, function(response) {
      if (chrome.runtime.lastError) return;
      if (!response || !response.ok) {
        if (response && response.blocked) {
          // Device mismatch — blocked
          showPhoneBlockOverlay(response.error || "Token bloqueado em outro dispositivo.");
          chrome.storage.local.remove(AUTH_STORAGE_KEY);
          return;
        }
        // Token revoked/deactivated
        console.log("[EZAP AUTH] Token revoked, logging out");
        chrome.storage.local.remove(AUTH_STORAGE_KEY, function() {
          window.__wcrmAuth = null;
          location.reload();
        });
      } else if (response.data) {
        // Update features and allowed phones from server
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
          validatedAt: new Date().toISOString(),
        };
        chrome.storage.local.set(saved);
        setAuthGlobal(saved[AUTH_STORAGE_KEY]);
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
      '<div style="width:64px;height:64px;border-radius:50%;background:#25d366;display:flex;align-items:center;justify-content:center;margin:0 auto 16px">' +
        '<svg viewBox="0 0 24 24" width="32" height="32" fill="#111b21"><path d="M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2z"/></svg>' +
      '</div>' +
      '<h2 style="margin:0;font-size:22px;font-weight:700;color:#e9edef">E-ZAP</h2>' +
      '<p style="margin:6px 0 0;font-size:13px;color:#8696a0">Insira seu token de acesso para continuar</p>' +
    '</div>' +
    '<div style="margin-bottom:16px;text-align:left">' +
      '<label style="font-size:11px;color:#8696a0;display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Token de Acesso</label>' +
      '<input id="wcrm-auth-token" type="text" placeholder="Cole seu token aqui" maxlength="30" autocomplete="off" spellcheck="false" style="width:100%;padding:12px 14px;background:#111b21;border:2px solid #3b4a54;border-radius:10px;color:#e9edef;font-size:16px;font-family:monospace;letter-spacing:1px;outline:none;box-sizing:border-box;text-align:center;transition:border-color 0.2s">' +
    '</div>' +
    '<button id="wcrm-auth-login" style="width:100%;padding:14px;background:#25d366;color:#111b21;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;transition:background 0.2s;margin-bottom:12px">Entrar</button>' +
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
  input.addEventListener("focus", function() { input.style.borderColor = "#25d366"; });
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
            status.textContent = "Erro de conexao. Tente novamente.";
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
              validatedAt: new Date().toISOString(),
            };

            var saveObj = {};
            saveObj[AUTH_STORAGE_KEY] = authData;
            chrome.storage.local.set(saveObj, function() {
              status.style.color = "#25d366";
              status.textContent = "Bem-vindo, " + authData.userName + "!";
              btn.textContent = "Conectado!";
              btn.style.background = "#25d366";

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
});
