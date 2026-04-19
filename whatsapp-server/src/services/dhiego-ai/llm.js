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

// Single-turn Claude call. Returns { text, content, stopReason, usage, model }.
// When `tools` is passed, Claude can respond with tool_use blocks — the caller
// must inspect `content` and `stopReason` to drive an agentic loop.
// When `tools` is absent the return shape stays backwards compatible with the
// legacy callers (router.classifyWithLlm, llm-freeform.answerFreeform) which
// only read `.text`.
async function complete({
  system,
  messages,
  maxTokens = 1024,
  model: modelOverride,
  tools,
  toolChoice,
}) {
  const cfg = await loadConfig();
  if (!cfg.claudeApiKey) {
    throw new Error("claude_api_key não configurado em app_settings");
  }
  const client = getClient(cfg.claudeApiKey);
  const model = modelOverride || cfg.llmModel || "claude-haiku-4-5-20251001";

  const request = {
    model,
    max_tokens: maxTokens,
    system: system || undefined,
    messages: messages || [],
  };
  if (Array.isArray(tools) && tools.length) {
    request.tools = tools;
    if (toolChoice) request.tool_choice = toolChoice;
  }

  const resp = await client.messages.create(request);

  return {
    text: extractText(resp.content),
    content: resp.content || [],
    stopReason: resp.stop_reason || null,
    usage: resp.usage || null,
    model,
  };
}

// Concatenates every text block in a Claude content array, preserving newlines.
// Helper exported so agent.js can pull the final assistant text after the
// tool_use loop ends.
function extractText(content) {
  return (content || [])
    .filter(block => block && block.type === "text")
    .map(block => block.text)
    .join("\n");
}

module.exports = { complete, extractText };
