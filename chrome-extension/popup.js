document.addEventListener("DOMContentLoaded", () => {
  const userSection = document.getElementById("user-section");
  const noUserSection = document.getElementById("no-user-section");
  const userAvatar = document.getElementById("user-avatar");
  const userName = document.getElementById("user-name");
  const userRole = document.getElementById("user-role");
  const userEmail = document.getElementById("user-email");
  const userToken = document.getElementById("user-token");
  const logoutBtn = document.getElementById("logoutBtn");
  const versionLabel = document.getElementById("version-label");
  const tokenEyeBtn = document.getElementById("tokenEyeBtn");

  // ===== Version =====
  var manifest = chrome.runtime.getManifest();
  var version = manifest.version;
  if (versionLabel) versionLabel.textContent = "v" + version;

  // ===== Token visibility state =====
  var tokenVisible = false;
  var fullToken = "";

  function maskToken(t) {
    if (!t) return "";
    var parts = t.split("-");
    if (parts.length >= 4) {
      return parts[0] + "-••••-••••-" + parts[parts.length - 1];
    }
    return t.substring(0, 5) + "••••••" + t.substring(t.length - 4);
  }

  // ===== Load auth info =====
  chrome.storage.local.get("wcrm_auth", (data) => {
    const auth = data.wcrm_auth;
    if (auth && auth.userId) {
      userSection.style.display = "block";
      noUserSection.style.display = "none";

      userName.textContent = auth.userName || "Usuário";
      var roleMap = { admin: "Administrador", user: "Usuário", cx_cs: "CX/CS" };
      userRole.textContent = roleMap[auth.userRole] || auth.userRole || "Usuário";
      userAvatar.textContent = (auth.userName || "U").charAt(0).toUpperCase();

      // Admin gets purple avatar
      if (auth.userRole === "admin") {
        userAvatar.style.background = "linear-gradient(135deg, #cc5de8, #9b59b6)";
      }

      userEmail.textContent = auth.userEmail || "-";

      fullToken = auth.token || "";
      userToken.textContent = maskToken(fullToken);
    } else {
      userSection.style.display = "none";
      noUserSection.style.display = "block";
    }
  });

  // ===== Token eye toggle =====
  if (tokenEyeBtn) {
    tokenEyeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      tokenVisible = !tokenVisible;
      userToken.textContent = tokenVisible ? fullToken : maskToken(fullToken);
      tokenEyeBtn.innerHTML = tokenVisible
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    });
  }

  // ===== Token copy on click =====
  if (userToken) {
    userToken.addEventListener("click", () => {
      if (!fullToken) return;
      navigator.clipboard.writeText(fullToken).then(() => {
        var orig = userToken.textContent;
        userToken.textContent = "Copiado!";
        userToken.style.color = "#00a884";
        setTimeout(() => {
          userToken.textContent = tokenVisible ? fullToken : maskToken(fullToken);
          userToken.style.color = "";
        }, 1200);
      });
    });
  }

  // ===== Token login from popup =====
  const tokenInput = document.getElementById("tokenInput");
  const tokenBtn = document.getElementById("tokenBtn");
  const tokenStatus = document.getElementById("tokenStatus");

  if (tokenBtn) {
    tokenBtn.addEventListener("click", () => {
      const token = (tokenInput.value || "").trim();
      if (!token || !/^WCRM-.{5,}$/i.test(token)) {
        tokenStatus.className = "status err";
        tokenStatus.textContent = "Token inválido. Deve começar com WCRM-";
        return;
      }

      tokenBtn.disabled = true;
      tokenBtn.textContent = "Verificando...";
      tokenBtn.style.opacity = "0.7";
      tokenStatus.className = "status";
      tokenStatus.textContent = "";

      chrome.runtime.sendMessage({
        action: "validate_token",
        token: token,
        deviceId: "popup-login",
        userAgent: navigator.userAgent,
      }, (response) => {
        tokenBtn.disabled = false;
        tokenBtn.textContent = "Entrar";
        tokenBtn.style.opacity = "1";

        if (chrome.runtime.lastError) {
          tokenStatus.className = "status err";
          tokenStatus.textContent = "Erro de conexão. Tente novamente.";
          return;
        }

        if (response && response.ok) {
          const authData = {
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

          chrome.storage.local.set({ wcrm_auth: authData }, () => {
            tokenStatus.className = "status ok";
            tokenStatus.textContent = "Bem-vindo, " + authData.userName + "!";
            setTimeout(() => location.reload(), 800);
          });
        } else if (response && response.blocked) {
          tokenStatus.className = "status err";
          tokenStatus.textContent = response.error || "Token bloqueado.";
        } else {
          tokenStatus.className = "status err";
          tokenStatus.textContent = response?.error || "Token não encontrado ou inativo.";
        }
      });
    });

    if (tokenInput) {
      tokenInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") tokenBtn.click();
      });
    }
  }

  // ===== Logout =====
  logoutBtn.addEventListener("click", () => {
    if (!confirm("Deseja sair? Você precisará do token para reconectar.")) return;
    chrome.storage.local.remove(["wcrm_auth", "ezap_overlay_hidden", "ezap_impersonate"], () => {
      chrome.runtime.sendMessage({ action: "wcrm_logout" });
      userSection.style.display = "none";
      noUserSection.style.display = "block";
    });
  });

  // ===== Admin-only features =====
  chrome.storage.local.get("wcrm_auth", (data) => {
    const auth = data.wcrm_auth;
    if (!auth || auth.userRole !== "admin") return;

    // Show admin section
    const adminSection = document.getElementById("admin-section");
    const toggleOverlayBtn = document.getElementById("toggleOverlayBtn");
    const impersonateSelect = document.getElementById("impersonateSelect");
    const impersonateStatus = document.getElementById("impersonateStatus");
    if (adminSection) adminSection.style.display = "block";
    if (toggleOverlayBtn) toggleOverlayBtn.style.display = "block";

    // --- Toggle Overlay ---
    chrome.storage.local.get("ezap_overlay_hidden", (d) => {
      if (d.ezap_overlay_hidden) {
        toggleOverlayBtn.textContent = "Mostrar Overlay";
        toggleOverlayBtn.style.color = "#00a884";
      }
    });

    toggleOverlayBtn.addEventListener("click", () => {
      chrome.storage.local.get("ezap_overlay_hidden", (d) => {
        const newHidden = !d.ezap_overlay_hidden;
        chrome.storage.local.set({ ezap_overlay_hidden: newHidden }, () => {
          toggleOverlayBtn.textContent = newHidden ? "Mostrar Overlay" : "Esconder Overlay";
          toggleOverlayBtn.style.color = newHidden ? "#00a884" : "#4d96ff";
          // Send to all WhatsApp Web tabs
          sendToWaTabs({ action: "ezap_toggle_overlay", hidden: newHidden });
        });
      });
    });

    // --- Impersonation ---
    // Load current impersonation state
    chrome.storage.local.get("ezap_impersonate", (d) => {
      if (d.ezap_impersonate && d.ezap_impersonate.userId) {
        impersonateStatus.textContent = "Visualizando como: " + d.ezap_impersonate.userName;
      }
    });

    // Load users for dropdown
    chrome.runtime.sendMessage({
      action: "supabase_rest",
      path: "/rest/v1/users?active=eq.true&select=id,name,email,phone&order=name.asc",
    }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      const users = Array.isArray(response) ? response : (response.data || []);
      if (!Array.isArray(users)) return;

      impersonateSelect.innerHTML = '<option value="">Meu perfil (admin)</option>';
      users.forEach((u) => {
        if (u.id === auth.userId) return; // Skip self
        const opt = document.createElement("option");
        opt.value = u.id;
        opt.textContent = (u.name || "Sem nome") + (u.phone ? " — " + u.phone : "");
        opt.dataset.name = u.name || "";
        opt.dataset.phone = u.phone || "";
        impersonateSelect.appendChild(opt);
      });

      // Set current selection if impersonating
      chrome.storage.local.get("ezap_impersonate", (d) => {
        if (d.ezap_impersonate && d.ezap_impersonate.userId) {
          impersonateSelect.value = d.ezap_impersonate.userId;
        }
      });
    });

    impersonateSelect.addEventListener("change", () => {
      const selectedId = impersonateSelect.value;
      if (!selectedId) {
        // Back to admin profile
        chrome.storage.local.remove("ezap_impersonate", () => {
          impersonateStatus.textContent = "";
          sendToWaTabs({ action: "ezap_stop_impersonate" });
        });
      } else {
        const opt = impersonateSelect.selectedOptions[0];
        const userName = opt.dataset.name || opt.textContent;
        const userPhone = opt.dataset.phone || "";
        chrome.storage.local.set({
          ezap_impersonate: { userId: selectedId, userName: userName, userPhone: userPhone }
        }, () => {
          impersonateStatus.textContent = "Visualizando como: " + userName;
          sendToWaTabs({ action: "ezap_start_impersonate", userId: selectedId, userName: userName, userPhone: userPhone });
        });
      }
    });
  });

  // Helper: send message to all WhatsApp Web tabs
  function sendToWaTabs(msg) {
    chrome.tabs.query({ url: "*://web.whatsapp.com/*" }, (tabs) => {
      (tabs || []).forEach((tab) => {
        chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
      });
    });
  }
});
