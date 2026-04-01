// ===== WhatsApp CRM - Authentication (Token-based login) =====
console.log("[WCRM AUTH] Loaded");

// ===== Constants =====
var AUTH_STORAGE_KEY = "wcrm_auth";

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
  };
}

// ===== Dispatch auth ready event =====
function dispatchAuthReady() {
  console.log("[WCRM AUTH] Authenticated as:", window.__wcrmAuth.userName, "(" + window.__wcrmAuth.userRole + ")");
  setTimeout(function() {
    document.dispatchEvent(new CustomEvent("wcrm-auth-ready"));
  }, 0);
}

// ===== Silent re-validation =====
function silentRevalidate(token) {
  chrome.runtime.sendMessage({ action: "validate_token", token: token }, function(response) {
    if (chrome.runtime.lastError) return; // Extension context issue, ignore
    if (!response || !response.ok) {
      // Token was revoked or deactivated — clear and reload
      console.log("[WCRM AUTH] Token revoked, logging out");
      chrome.storage.local.remove(AUTH_STORAGE_KEY, function() {
        window.__wcrmAuth = null;
        location.reload();
      });
    }
  });
}

// ===== Login Overlay =====
function showLoginOverlay() {
  if (document.getElementById("wcrm-auth-overlay")) return;

  var overlay = document.createElement("div");
  overlay.id = "wcrm-auth-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100%",
    height: "100%",
    background: "#111b21",
    zIndex: "9999999",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  });

  var card = document.createElement("div");
  Object.assign(card.style, {
    background: "#202c33",
    borderRadius: "16px",
    padding: "40px 36px",
    width: "380px",
    maxWidth: "90%",
    boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
    textAlign: "center",
  });

  card.innerHTML =
    // Logo / Title
    '<div style="margin-bottom:24px">' +
      '<div style="width:64px;height:64px;border-radius:50%;background:#25d366;display:flex;align-items:center;justify-content:center;margin:0 auto 16px">' +
        '<svg viewBox="0 0 24 24" width="32" height="32" fill="#111b21"><path d="M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2z"/></svg>' +
      '</div>' +
      '<h2 style="margin:0;font-size:22px;font-weight:700;color:#e9edef">WhatsApp CRM</h2>' +
      '<p style="margin:6px 0 0;font-size:13px;color:#8696a0">Insira seu token de acesso para continuar</p>' +
    '</div>' +
    // Token Input
    '<div style="margin-bottom:16px;text-align:left">' +
      '<label style="font-size:11px;color:#8696a0;display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Token de Acesso</label>' +
      '<input id="wcrm-auth-token" type="text" placeholder="WCRM-XXXX-XXXX-XXXX" maxlength="19" autocomplete="off" spellcheck="false" style="width:100%;padding:12px 14px;background:#111b21;border:2px solid #3b4a54;border-radius:10px;color:#e9edef;font-size:16px;font-family:monospace;letter-spacing:2px;outline:none;box-sizing:border-box;text-transform:uppercase;text-align:center;transition:border-color 0.2s">' +
    '</div>' +
    // Login Button
    '<button id="wcrm-auth-login" style="width:100%;padding:14px;background:#25d366;color:#111b21;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;transition:background 0.2s;margin-bottom:12px">Entrar</button>' +
    // Status message
    '<div id="wcrm-auth-status" style="font-size:13px;min-height:20px;color:#ff6b6b"></div>' +
    // Footer
    '<div style="margin-top:20px;padding-top:16px;border-top:1px solid #2a3942">' +
      '<p style="margin:0;font-size:11px;color:#8696a0">Solicite seu token ao administrador da equipe</p>' +
    '</div>';

  overlay.appendChild(card);

  // Wait for DOM to be ready
  function inject() {
    document.body.appendChild(overlay);
    setupLoginEvents();
  }

  if (document.body) {
    inject();
  } else {
    document.addEventListener("DOMContentLoaded", inject);
  }
}

// ===== Login Events =====
function setupLoginEvents() {
  var input = document.getElementById("wcrm-auth-token");
  var btn = document.getElementById("wcrm-auth-login");
  var status = document.getElementById("wcrm-auth-status");

  if (!input || !btn) return;

  // Auto-format token as user types: WCRM-XXXX-XXXX-XXXX
  input.addEventListener("input", function() {
    var raw = input.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    var formatted = "";
    if (raw.length > 0) formatted += raw.substring(0, 4);
    if (raw.length > 4) formatted += "-" + raw.substring(4, 8);
    if (raw.length > 8) formatted += "-" + raw.substring(8, 12);
    if (raw.length > 12) formatted += "-" + raw.substring(12, 16);
    input.value = formatted;
  });

  // Focus styling
  input.addEventListener("focus", function() { input.style.borderColor = "#25d366"; });
  input.addEventListener("blur", function() { input.style.borderColor = "#3b4a54"; });

  // Enter key
  input.addEventListener("keydown", function(e) {
    if (e.key === "Enter") doLogin();
  });

  // Click login
  btn.addEventListener("click", doLogin);

  // Focus input
  setTimeout(function() { input.focus(); }, 200);

  function doLogin() {
    var token = input.value.trim().toUpperCase();
    status.textContent = "";
    status.style.color = "#ff6b6b";

    // Validate format
    if (!/^WCRM-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(token) && !/^WCRM-ADMIN-[A-Z0-9]+$/i.test(token)) {
      status.textContent = "Formato inválido. Use: WCRM-XXXX-XXXX-XXXX";
      input.style.borderColor = "#ff6b6b";
      return;
    }

    // Show loading
    btn.disabled = true;
    btn.textContent = "Verificando...";
    btn.style.opacity = "0.7";
    input.style.borderColor = "#3b4a54";

    // Send to background for validation
    chrome.runtime.sendMessage({ action: "validate_token", token: token }, function(response) {
      if (chrome.runtime.lastError) {
        status.textContent = "Erro de conexão. Tente novamente.";
        resetButton();
        return;
      }

      if (response && response.ok) {
        // Success!
        var authData = {
          token: token,
          userId: response.data.user_id,
          userName: response.data.user_name,
          userEmail: response.data.user_email,
          userPhone: response.data.user_phone || "",
          userRole: response.data.user_role,
          validatedAt: new Date().toISOString(),
        };

        // Save to storage
        var saveObj = {};
        saveObj[AUTH_STORAGE_KEY] = authData;
        chrome.storage.local.set(saveObj, function() {
          // Show success
          status.style.color = "#25d366";
          status.textContent = "Bem-vindo, " + authData.userName + "!";
          btn.textContent = "Conectado!";
          btn.style.background = "#25d366";

          // Set global and activate
          setAuthGlobal(authData);

          // Remove overlay with animation
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
        // Failed
        status.textContent = response && response.error ? response.error : "Token inválido ou desativado.";
        input.style.borderColor = "#ff6b6b";
        resetButton();
      }
    });

    function resetButton() {
      btn.disabled = false;
      btn.textContent = "Entrar";
      btn.style.opacity = "1";
    }
  }
}

// ===== Logout (called from popup or externally) =====
window.__wcrmLogout = function() {
  chrome.storage.local.remove(AUTH_STORAGE_KEY, function() {
    window.__wcrmAuth = null;
    location.reload();
  });
};

// ===== Listen for logout message from popup =====
chrome.runtime.onMessage.addListener(function(request) {
  if (request.action === "wcrm_logout") {
    window.__wcrmLogout();
  }
});
