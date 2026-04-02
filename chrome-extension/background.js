// Background service worker - handles HubSpot API calls + Auth (required due to CORS/CSP)

// ===== Auth Supabase (user authentication) =====
const AUTH_SUPA_URL = "https://xsqpqdjffjqxdcmoytfc.supabase.co";
const AUTH_SUPA_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhzcXBxZGpmZmpxeGRjbW95dGZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM1MTIyMDMsImV4cCI6MjA3OTA4ODIwM30.TlUt4FQ7cffBKgJYrixFdHbyMESAhRa2auPpKCXMIMM";
const AUTH_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhzcXBxZGpmZmpxeGRjbW95dGZjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MzUxMjIwMywiZXhwIjoyMDc5MDg4MjAzfQ.QmSMnUA2x5AkhN_je20lcAb889-DnSyT-8w3dSQhsWM";

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

async function validateToken(token, deviceId, ipAddress, locationStr, userAgent) {
  const body = { p_token: token };
  if (deviceId) body.p_device_id = deviceId;
  if (ipAddress) body.p_ip_address = ipAddress;
  if (locationStr) body.p_location = locationStr;
  if (userAgent) body.p_user_agent = userAgent;

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
      return { ok: false, blocked: true, error: "Este token já está em uso em outro dispositivo. Solicite um novo token ao administrador." };
    }
    return { ok: true, data: row };
  } else {
    return { ok: false, error: "Token inválido ou desativado." };
  }
}

// Sync HubSpot key from Supabase on startup, then pre-load pipeline stages
syncHubSpotKey().then(function() {
  loadStageCache().catch(function() {
    console.log("[EZAP BG] Pre-load stages deferred (key not ready yet)");
  });
});

// ===== HubSpot Results Cache (5-minute TTL) =====
const _hsCache = {};
const HS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function hsCacheGet(key) {
  const entry = _hsCache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > HS_CACHE_TTL) { delete _hsCache[key]; return null; }
  return entry.data;
}

function hsCacheSet(key, data) {
  _hsCache[key] = { data: data, ts: Date.now() };
}

function hsCacheClear(prefix) {
  if (!prefix) { Object.keys(_hsCache).forEach(function(k) { delete _hsCache[k]; }); return; }
  Object.keys(_hsCache).forEach(function(k) { if (k.startsWith(prefix)) delete _hsCache[k]; });
}

// Cache for pipeline stages (maps stageId -> {label, pipelineName})
let stageCache = {};
let stageCacheLoaded = false;

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
    handleAsync(() => validateToken(request.token, request.deviceId, request.ipAddress, request.location, request.userAgent), sendResponse);
    return true;
  }
  if (request.action === "get_ip_info") {
    handleAsync(() => getIpInfo(), sendResponse);
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

// HubSpot API key: loaded from chrome.storage (set via popup or synced from Supabase)
async function getApiKey() {
  const data = await chrome.storage.local.get("hubspot_api_key");
  return data.hubspot_api_key || null;
}

// Load HubSpot key from Supabase app_settings and cache in chrome.storage
async function syncHubSpotKey() {
  try {
    const resp = await fetch(AUTH_SUPA_URL + "/rest/v1/app_settings?key=eq.hubspot_api_key&select=value", {
      headers: {
        "apikey": AUTH_SERVICE_KEY,
        "Authorization": "Bearer " + AUTH_SERVICE_KEY,
      },
    });
    if (!resp.ok) return;
    const rows = await resp.json();
    if (rows && rows.length > 0 && rows[0].value) {
      await chrome.storage.local.set({ hubspot_api_key: rows[0].value });
      console.log("[EZAP BG] HubSpot key synced from Supabase");
    }
  } catch (e) {
    console.log("[EZAP BG] Could not sync HubSpot key:", e.message);
  }
}

async function hubFetch(path, options) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error("API key not configured");
  const res = await fetch("https://api.hubapi.com" + path, {
    ...options,
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Content-Type": "application/json",
      ...(options && options.headers),
    },
  });
  if (!res.ok) {
    let errDetail = "";
    try { errDetail = await res.text(); } catch (e) { /* ignore */ }
    console.error("[EZAP BG] HubSpot " + res.status + " on " + path + ":", errDetail);
    throw new Error("HubSpot HTTP " + res.status);
  }
  return res.json();
}

