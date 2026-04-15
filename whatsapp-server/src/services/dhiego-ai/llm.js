// ===== DHIEGO.AI — LLM wrapper (Anthropic Claude) =====
// Thin wrapper around @anthropic-ai/sdk so the rest of the code can call
// one function and not care about SDK details. If we ever swap providers
// (OpenAI, Gemini, etc) it's one file to touch.
//
// Reads the API key and model from app_settings via config.js at call time
// so admin-panel changes take effect on the next cache refresh (30s).
//
// The Anthropic SDK is lazy-required inside getClient() so modules that
// merely import this file (e.g. router.js for regex fast-path tests) can
// still load on machines where the SDK isn't installed — it only blows up
// at the first actual LLM call.

const { loadConfig } = require("./config");

let _client = null;
let _clientKey = null;

function getClient(apiKey) {
  if (_client && _clientKey === apiKey) return _client;
  const Anthropic = require("@anthropic-ai/sdk");
  const Ctor = Anthropic.default || Anthropic.Anthropic || Anthropic;
  _client = new Ctor({ apiKey });
  _clientKey = apiKey;
  return _client;
}

// Single-turn completion. Returns { text, usage } or throws.
// system + messages follow the Anthropic Messages API shape.
async function complete({ system, messages, maxTokens = 1024, model: modelOverride }) {
  const cfg = await loadConfig();
  if (!cfg.claudeApiKey) {
    throw new Error("claude_api_key não configurado em app_settings");
  }
  const client = getClient(cfg.claudeApiKey);
  const model = modelOverride || cfg.llmModel || "claude-haiku-4-5-20251001";

  const resp = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: system || undefined,
    messages: messages || [],
  });

  const text = (resp.content || [])
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n");

  return {
    text,
    usage: resp.usage || null,
    model,
  };
}

module.exports = { complete };
