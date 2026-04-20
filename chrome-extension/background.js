importScripts('bg-hubspot.js', 'bg-openai.js', 'bg-google.js', 'bg-files.js');

// Background service worker - handles HubSpot API calls + Auth (required due to CORS/CSP)

// ===== Auth Supabase (user authentication) =====
const AUTH_SUPA_URL = "https://xsqpqdjffjqxdcmoytfc.supabase.co";
const AUTH_SUPA_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhzcXBxZGpmZmpxeGRjbW95dGZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM1MTIyMDMsImV4cCI6MjA3OTA4ODIwM30.TlUt4FQ7cffBKgJYrixFdHbyMESAhRa2auPpKCXMIMM";
const AUTH_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhzcXBxZGpmZmpxeGRjbW95dGZjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MzUxMjIwMywiZXhwIjoyMDc5MDg4MjAzfQ.QmSMnUA2x5AkhN_je20lcAb889-DnSyT-8w3dSQhsWM";

// ===== OpenAI key (fetched from Supabase app_settings) =====
let _openaiKey = null;
async function getOpenAIKey() {
  if (_openaiKey) return _openaiKey;
  try {
    const resp = await fetch(AUTH_SUPA_URL + "/rest/v1/app_settings?key=eq.openai_api_key&select=value", {
      headers: { "apikey": AUTH_SERVICE_KEY, "Authorization": "Bearer " + AUTH_SERVICE_KEY }
    });
    const rows = await resp.json();
    if (Array.isArray(rows) && rows.length > 0 && rows[0].value) {
      _openaiKey = rows[0].value;
      return _openaiKey;
    }
  } catch (e) { console.error("[EZAP BG] Failed to fetch OpenAI key:", e); }
  return null;
}

// ===== Auto-reload WhatsApp tabs on extension update =====
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "update") {
    console.log("[EZAP BG] Extension updated, reloading WhatsApp tabs...");
    chrome.tabs.query({ url: "https://web.whatsapp.com/*" }, (tabs) => {
      tabs.forEach((tab) => chrome.tabs.reload(tab.id));
    });
  }
});