// ===== Pipeline stage cache =====
async function loadStageCache() {
  if (stageCacheLoaded) return;
  try {
    // Load deal and ticket pipelines in parallel
    const [dealResult, ticketResult] = await Promise.allSettled([
      hubFetch("/crm/v3/pipelines/deals"),
      hubFetch("/crm/v3/pipelines/tickets"),
    ]);

    if (dealResult.status === "fulfilled") {
      dealResult.value.results.forEach(function(p) {
        p.stages.forEach(function(s) {
          stageCache["deal_" + s.id] = { label: s.label, pipeline: p.label };
        });
      });
    } else {
      console.log("[EZAP BG] Deal pipelines error:", dealResult.reason && dealResult.reason.message);
    }

    if (ticketResult.status === "fulfilled") {
      ticketResult.value.results.forEach(function(p) {
        p.stages.forEach(function(s) {
          stageCache["ticket_" + s.id] = { label: s.label, pipeline: p.label };
        });
      });
    } else {
      console.log("[EZAP BG] Ticket pipelines not available:", ticketResult.reason && ticketResult.reason.message);
    }

    stageCacheLoaded = true;
  } catch (e) {
    console.error("[EZAP BG] Failed to load stages:", e);
  }
}

function getStageName(type, stageId) {
  const entry = stageCache[type + "_" + stageId];
  return entry || { label: stageId, pipeline: "Desconhecido" };
}

// ===== API Key Test =====
async function testHubSpotKey(key) {
  const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts?limit=1", {
    headers: { "Authorization": "Bearer " + key },
  });
  return res.ok ? { ok: true } : { ok: false, error: "HTTP " + res.status };
}

// ===== Contact Search =====
const CONTACT_PROPS = [
  "firstname", "lastname", "email", "phone", "mobilephone",
  "company", "lifecyclestage", "hs_lead_status",
  "num_associated_deals", "total_revenue", "createdate",
];

async function searchHubSpotContact(phone, chatName) {
  // Check cache first
  const cacheKey = "contact_" + (phone || "") + "_" + (chatName || "");
  const cached = hsCacheGet(cacheKey);
  if (cached) return cached;

  await loadStageCache();

  const apiKey = await getApiKey();
  if (!apiKey) return { error: "API key not configured" };

  // Extract client name (before |) for name-based search
  const clientName = chatName ? chatName.split(/\s*\|\s*/)[0].trim() : "";

  const cleaned = phone.replace(/\D/g, "");

  // Try phone search first
  if (cleaned.length >= 8) {
    const data = await hubFetch("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [
          { filters: [{ propertyName: "phone", operator: "CONTAINS_TOKEN", value: cleaned }] },
          { filters: [{ propertyName: "mobilephone", operator: "CONTAINS_TOKEN", value: cleaned }] },
        ],
        properties: CONTACT_PROPS,
        limit: 1,
      }),
    });
    if (data.total > 0) {
      const result = { contact: data.results[0] };
      hsCacheSet(cacheKey, result);
      return result;
    }
  }

  // Fallback: search by name (firstname + lastname)
  if (clientName) {
    const result = await searchByName(clientName);
    hsCacheSet(cacheKey, result);
    return result;
  }

  return { contact: null };
}

