document.addEventListener("DOMContentLoaded", () => {
  const apiKeyInput = document.getElementById("apiKey");
  const saveBtn = document.getElementById("saveBtn");
  const statusEl = document.getElementById("status");
  const userSection = document.getElementById("user-section");
  const noUserSection = document.getElementById("no-user-section");
  const userAvatar = document.getElementById("user-avatar");
  const userName = document.getElementById("user-name");
  const userRole = document.getElementById("user-role");
  const userToken = document.getElementById("user-token");
  const logoutBtn = document.getElementById("logoutBtn");

  const hubspotSection = document.getElementById("hubspot-section");
  const userInfoSection = document.getElementById("user-info-section");

  // ===== Set version from manifest =====
  var manifest = chrome.runtime.getManifest();
  var versionLabel = document.getElementById("version-label");
  if (versionLabel) versionLabel.textContent = "E-ZAP V" + manifest.version;

  // ===== Load auth info =====
  chrome.storage.local.get("wcrm_auth", (data) => {
    const auth = data.wcrm_auth;
    if (auth && auth.userId) {
      userSection.style.display = "block";
      noUserSection.style.display = "none";
      userName.textContent = auth.userName;
      var roleMap = { admin: "Administrador", user: "Usu\u00e1rio", cx_cs: "CX/CS" };
      userRole.textContent = roleMap[auth.userRole] || auth.userRole || "Usu\u00e1rio";
      userAvatar.textContent = (auth.userName || "U").charAt(0).toUpperCase();
      userToken.textContent = auth.token;

      // Only admins see HubSpot API key config
      if (auth.userRole === "admin") {
        hubspotSection.style.display = "block";
        userInfoSection.style.display = "none";
      } else {
        hubspotSection.style.display = "none";
        userInfoSection.style.display = "block";
      }
    } else {
      userSection.style.display = "none";
      noUserSection.style.display = "block";
      hubspotSection.style.display = "none";
      userInfoSection.style.display = "none";
    }
  });

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
            // Reload popup to show user section
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

    // Allow Enter key to submit
    if (tokenInput) {
      tokenInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") tokenBtn.click();
      });
    }
  }

  // ===== Logout =====
  logoutBtn.addEventListener("click", () => {
    if (!confirm("Deseja sair? Você precisará do token para reconectar.")) return;
    chrome.storage.local.remove("wcrm_auth", () => {
      // Tell background to relay logout to content scripts
      chrome.runtime.sendMessage({ action: "wcrm_logout" });
      // Update popup UI
      userSection.style.display = "none";
      noUserSection.style.display = "block";
    });
  });

  // ===== Load saved HubSpot key =====
  chrome.storage.local.get("hubspot_api_key", (data) => {
    if (data.hubspot_api_key) {
      apiKeyInput.value = data.hubspot_api_key;
      statusEl.className = "status ok";
      statusEl.textContent = "Chave salva anteriormente";
    }
  });

  saveBtn.addEventListener("click", () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      statusEl.className = "status err";
      statusEl.textContent = "Insira a API key";
      return;
    }

    statusEl.className = "status";
    statusEl.textContent = "Salvando e testando...";

    // Save first, test via background
    chrome.storage.local.set({ hubspot_api_key: key }, () => {
      // Test via background script
      chrome.runtime.sendMessage({ action: "test_hubspot_key", key: key }, (response) => {
        if (chrome.runtime.lastError) {
          // Even if test fails, key is saved
          statusEl.className = "status ok";
          statusEl.textContent = "Chave salva! (teste indisponível)";
          return;
        }
        if (response && response.ok) {
          statusEl.className = "status ok";
          statusEl.textContent = "Conectado ao HubSpot com sucesso!";
        } else {
          statusEl.className = "status err";
          statusEl.textContent = "Chave salva, mas erro ao testar: " + (response?.error || "desconhecido");
        }
      });
    });
  });
});