// ===== IP / Location detection =====
async function getIpInfo() {
  try {
    const resp = await fetch("https://ipapi.co/json/", { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return { ip: null, location: null };
    const data = await resp.json();
    const loc = [data.city, data.region, data.country_name].filter(Boolean).join(", ");
    return { ip: data.ip || null, location: loc || null };
  } catch (e) {
    console.log("[EZAP BG] IP detection failed:", e.message);
    return { ip: null, location: null };
  }
}

async function validateToken(token, deviceId, ipAddress, locationStr, userAgent, skipLog) {
  const body = { p_token: token };
  if (deviceId) body.p_device_id = deviceId;
  if (ipAddress) body.p_ip_address = ipAddress;
  if (locationStr) body.p_location = locationStr;
  if (userAgent) body.p_user_agent = userAgent;
  if (skipLog) body.p_skip_log = true;

  const resp = await fetch(AUTH_SUPA_URL + "/rest/v1/rpc/validate_token", {
    method: "POST",
    headers: {
      "apikey": AUTH_SUPA_ANON,
      "Authorization": "Bearer " + AUTH_SUPA_ANON,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error("Supabase error: " + err);
  }

  const data = await resp.json();
  if (Array.isArray(data) && data.length > 0) {
    const row = data[0];
    if (row.token_status === "blocked_device") {
      // Check if this is a version upgrade — if so, allow device change
      const allowed = await tryVersionUpgradeBypass(token, deviceId);
      if (allowed) {
        // Retry validation with updated device
        return validateToken(token, deviceId, ipAddress, locationStr, userAgent);
      }
      return { ok: false, blocked: true, error: "Este token já está em uso em outro dispositivo. Solicite um novo token ao administrador." };
    }
    // Save current version for this user on successful login
    saveExtVersion(row.user_id);
    return { ok: true, data: row };
  } else {
    // RPC retornou array vazio = token não existe OU foi desativado (active=false).
    // Flag token_inactive permite o client tratar como revogação determinística
    // (diferente de erro transiente de rede/5xx que NÃO deve deslogar).
    return { ok: false, token_inactive: true, error: "Token inválido ou desativado." };
  }
}

// Compare semver: returns true if vA > vB
function isNewerSemver(vA, vB) {
  if (!vA || !vB) return false;
  const a = vA.split(".").map(Number);
  const b = vB.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

// When blocked_device, check if current version is newer than stored version.
// If yes, re-bind device_fingerprint and allow login.
async function tryVersionUpgradeBypass(token, newDeviceId) {
  try {
    const currentVersion = chrome.runtime.getManifest().version;
    const patchHeaders = {
      "apikey": AUTH_SERVICE_KEY,
      "Authorization": "Bearer " + AUTH_SERVICE_KEY,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    };
    const patchBody = JSON.stringify({
      device_fingerprint: newDeviceId,
      ext_version: currentVersion,
      redeemed_at: new Date().toISOString(),
    });

    // Check user_tokens first (multi-token support)
    const tokResp = await fetch(
      AUTH_SUPA_URL + "/rest/v1/user_tokens?token=ilike." + encodeURIComponent(token) + "&select=id,user_id,ext_version,device_fingerprint",
      { headers: { "apikey": AUTH_SERVICE_KEY, "Authorization": "Bearer " + AUTH_SERVICE_KEY } }
    );
    if (tokResp.ok) {
      const tokRows = await tokResp.json();
      if (tokRows.length > 0) {
        const tok = tokRows[0];
        const storedVersion = tok.ext_version || "0.0.0";
        if (!isNewerSemver(currentVersion, storedVersion)) return false;

        // Update user_tokens
        const r1 = await fetch(AUTH_SUPA_URL + "/rest/v1/user_tokens?id=eq." + tok.id,
          { method: "PATCH", headers: patchHeaders, body: patchBody });
        // Also update users table
        await fetch(AUTH_SUPA_URL + "/rest/v1/users?id=eq." + tok.user_id,
          { method: "PATCH", headers: patchHeaders, body: patchBody });
        return r1.ok;
      }
    }

    // Fallback: check users table directly
    const resp = await fetch(
      AUTH_SUPA_URL + "/rest/v1/users?token=ilike." + encodeURIComponent(token) + "&select=id,ext_version,device_fingerprint",
      { headers: { "apikey": AUTH_SERVICE_KEY, "Authorization": "Bearer " + AUTH_SERVICE_KEY } }
    );
    if (!resp.ok) return false;
    const rows = await resp.json();
    if (!rows.length) return false;

    const user = rows[0];
    const storedVersion = user.ext_version || "0.0.0";
    if (!isNewerSemver(currentVersion, storedVersion)) return false;

    const patchResp = await fetch(AUTH_SUPA_URL + "/rest/v1/users?id=eq." + user.id,
      { method: "PATCH", headers: patchHeaders, body: patchBody });
    return patchResp.ok;
  } catch (e) {
    console.warn("[EZAP BG] Version bypass error:", e.message);
    return false;
  }
}

// Save current extension version to user record after successful login
async function saveExtVersion(userId) {
  try {
    const version = chrome.runtime.getManifest().version;
    await fetch(
      AUTH_SUPA_URL + "/rest/v1/users?id=eq." + userId,
      {
        method: "PATCH",
        headers: {
          "apikey": AUTH_SERVICE_KEY,
          "Authorization": "Bearer " + AUTH_SERVICE_KEY,
          "Content-Type": "application/json",
          "Prefer": "return=minimal",
        },
        body: JSON.stringify({ ext_version: version }),
      }
    );
  } catch (e) {
    // Silent — not critical
  }
}

// ===== Version Check (periodic alarm) =====
const RELEASE_JSON_URL = AUTH_SUPA_URL + "/storage/v1/object/public/releases/release.json";

// Create alarm for periodic version check (every 60 minutes)
chrome.alarms.create("ezap_version_check", { delayInMinutes: 1, periodInMinutes: 60 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ezap_version_check") {
    checkForUpdate();
    return;
  }

  // Meet summary processing alarm
  if (alarm.name.startsWith("meet_summary_")) {
    console.log("[EZAP BG] Meet summary alarm fired: " + alarm.name);
    chrome.storage.local.get(alarm.name, async (data) => {
      var info = data[alarm.name];
      if (!info || !info.meetingTitle) {
        console.log("[EZAP BG] No meeting info found for alarm: " + alarm.name);
        chrome.storage.local.remove(alarm.name);
        return;
      }

      console.log("[EZAP BG] Processing summary for: " + info.meetingTitle);
      try {
        // Step 1: Find the Gemini doc in Drive
        var searchTitle = info.meetingTitle.replace(/\[.*\]/, "").trim();
        var searchQuery = "mimeType='application/vnd.google-apps.document' and modifiedTime > '" +
          new Date(Date.now() - 3600000).toISOString() + "'";
        var driveResults = await googleDriveSearch(searchQuery);

        if (!driveResults.files || driveResults.files.length === 0) {
          console.log("[EZAP BG] No Gemini doc found yet, retrying in 5 min...");
          // Retry once more in 5 minutes
          var retryKey = alarm.name + "_retry";
          var retried = await chrome.storage.local.get(retryKey);
          if (!retried[retryKey]) {
            chrome.storage.local.set({ [retryKey]: true });
            chrome.alarms.create(alarm.name, { delayInMinutes: 5 });
            return;
          }
          console.log("[EZAP BG] Already retried, giving up on summary for: " + info.meetingTitle);
          chrome.storage.local.remove([alarm.name, retryKey]);
          return;
        }

        // Find the most recent doc (likely the Gemini summary)
        var docId = driveResults.files[0].id;
        var docData = await googleDocsRead(docId);
        console.log("[EZAP BG] Found Gemini doc: " + docData.title + " (" + docData.text.length + " chars)");

        // Step 2: Find the meet_recording ID for this meeting
        var recordings = await supabaseRest(
          "/rest/v1/meet_recordings?meeting_title=eq." + encodeURIComponent(info.meetingTitle) +
          "&event_type=eq.recording_started&order=created_at.desc&limit=1", "GET"
        );
        var meetRecordingId = (recordings && recordings.length > 0) ? recordings[0].id : null;

        // Step 3: Run full pipeline
        var result = await processMeetSummary(meetRecordingId, info.meetingTitle, docData.text);
        console.log("[EZAP BG] Summary pipeline complete:", JSON.stringify(result.steps));

        // Cleanup
        chrome.storage.local.remove([alarm.name, alarm.name + "_retry"]);
      } catch (e) {
        console.error("[EZAP BG] Summary processing error:", e.message);
        chrome.storage.local.remove([alarm.name, alarm.name + "_retry"]);
      }
    });
  }
});

async function checkForUpdate() {
  try {
    const resp = await fetch(RELEASE_JSON_URL + "?t=" + Date.now(), { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return;
    const release = await resp.json();
    if (!release || !release.version) return;

    const manifest = chrome.runtime.getManifest();
    const currentVersion = manifest.version;

    if (isNewerVersion(release.version, currentVersion)) {
      // New version available

      // Só notifica se release.json tem notify: true (admin controla no painel).
      // Sem notify ou notify: false = versão silenciosa (só admin atualiza local).
      if (!release.notify) {
        // Silent version, skip notification
        return;
      }

      // Guarda info do update. Se ja tinha um pendente de versao anterior,
      // SOBRESCREVE com a versao mais nova (resolve problema de notificacao
      // empilhada que ficava mostrando versao antiga).
      const stored = await chrome.storage.local.get(["ezap_update", "ezap_update_dismissed"]);
      const prevUpdate = stored.ezap_update;

      // Se user dismissou uma versao ANTERIOR, limpa o dismiss pra que a
      // nova versao seja exibida normalmente.
      if (stored.ezap_update_dismissed && stored.ezap_update_dismissed !== release.version) {
        await chrome.storage.local.remove("ezap_update_dismissed");
      }

      await chrome.storage.local.set({
        ezap_update: {
          version: release.version,
          message: release.message || release.notes || "",
          download_url: release.download_url || release.url || "",
          published_at: release.published_at || "",
          checked_at: new Date().toISOString(),
        }
      });

      // Notifica todas as tabs do WhatsApp (com versao MAIS RECENTE)
      chrome.tabs.query({ url: "https://web.whatsapp.com/*" }, (tabs) => {
        tabs.forEach((tab) => {
          chrome.tabs.sendMessage(tab.id, {
            action: "ezap_update_available",
            version: release.version,
            message: release.message || release.notes || "",
            download_url: release.download_url || release.url || "",
            force_replace: !!(prevUpdate && prevUpdate.version !== release.version),
          }).catch(() => {});
        });
      });
    } else {
      // No update — clear any stored update info
      await chrome.storage.local.remove("ezap_update");
    }
  } catch (e) {
    console.log("[EZAP BG] Version check failed:", e.message);
  }
}

// Compare semver: returns true if remoteVer > localVer
function isNewerVersion(remoteVer, localVer) {
  const r = remoteVer.split(".").map(Number);
  const l = localVer.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const rv = r[i] || 0;
    const lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false; // equal
}

// Sync HubSpot key from Supabase on startup, then pre-load pipeline stages
syncHubSpotKey().then(function() {
  loadStageCache().catch(function() {
    // Pre-load stages deferred (key not ready)
  });
});

// Also check for updates on startup
checkForUpdate();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "ping") {
    sendResponse({ ok: true });
    return false;
  }
  if (request.action === "sync_hubspot_key") {
    handleAsync(() => syncHubSpotKey(), sendResponse);
    return true;
  }

  // ===== Auth handlers =====
  if (request.action === "validate_token") {
    handleAsync(() => validateToken(request.token, request.deviceId, request.ipAddress, request.location, request.userAgent, request.skipLog), sendResponse);
    return true;
  }
  if (request.action === "get_ip_info") {
    handleAsync(() => getIpInfo(), sendResponse);
    return true;
  }
  if (request.action === "check_update") {
    handleAsync(() => checkForUpdate().then(() => chrome.storage.local.get("ezap_update").then(r => r.ezap_update || null)), sendResponse);
    return true;
  }
  if (request.action === "upload_note_image") {
    handleAsync(() => uploadNoteImage(request.base64, request.fileName, request.contentType), sendResponse);
    return true;
  }
  if (request.action === "upload_msg_file") {
    handleAsync(() => uploadMsgFile(request.base64, request.fileName, request.contentType), sendResponse);
    return true;
  }
  if (request.action === "download_msg_file") {
    handleAsync(() => downloadMsgFile(request.url), sendResponse);
    return true;
  }
  if (request.action === "log_phone_mismatch") {
    handleAsync(() => supabaseRpc("log_phone_mismatch", {
      p_user_id: request.userId,
      p_detected_phone: request.detectedPhone,
      p_ip: request.ip || null,
      p_location: request.location || null,
    }), sendResponse);
    return true;
  }
  if (request.action === "wcrm_logout") {
    // Relay logout to all WhatsApp Web tabs
    chrome.tabs.query({ url: "https://web.whatsapp.com/*" }, (tabs) => {
      tabs.forEach((tab) => {
        chrome.tabs.sendMessage(tab.id, { action: "wcrm_logout" });
      });
    });
    return false;
  }

  if (request.action === "test_hubspot_key") {
    handleAsync(() => testHubSpotKey(request.key), sendResponse);
    return true;
  }
  if (request.action === "hubspot_search_contact") {
    handleAsync(() => searchHubSpotContact(request.phone, request.chatName), sendResponse);
    return true;
  }
  if (request.action === "hubspot_get_deals") {
    handleAsync(() => getHubSpotDeals(request.contactId), sendResponse);
    return true;
  }
  if (request.action === "hubspot_get_tickets") {
    handleAsync(() => getHubSpotTickets(request.contactId), sendResponse);
    return true;
  }
  if (request.action === "hubspot_search_tickets_by_name") {
    handleAsync(() => searchTicketsByName(request.name), sendResponse);
    return true;
  }
  if (request.action === "supabase_seller_data") {
    handleAsync(() => getSellerData(request.sellerId), sendResponse);
    return true;
  }
  if (request.action === "hubspot_create_note") {
    handleAsync(() => createHubSpotNote(request.ticketId, request.noteBody), sendResponse);
    return true;
  }
  if (request.action === "hubspot_get_meetings") {
    handleAsync(() => getHubSpotMeetings(request.ticketId, request.contactId), sendResponse);
    return true;
  }
  if (request.action === "hubspot_get_notes") {
    handleAsync(() => getHubSpotNotes(request.ticketId), sendResponse);
    return true;
  }
  if (request.action === "hubspot_delete_note") {
    handleAsync(() => deleteHubSpotNote(request.noteId), sendResponse);
    return true;
  }
  if (request.action === "hubspot_update_note") {
    handleAsync(() => updateHubSpotNote(request.noteId, request.noteBody), sendResponse);
    return true;
  }

  // ===== Audio Transcription (OpenAI Whisper) =====
  if (request.action === "transcribe_audio") {
    handleAsync(() => transcribeAudio(request.base64, request.contentType), sendResponse);
    return true;
  }

  // ===== Auto-transcribe: transcribe + save to Supabase =====
  if (request.action === "transcribe_and_save") {
    handleAsync(() => transcribeAndSave(request.base64, request.contentType, request.messageWid, request.userId), sendResponse);
    return true;
  }

  // ===== GEIA - AI Chat Completion =====
  if (request.action === "geia_chat") {
    handleAsync(() => geiaChatCompletion(request.messages, request.maxTokens), sendResponse);
    return true;
  }
  if (request.action === "geia_get_config") {
    handleAsync(() => geiaGetConfig(), sendResponse);
    return true;
  }

  // ===== Google OAuth + Drive/Docs =====
  if (request.action === "google_auth") {
    handleAsync(() => getGoogleAuthToken(request.interactive), sendResponse);
    return true;
  }
  if (request.action === "google_drive_search") {
    handleAsync(() => googleDriveSearch(request.query, request.mimeType), sendResponse);
    return true;
  }
  if (request.action === "google_docs_read") {
    handleAsync(() => googleDocsRead(request.documentId), sendResponse);
    return true;
  }
  if (request.action === "google_fetch_meet_summary") {
    handleAsync(() => fetchMeetSummary(request.meetingTitle, request.meetRecordingId), sendResponse);
    return true;
  }
  if (request.action === "process_meet_summary") {
    handleAsync(() => processMeetSummary(request.meetRecordingId, request.meetingTitle, request.geminiText), sendResponse);
    return true;
  }
  if (request.action === "schedule_meet_summary") {
    // Save meeting info and schedule alarm for 5 minutes
    var alarmName = "meet_summary_" + Date.now();
    chrome.storage.local.set({
      [alarmName]: { meetingTitle: request.meetingTitle, userId: request.userId }
    }, () => {
      chrome.alarms.create(alarmName, { delayInMinutes: 5 });
      console.log("[EZAP BG] Scheduled summary processing in 5 min: " + request.meetingTitle);
    });
    sendResponse({ ok: true, alarm: alarmName });
    return true;
  }

  // ===== Generic Supabase REST (for data sync) =====
  if (request.action === "supabase_rest") {
    handleAsync(() => supabaseRest(request.path, request.method, request.body, request.prefer), sendResponse);
    return true;
  }
  if (request.action === "supabase_rpc") {
    handleAsync(() => supabaseRpc(request.fn, request.args), sendResponse);
    return true;
  }

  return false;
});

function handleAsync(fn, sendResponse) {
  fn()
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ error: err.message || "Unknown error" }));
}