async function searchByName(name) {
  const skipWords = ["de", "da", "do", "dos", "das"];
  const parts = name.trim().split(/\s+/).filter(w => w.length >= 2);
  if (parts.length === 0) return { contact: null };

  const firstName = parts[0];
  // Get significant last name part (skip prepositions)
  const lastParts = parts.slice(1).filter(w => skipWords.indexOf(w.toLowerCase()) === -1);
  const lastName = lastParts.length > 0 ? lastParts[lastParts.length - 1] : null;

  try {
    let filterGroups;
    if (lastName) {
      // Search firstname AND lastname together for precision
      filterGroups = [
        {
          filters: [
            { propertyName: "firstname", operator: "CONTAINS_TOKEN", value: firstName },
            { propertyName: "lastname", operator: "CONTAINS_TOKEN", value: lastName },
          ],
        },
      ];
    } else {
      filterGroups = [
        { filters: [{ propertyName: "firstname", operator: "CONTAINS_TOKEN", value: firstName }] },
      ];
    }

    const data = await hubFetch("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: filterGroups,
        properties: CONTACT_PROPS,
        limit: 1,
      }),
    });

    if (data.total > 0) return { contact: data.results[0] };

    // If firstname+lastname found nothing, try just firstname
    if (lastName) {
      const data2 = await hubFetch("/crm/v3/objects/contacts/search", {
        method: "POST",
        body: JSON.stringify({
          filterGroups: [
            { filters: [{ propertyName: "firstname", operator: "CONTAINS_TOKEN", value: firstName }] },
          ],
          properties: CONTACT_PROPS,
          limit: 5,
        }),
      });
      // Filter results: prefer those whose lastname contains any of our name parts
      if (data2.total > 0) {
        const nameLower = parts.map(p => p.toLowerCase());
        const best = data2.results.find(function(c) {
          const fn = (c.properties.firstname || "").toLowerCase();
          const ln = (c.properties.lastname || "").toLowerCase();
          const full = fn + " " + ln;
          return nameLower.filter(p => full.includes(p)).length >= 2;
        });
        return { contact: best || data2.results[0] };
      }
    }

    return { contact: null };
  } catch {
    return { contact: null };
  }
}

// ===== Deals (Batch API) =====
async function getHubSpotDeals(contactId) {
  try {
    // Check cache
    const cacheKey = "deals_" + contactId;
    const cached = hsCacheGet(cacheKey);
    if (cached) return cached;

    await loadStageCache();

    const assocData = await hubFetch("/crm/v4/objects/contacts/" + contactId + "/associations/deals");
    if (!assocData.results || assocData.results.length === 0) return { deals: [] };

    const dealIds = assocData.results.map(function(a) { return a.toObjectId; }).slice(0, 5);

    // Batch read all deals in a single API call
    const batchResult = await hubFetch("/crm/v3/objects/deals/batch/read", {
      method: "POST",
      body: JSON.stringify({
        inputs: dealIds.map(function(id) { return { id: id }; }),
        properties: ["dealname", "amount", "dealstage", "pipeline", "closedate"],
      }),
    });

    const deals = (batchResult.results || []).map(function(deal) {
      const stageInfo = getStageName("deal", deal.properties.dealstage);
      deal.properties._stageName = stageInfo.label;
      deal.properties._pipelineName = stageInfo.pipeline;
      return deal;
    });

    const result = { deals: deals };
    hsCacheSet(cacheKey, result);
    return result;
  } catch (e) {
    return { deals: [] };
  }
}

