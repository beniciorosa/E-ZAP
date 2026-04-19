// ===== DHIEGO.AI — Config loader =====
// Reads runtime config from app_settings (key/value store in Supabase).
//
// All config lives in app_settings so the admin can toggle/change via
// admin.html without redeploying. We cache for 30s to avoid hitting Supabase
// on every incoming message.

const { supaRest } = require("../supabase");

const CACHE_TTL_MS = 30 * 1000;
let _cache = null;
let _cachedAt = 0;

const KEYS = [
  "dhiego_ai_enabled",
  "dhiego_ai_session_id",
  "dhiego_ai_authorized_phones",
  "dhiego_ai_llm_model",
  "dhiego_ai_system_prompt",
  "dhiego_ai_mode",
  "claude_api_key",
  "openai_api_key",
];

async function loadConfig(force = false) {
  const now = Date.now();
  if (!force && _cache && now - _cachedAt < CACHE_TTL_MS) return _cache;

  const keysEsc = KEYS.map(k => `"${k}"`).join(",");
  const rows = await supaRest(
    "/rest/v1/app_settings?key=in.(" + encodeURIComponent(keysEsc) + ")&select=key,value"
  ).catch(e => {
    console.error("[DHIEGO.AI] config load failed:", e.message);
    return [];
  });

  const bag = {};
  for (const r of (rows || [])) bag[r.key] = r.value;

  let authorizedPhones = [];
  try {
    authorizedPhones = JSON.parse(bag.dhiego_ai_authorized_phones || "[]");
    if (!Array.isArray(authorizedPhones)) authorizedPhones = [];
  } catch (_) { authorizedPhones = []; }

  const rawMode = (bag.dhiego_ai_mode || "").trim().toLowerCase();
  const mode = rawMode === "router" ? "router" : "agent";

  _cache = {
    enabled: bag.dhiego_ai_enabled === "true",
    sessionId: bag.dhiego_ai_session_id || "",
    authorizedPhones: authorizedPhones.map(p => String(p).replace(/\D/g, "")),
    llmModel: bag.dhiego_ai_llm_model || "claude-haiku-4-5-20251001",
    systemPrompt: bag.dhiego_ai_system_prompt || "",
    mode,
    claudeApiKey: bag.claude_api_key || "",
    openaiApiKey: bag.openai_api_key || "",
  };
  _cachedAt = now;
  return _cache;
}

function invalidateCache() {
  _cache = null;
  _cachedAt = 0;
}

module.exports = { loadConfig, invalidateCache };
