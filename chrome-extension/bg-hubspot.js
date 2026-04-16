// bg-hubspot.js — HubSpot cache, API key, rate limiter, contacts, deals, tickets, notes, meetings, owners

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
      // HubSpot key synced
    }
  } catch (e) {
    console.log("[EZAP BG] Could not sync HubSpot key:", e.message);
  }
}

// Rate limiter for HubSpot API (max 4 requests/second to avoid 429)
let _hubQueue = Promise.resolve();
let _hubLastCall = 0;
const HUB_MIN_INTERVAL = 260; // ms between calls (~4/sec)

async function hubFetch(path, options) {
  // Queue requests to avoid secondly rate limit
  const ticket = _hubQueue.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, HUB_MIN_INTERVAL - (now - _hubLastCall));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _hubLastCall = Date.now();
  });
  _hubQueue = ticket.catch(() => {});
  await ticket;

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
    // On rate limit, wait and retry once
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") || "1", 10);
      console.warn("[EZAP BG] HubSpot 429 on " + path + ", retrying in " + retryAfter + "s");
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      _hubLastCall = Date.now();
      const res2 = await fetch("https://api.hubapi.com" + path, {
        ...options,
        headers: {
          "Authorization": "Bearer " + apiKey,
          "Content-Type": "application/json",
          ...(options && options.headers),
        },
      });
      if (!res2.ok) {
        let errDetail = "";
        try { errDetail = await res2.text(); } catch (e) { /* ignore */ }
        console.error("[EZAP BG] HubSpot " + res2.status + " on " + path + " (retry):", errDetail);
        throw new Error("HubSpot HTTP " + res2.status);
      }
      return res2.json();
    }
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
        // Ticket->meetings assoc error (non-critical)
        return { results: [] };
      })
    );
    if (contactId) assocPromises.push(
      hubFetch("/crm/v4/objects/contacts/" + contactId + "/associations/meetings").catch(function(e) {
        // Contact->meetings assoc error (non-critical)
        return { results: [] };
      })
    );

    const assocResults = await Promise.all(assocPromises);

    // Debug: log raw association results
    console.log("[MEETINGS] Raw assoc results:", JSON.stringify(assocResults.map(function(a) { return (a.results || []).length; })));

    // Deduplicate meeting IDs (v4 API may use toObjectId or to.id)
    const seen = {};
    const meetingIds = [];
    assocResults.forEach(function(assoc, idx) {
      (assoc.results || []).forEach(function(a) {
        var mid = a.toObjectId || (a.to && a.to.id) || null;
        console.log("[MEETINGS] Assoc[" + idx + "] entry:", JSON.stringify({ toObjectId: a.toObjectId, toId: a.to ? a.to.id : undefined, mid: mid }));
        if (mid && !seen[mid]) { seen[mid] = true; meetingIds.push(mid); }
      });
    });

    console.log("[MEETINGS] Unique meeting IDs:", JSON.stringify(meetingIds));

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
    console.log("[MEETINGS] Batch read returned " + meetings.length + " meetings, IDs:", meetings.map(function(m) { return m.id; }));

    // Deduplicate meetings by ID
    var seenMeetings = {};
    meetings = meetings.filter(function(m) {
      if (!m.id || seenMeetings[m.id]) return false;
      seenMeetings[m.id] = true;
      return true;
    });

    // Deduplicate by content (title + start time) as fallback — HubSpot may return
    // the same meeting with different IDs via ticket vs contact associations
    var seenContent = {};
    meetings = meetings.filter(function(m) {
      var key = (m.properties.hs_meeting_title || "") + "|" + (m.properties.hs_meeting_start_time || "");
      if (seenContent[key]) {
        console.log("[MEETINGS] Content-dedup removed duplicate:", m.id, key);
        return false;
      }
      seenContent[key] = true;
      return true;
    });

    console.log("[MEETINGS] After dedup: " + meetings.length + " meetings");

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
const TICKET_PROPS = "subject,hs_pipeline,hs_pipeline_stage,hs_ticket_priority,createdate,closedate," +
  "hubspot_owner_id," +
  "nm__total_de_calls_adquiridas__starter__pro__business_,nm__calls_restantes," +
  "nova_mentoria__calls_meli_realizadas,nova_mentoria__total_de_calls_especificas_realizadas," +
  "data_de_inicio_dos_blocos,data_de_termino_do_2o_bloco,data_de_termino_do_1o_bloco," +
  "modelo_de_mentoria,cust_id_unico,nickname,contrato__e_mail";

// ===== Owner cache: resolve hubspot_owner_id -> name =====
var _ownerCache = {};
async function resolveOwnerName(ownerId) {
  if (!ownerId) return "";
  if (_ownerCache[ownerId]) return _ownerCache[ownerId];
  try {
    const data = await hubFetch("/crm/v3/owners/" + ownerId);
    var name = [data.firstName, data.lastName].filter(Boolean).join(" ") || data.email || "";
    _ownerCache[ownerId] = name;
    return name;
  } catch (e) {
    console.log("[WCRM BG] Failed to resolve owner " + ownerId + ":", e.message);
    return "";
  }
}

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

    // Add stage info + resolve owner
    for (var mi = 0; mi < matched.length; mi++) {
      const ticket = matched[mi];
      const stageInfo = getStageName("ticket", ticket.properties.hs_pipeline_stage);
      ticket.properties._stageName = stageInfo.label;
      ticket.properties._pipelineName = stageInfo.pipeline;
      if (ticket.properties.hubspot_owner_id) {
        ticket.properties._ownerName = await resolveOwnerName(ticket.properties.hubspot_owner_id);
      }
    }

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

    var tickets = batchResult.results || [];
    for (var ti = 0; ti < tickets.length; ti++) {
      const ticket = tickets[ti];
      const stageInfo = getStageName("ticket", ticket.properties.hs_pipeline_stage);
      ticket.properties._stageName = stageInfo.label;
      ticket.properties._pipelineName = stageInfo.pipeline;
      if (ticket.properties.hubspot_owner_id) {
        ticket.properties._ownerName = await resolveOwnerName(ticket.properties.hubspot_owner_id);
      }
    }

    // Only keep mentoria pipeline tickets
    const result = { tickets: tickets.filter(isMentoriaPipeline) };
    hsCacheSet(cacheKey, result);
    return result;
  } catch (e) {
    return { tickets: [], error: e.message };
  }
}
