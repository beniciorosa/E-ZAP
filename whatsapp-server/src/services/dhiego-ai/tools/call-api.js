// ===== DHIEGO.AI — Generic external API tool =====
// Allows Claude to call any pre-registered external service (HubSpot, Supabase,
// Google Calendar, etc.) via authenticated HTTP requests.
//
// The service registry maps service names to their base URL and auth config.
// API keys are read from app_settings at call time (via config.js cache).
// Claude already knows these APIs from training — it figures out the right
// endpoints and parameters on its own.
//
// Safety:
//   - Only pre-registered services can be called (no arbitrary URLs)
//   - Response bodies are truncated to 6000 chars to fit context windows
//   - Timeouts of 15s prevent hanging

const axios = require("axios");
const { loadConfig } = require("../config");
const { getAccessToken, listAuthorizedEmails } = require("./google-auth");

// ── Service registry ───────────────────────────────────────────────────────
// Each entry maps a service name to:
//   baseUrl      — root URL (no trailing slash)
//   authBuilder  — async fn(cfg) → headers object with auth
//   description  — short text for error messages
//
// API keys come from app_settings (loaded via config.js with 30s cache).
// To add a new service, just add an entry here + store its key in app_settings.

const SERVICE_REGISTRY = {
  hubspot: {
    baseUrl: "https://api.hubapi.com",
    description: "HubSpot CRM (deals, contacts, companies, products, pipelines)",
    async authBuilder(cfg) {
      const key = cfg._raw && cfg._raw.hubspot_api_key;
      if (!key) throw new Error("hubspot_api_key não configurado em app_settings");
      return { Authorization: "Bearer " + key };
    },
  },
  supabase: {
    baseUrl: null, // read from cfg
    description: "Supabase Postgres REST (tables, views, RPC)",
    async authBuilder(cfg) {
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_KEY;
      if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY não encontrados no env");
      this.baseUrl = url;
      return {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      };
    },
  },
  google_calendar: {
    baseUrl: "https://www.googleapis.com/calendar/v3",
    description:
      "Google Calendar API v3. Requer query_params.as_user='email@grupoescalada.com.br' para impersonar a conta. " +
      "Endpoints: /calendars/primary/events (list events), /calendars/{calendarId}/events (CRUD), /users/me/calendarList.",
    requiresImpersonation: true,
    async authBuilder(cfg, impersonateEmail) {
      if (!impersonateEmail) {
        throw new Error("google_calendar requer query_params.as_user='email@grupoescalada.com.br'");
      }
      const token = await getAccessToken(impersonateEmail);
      return { Authorization: "Bearer " + token };
    },
  },
  gmail: {
    baseUrl: "https://gmail.googleapis.com/gmail/v1",
    description:
      "Gmail API v1. Requer query_params.as_user='email@grupoescalada.com.br'. " +
      "Endpoints: /users/me/messages (list/search), /users/me/messages/{id} (read), /users/me/threads.",
    requiresImpersonation: true,
    async authBuilder(cfg, impersonateEmail) {
      if (!impersonateEmail) {
        throw new Error("gmail requer query_params.as_user='email@grupoescalada.com.br'");
      }
      const token = await getAccessToken(impersonateEmail);
      return { Authorization: "Bearer " + token };
    },
  },
};

// ── Config loader (extended) ───────────────────────────────────────────────
// loadConfig() returns a parsed cache. For the API tool we also need raw
// key/value access to read arbitrary service keys (hubspot_api_key, etc.).
// We piggyback on the existing loadConfig by doing a secondary fetch for
// keys not in the standard set.

const { supaRest } = require("../../supabase");

let _apiKeysCache = null;
let _apiKeysCachedAt = 0;
const API_KEYS_TTL = 30_000;

async function loadApiKeys() {
  const now = Date.now();
  if (_apiKeysCache && now - _apiKeysCachedAt < API_KEYS_TTL) return _apiKeysCache;
  try {
    const rows = await supaRest(
      '/rest/v1/app_settings?key=in.("hubspot_api_key","google_api_key","gmail_api_key")&select=key,value'
    );
    const bag = {};
    for (const r of (rows || [])) bag[r.key] = r.value;
    _apiKeysCache = bag;
    _apiKeysCachedAt = now;
    return bag;
  } catch (e) {
    console.error("[DHIEGO.AI call-api] loadApiKeys failed:", e.message);
    return _apiKeysCache || {};
  }
}

