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