// ===== Create Note on Ticket =====
async function createHubSpotNote(ticketId, noteBody) {
  try {
    const result = await hubFetch("/crm/v3/objects/notes", {
      method: "POST",
      body: JSON.stringify({
        properties: {
          hs_timestamp: new Date().toISOString(),
          hs_note_body: noteBody,
        },
        associations: [
          {
            to: { id: ticketId },
            types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 228 }],
          },
        ],
      }),
    });
    // Invalidate notes cache for this ticket
    hsCacheClear("notes_" + ticketId);
    return { ok: true, noteId: result.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function deleteHubSpotNote(noteId) {
  try {
    const apiKey = await getApiKey();
    if (!apiKey) throw new Error("API key not configured");
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/notes/" + noteId, {
      method: "DELETE",
      headers: { "Authorization": "Bearer " + apiKey },
    });
    if (!res.ok && res.status !== 204) throw new Error("HubSpot HTTP " + res.status);
    // Invalidate all notes caches (we don't know which ticket this note belongs to)
    hsCacheClear("notes_");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function updateHubSpotNote(noteId, noteBody) {
  try {
    const result = await hubFetch("/crm/v3/objects/notes/" + noteId, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          hs_note_body: noteBody,
        },
      }),
    });
    // Invalidate all notes caches
    hsCacheClear("notes_");
    return { ok: true, noteId: result.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ===== Get Notes from Ticket (Batch API) =====
async function getHubSpotNotes(ticketId) {
  try {
    // Check cache
    const cacheKey = "notes_" + ticketId;
    const cached = hsCacheGet(cacheKey);
    if (cached) return cached;

    const assoc = await hubFetch("/crm/v4/objects/tickets/" + ticketId + "/associations/notes");
    if (!assoc.results || assoc.results.length === 0) return { notes: [] };

    const noteIds = assoc.results.map(function(a) { return a.toObjectId; }).slice(0, 20);

    // Batch read all notes in a single API call
    const batchResult = await hubFetch("/crm/v3/objects/notes/batch/read", {
      method: "POST",
      body: JSON.stringify({
        inputs: noteIds.map(function(id) { return { id: id }; }),
        properties: ["hs_note_body", "hs_timestamp", "hs_lastmodifieddate"],
      }),
    });

    var notes = batchResult.results || [];

    // Sort by timestamp descending
    notes.sort(function(a, b) {
      var da = a.properties.hs_timestamp || "";
      var db = b.properties.hs_timestamp || "";
      return db.localeCompare(da);
    });

    const result = { notes: notes };
    hsCacheSet(cacheKey, result);
    return result;
  } catch (e) {
    return { notes: [], error: e.message };
  }
}

// ===== Meetings (Parallel associations + Batch API) =====
const MEETING_PROPS = ["hs_meeting_title", "hs_timestamp", "hs_meeting_start_time", "hs_meeting_end_time", "hs_meeting_outcome"];

async function getHubSpotMeetings(ticketId, contactId) {
  try {
    // Check cache
    const cacheKey = "meetings_" + (ticketId || "") + "_" + (contactId || "");
    const cached = hsCacheGet(cacheKey);
    if (cached) return cached;

    // Fetch ticket and contact associations in parallel
    const assocPromises = [];
    if (ticketId) assocPromises.push(
      hubFetch("/crm/v4/objects/tickets/" + ticketId + "/associations/meetings").catch(function(e) {
        console.log("[EZAP BG] Ticket->meetings assoc error:", e.message);
        return { results: [] };
      })
    );
    if (contactId) assocPromises.push(
      hubFetch("/crm/v4/objects/contacts/" + contactId + "/associations/meetings").catch(function(e) {
        console.log("[EZAP BG] Contact->meetings assoc error:", e.message);
        return { results: [] };
      })
    );

    const assocResults = await Promise.all(assocPromises);

    // Deduplicate meeting IDs
    const seen = {};
    const meetingIds = [];
    assocResults.forEach(function(assoc) {
      (assoc.results || []).forEach(function(a) {
        if (!seen[a.toObjectId]) { seen[a.toObjectId] = true; meetingIds.push(a.toObjectId); }
      });
    });

    if (meetingIds.length === 0) return { meetings: [] };

    // Batch read all meetings in a single API call (max 20)
    const batchResult = await hubFetch("/crm/v3/objects/meetings/batch/read", {
      method: "POST",
      body: JSON.stringify({
        inputs: meetingIds.slice(0, 20).map(function(id) { return { id: id }; }),
        properties: MEETING_PROPS,
      }),
    });

    var meetings = batchResult.results || [];

    // Sort by start time descending (most recent first)
    meetings.sort(function(a, b) {
      var da = a.properties.hs_meeting_start_time || a.properties.hs_timestamp || "";
      var db = b.properties.hs_meeting_start_time || b.properties.hs_timestamp || "";
      return db.localeCompare(da);
    });

    const result = { meetings: meetings };
    hsCacheSet(cacheKey, result);
    return result;
  } catch (e) {
    return { meetings: [], error: e.message };
  }
}

// ===== Ticket properties list (reusable) =====
const TICKET_PROPS = "subject,hs_pipeline,hs_pipeline_stage,hs_ticket_priority,createdate," +
  "nm__total_de_calls_adquiridas__starter__pro__business_,nm__calls_restantes," +
  "nova_mentoria__calls_meli_realizadas,nova_mentoria__total_de_calls_especificas_realizadas," +
  "data_de_inicio_dos_blocos,data_de_termino_do_2o_bloco,data_de_termino_do_1o_bloco," +
  "modelo_de_mentoria,cust_id_unico,nickname,contrato__e_mail";

// ===== Filter: only tickets from mentoria pipeline =====
// Mentoria tickets always have "Cliente | Consultor" format in the subject
function isMentoriaPipeline(ticket) {
  const subject = ticket.properties.subject || "";
  const hasConsultor = subject.includes("|");
  const pName = (ticket.properties._pipelineName || "").toLowerCase();
  return hasConsultor && pName.includes("mentoria");
}

// ===== Remove accents for comparison =====
function removeAccents(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// ===== Search Tickets by Name (subject) =====
async function searchTicketsByName(chatName) {
  try {
    // Check cache
    const cacheKey = "ticketSearch_" + chatName;
    const cached = hsCacheGet(cacheKey);
    if (cached) return cached;

    await loadStageCache();

    // Split "Bruno Siviero Franqui| Thiago Rocha" -> ["Bruno Siviero Franqui", "Thiago Rocha"]
    const names = chatName.split(/\s*\|\s*/);
    // Use the FIRST name part (the client name, not the mentor)
    const clientName = (names[0] || "").trim();
    if (!clientName) return { tickets: [] };

    // Get significant words (length >= 3, skip common prepositions)
    const skipWords = ["de", "da", "do", "dos", "das", "para", "com", "sem", "por"];
    const words = clientName.split(/\s+/).filter(function(w) {
      return w.length >= 3 && skipWords.indexOf(w.toLowerCase()) === -1;
    });
    if (words.length === 0) return { tickets: [] };

    const seen = {};
    let allResults = [];

    // Remove accents from search words (HubSpot may store without accents)
    const cleanWords = words.map(function(w) { return removeAccents(w); });
    console.log("[WCRM BG] Ticket search words:", cleanWords);

    // Strategy 1: Search with ALL significant words together (most precise)
    if (cleanWords.length >= 2) {
      try {
        const filters = cleanWords.map(function(w) {
          return { propertyName: "subject", operator: "CONTAINS_TOKEN", value: w };
        });
        const data = await hubFetch("/crm/v3/objects/tickets/search", {
          method: "POST",
          body: JSON.stringify({
            filterGroups: [{ filters: filters }],
            properties: TICKET_PROPS.split(","),
            limit: 10,
          }),
        });
        if (data.results) {
          data.results.forEach(function(t) {
            if (!seen[t.id]) { seen[t.id] = true; allResults.push(t); }
          });
        }
        console.log("[WCRM BG] Strategy 1 (all words) found:", allResults.length);
      } catch (e) {
        console.log("[WCRM BG] Ticket search strategy 1 error:", e.message);
      }
    }

    // Strategy 2 (fallback): Search with first + last word
    if (allResults.length === 0 && cleanWords.length >= 2) {
      try {
        const data = await hubFetch("/crm/v3/objects/tickets/search", {
          method: "POST",
          body: JSON.stringify({
            filterGroups: [
              { filters: [
                { propertyName: "subject", operator: "CONTAINS_TOKEN", value: cleanWords[0] },
                { propertyName: "subject", operator: "CONTAINS_TOKEN", value: cleanWords[cleanWords.length - 1] },
              ]},
            ],
            properties: TICKET_PROPS.split(","),
            limit: 10,
          }),
        });
        if (data.results) {
          data.results.forEach(function(t) {
            if (!seen[t.id]) { seen[t.id] = true; allResults.push(t); }
          });
        }
        console.log("[WCRM BG] Strategy 2 (first+last) found:", allResults.length);
      } catch (e) {
        console.log("[WCRM BG] Ticket search strategy 2 error:", e.message);
      }
    }

    // Strategy 3 (last resort): Search by last word only
    if (allResults.length === 0) {
      const searchWord = cleanWords.length > 1 ? cleanWords[cleanWords.length - 1] : cleanWords[0];
      try {
        const data = await hubFetch("/crm/v3/objects/tickets/search", {
          method: "POST",
          body: JSON.stringify({
            filterGroups: [
              { filters: [{ propertyName: "subject", operator: "CONTAINS_TOKEN", value: searchWord }] },
            ],
            properties: TICKET_PROPS.split(","),
            limit: 10,
          }),
        });
        if (data.results) {
          data.results.forEach(function(t) {
            if (!seen[t.id]) { seen[t.id] = true; allResults.push(t); }
          });
        }
        console.log("[WCRM BG] Strategy 3 (last word) found:", allResults.length);
      } catch (e) {
        console.log("[WCRM BG] Ticket search strategy 3 error:", e.message);
      }
    }

    // Strict filter with accent normalization:
    // Match against the CLIENT NAME part only (before "|"), not the full subject
    // This prevents "Matheus Soares" matching "Thiago José Soares | Matheus Carrieiro"
    const nameLower = cleanWords.map(function(w) { return w.toLowerCase(); });

    const matched = allResults.filter(function(t) {
      const subject = removeAccents((t.properties.subject || "").toLowerCase());
      // Extract client name (first part before "|")
      const clientPart = subject.split(/\s*\|\s*/)[0].trim();
      // ALL search words must appear in the CLIENT name part
      var matchCount = 0;
      nameLower.forEach(function(part) {
        if (clientPart.includes(part)) matchCount++;
      });
      return matchCount >= nameLower.length;
    });

    // Add stage info
    matched.forEach(function(ticket) {
      const stageInfo = getStageName("ticket", ticket.properties.hs_pipeline_stage);
      ticket.properties._stageName = stageInfo.label;
      ticket.properties._pipelineName = stageInfo.pipeline;
    });

    // Only keep mentoria pipeline tickets
    const result = { tickets: matched.filter(isMentoriaPipeline).slice(0, 5) };
    hsCacheSet(cacheKey, result);
    return result;
  } catch (e) {
    return { tickets: [], error: e.message };
  }
}

// ===== Tickets by Contact (Batch API) =====
async function getHubSpotTickets(contactId) {
  try {
    // Check cache
    const cacheKey = "tickets_" + contactId;
    const cached = hsCacheGet(cacheKey);
    if (cached) return cached;

    await loadStageCache();

    const assocData = await hubFetch("/crm/v4/objects/contacts/" + contactId + "/associations/tickets");
    if (!assocData.results || assocData.results.length === 0) return { tickets: [] };

    const ticketIds = assocData.results.map(function(a) { return a.toObjectId; }).slice(0, 5);

    // Batch read all tickets in a single API call
    const batchResult = await hubFetch("/crm/v3/objects/tickets/batch/read", {
      method: "POST",
      body: JSON.stringify({
        inputs: ticketIds.map(function(id) { return { id: id }; }),
        properties: TICKET_PROPS.split(","),
      }),
    });

    var tickets = (batchResult.results || []).map(function(ticket) {
      const stageInfo = getStageName("ticket", ticket.properties.hs_pipeline_stage);
      ticket.properties._stageName = stageInfo.label;
      ticket.properties._pipelineName = stageInfo.pipeline;
      return ticket;
    });

    // Only keep mentoria pipeline tickets
    const result = { tickets: tickets.filter(isMentoriaPipeline) };
    hsCacheSet(cacheKey, result);
    return result;
  } catch (e) {
    return { tickets: [], error: e.message };
  }
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