// ===== Generic Supabase REST for data sync (uses service role key to bypass RLS) =====
async function supabaseRest(path, method, body, prefer) {
  const headers = {
    "apikey": AUTH_SERVICE_KEY,
    "Authorization": "Bearer " + AUTH_SERVICE_KEY,
    "Content-Type": "application/json",
    "Prefer": prefer || "return=representation",
  };
  const opts = { method: method || "GET", headers };
  if (body && method !== "GET") opts.body = JSON.stringify(body);
  const resp = await fetch(AUTH_SUPA_URL + path, opts);
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(err);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

async function supabaseRpc(fn, args) {
  return supabaseRest("/rest/v1/rpc/" + fn, "POST", args || {});
}

// =============================================
// ===== SUPABASE - Mercado Livre Data =========
// =============================================

const SUPA_URL = "https://eklcsufcwjtxlpxhncnt.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVrbGNzdWZjd2p0eGxweGhuY250Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTczNzU2MTEyMiwiZXhwIjoyMDUzMTM3MTIyfQ.ofCsFTXqkF2AydqLKP8FFdrrcpECBNLX4_iB4JCCRlA";

async function supaFetch(path, options) {
  const res = await fetch(SUPA_URL + "/rest/v1" + path, {
    ...options,
    headers: {
      "apikey": SUPA_KEY,
      "Authorization": "Bearer " + SUPA_KEY,
      "Content-Type": "application/json",
      ...(options && options.headers),
    },
  });
  if (!res.ok) throw new Error("Supabase HTTP " + res.status);
  return res.json();
}

function dateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

function dateToday() {
  return new Date().toISOString().split("T")[0];
}

async function getSellerData(sellerId) {
  try {
    const today = dateToday();

    // Fetch revenue for 7, 14, 30 days in parallel
    const [rev7, rev14, rev30, topProducts] = await Promise.all([
      supaFetch("/rpc/meli_calc_faturamento", {
        method: "POST",
        body: JSON.stringify({ p_seller_id: sellerId, p_start_date: dateNDaysAgo(7), p_end_date: today }),
      }),
      supaFetch("/rpc/meli_calc_faturamento", {
        method: "POST",
        body: JSON.stringify({ p_seller_id: sellerId, p_start_date: dateNDaysAgo(14), p_end_date: today }),
      }),
      supaFetch("/rpc/meli_calc_faturamento", {
        method: "POST",
        body: JSON.stringify({ p_seller_id: sellerId, p_start_date: dateNDaysAgo(30), p_end_date: today }),
      }),
      // Top 3 products by sold_quantity
      supaFetch("/meli_productxseller?seller_id=eq." + sellerId +
        "&select=product_id,family_name,price,sold_quantity,status" +
        "&order=sold_quantity.desc&limit=3"),
    ]);

    // Get thumbnails for top products
    let products = topProducts || [];
    if (products.length > 0) {
      const productIds = products.map(p => p.product_id).join(",");
      try {
        const items = await supaFetch("/meli_items?product_id=in.(" + productIds + ")&select=product_id,thumbnail");
        const thumbMap = {};
        (items || []).forEach(i => { thumbMap[i.product_id] = i.thumbnail; });
        products = products.map(p => ({
          ...p,
          thumbnail: thumbMap[p.product_id] || null,
        }));
      } catch (e) {
        console.log("[WCRM BG] Failed to fetch thumbnails:", e.message);
      }
    }

    return {
      revenue: {
        days7: rev7.faturamentounit || 0,
        days14: rev14.faturamentounit || 0,
        days30: rev30.faturamentounit || 0,
      },
      topProducts: products,
    };
  } catch (e) {
    return { error: e.message };
  }
}