// ── Main handler ───────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_CHARS = 6000;

async function callApi({ service, method, path, query_params, body } = {}) {
  // 1. Validate service
  const svcName = String(service || "").toLowerCase().trim();
  const svc = SERVICE_REGISTRY[svcName];
  if (!svc) {
    const available = Object.keys(SERVICE_REGISTRY).join(", ");
    return {
      ok: false,
      reply: "Serviço '" + svcName + "' não está registrado. Disponíveis: " + available,
    };
  }

  // 2. Extract impersonation hint (for Google services) before building auth.
  // `as_user` in query_params tells which email to impersonate. Strip it out
  // before forwarding to the upstream API — Google APIs don't know this param.
  let impersonateEmail = null;
  let cleanedQueryParams = query_params;
  if (svc.requiresImpersonation && query_params && typeof query_params === "object") {
    impersonateEmail = query_params.as_user || null;
    if (impersonateEmail) {
      cleanedQueryParams = Object.assign({}, query_params);
      delete cleanedQueryParams.as_user;
    }
  }

  // 3. Build auth headers
  const apiKeys = await loadApiKeys();
  const cfgProxy = { _raw: apiKeys };
  let authHeaders;
  try {
    authHeaders = await svc.authBuilder.call(svc, cfgProxy, impersonateEmail);
  } catch (e) {
    return { ok: false, reply: "❌ Erro de autenticação para " + svcName + ": " + e.message };
  }

  // 4. Build request
  const httpMethod = String(method || "GET").toUpperCase();
  const baseUrl = svc.baseUrl || "";
  const cleanPath = String(path || "").startsWith("/") ? path : "/" + path;
  const url = baseUrl + cleanPath;

  const axiosConfig = {
    method: httpMethod,
    url,
    headers: Object.assign({ "Content-Type": "application/json" }, authHeaders),
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: () => true, // never throw on HTTP status
  };

  if (cleanedQueryParams && typeof cleanedQueryParams === "object") {
    axiosConfig.params = cleanedQueryParams;
  }
  if (body && (httpMethod === "POST" || httpMethod === "PUT" || httpMethod === "PATCH")) {
    axiosConfig.data = body;
  }

  // 4. Execute
  console.log("[DHIEGO.AI call-api]", httpMethod, url, JSON.stringify(query_params || {}).slice(0, 200));
  let resp;
  try {
    resp = await axios(axiosConfig);
  } catch (e) {
    console.error("[DHIEGO.AI call-api] request failed:", e.message);
    return { ok: false, reply: "❌ Erro na request para " + svcName + ": " + e.message };
  }

  // 5. Format response
  const status = resp.status;
  let data = resp.data;

  // Truncate large responses
  let dataStr;
  try {
    dataStr = typeof data === "string" ? data : JSON.stringify(data, null, 0);
  } catch (_) {
    dataStr = String(data);
  }
  if (dataStr.length > MAX_RESPONSE_CHARS) {
    dataStr = dataStr.slice(0, MAX_RESPONSE_CHARS) + "\n...(truncado, " + dataStr.length + " chars total)";
  }

  const isOk = status >= 200 && status < 300;
  console.log("[DHIEGO.AI call-api] response:", status, dataStr.slice(0, 120));

  return {
    ok: isOk,
    reply: isOk
      ? "✅ " + svcName + " " + httpMethod + " " + cleanPath + " → " + status
      : "⚠️ " + svcName + " retornou " + status,
    data: {
      status,
      body: dataStr,
      service: svcName,
      method: httpMethod,
      path: cleanPath,
    },
  };
}

// List of services for prompt injection
function getAvailableServicesDescription() {
  return Object.entries(SERVICE_REGISTRY).map(([name, svc]) => {
    return "- " + name + ": " + svc.description;
  }).join("\n");
}

module.exports = { callApi, getAvailableServicesDescription, SERVICE_REGISTRY };
