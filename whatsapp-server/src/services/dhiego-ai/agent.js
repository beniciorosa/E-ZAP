// ===== DHIEGO.AI — LLM-first agentic orchestrator =====
// Replaces the old routeIntent → dispatch switch with a Claude tool-use loop.
// Claude owns the conversation and decides (per turn) whether to:
//   - respond directly in text (end_turn)
//   - call one or more tools (tool_use)
// We iterate until end_turn or a hard iteration cap (6).
//
// This is the core of Round 1 of the LLM-first migration. The legacy path
// (routeIntent + dispatch in dhiego-ai.js) is preserved and only invoked when
// app_settings.dhiego_ai_mode === "router".

const { complete, extractText } = require("./llm");
const { buildSystemPrompt } = require("./prompt-builder");
const {
  ALL_TOOLS,
  TOOL_DISPATCH,
  mapToolNameToLegacyIntent,
  toolInputToLegacyArgs,
} = require("./tool-schemas");

const MAX_ITERATIONS = 6;
const MAX_TOKENS_PER_CALL = 2048;
const TOOL_RESULT_MAX_CHARS = 4000;

// Serializes a tool handler result back to the model. We strip potentially
// huge fields (document buffers, full data rows) and hard-cap the length so a
// single blob can't blow the context window.
function serializeToolResult(result) {
  if (!result || typeof result !== "object") return String(result || "");
  const lean = {
    ok: !!result.ok,
    reply: typeof result.reply === "string" ? result.reply.slice(0, 2000) : undefined,
  };
  if (result.data !== undefined) {
    try {
      const clone = Array.isArray(result.data)
        ? result.data.slice(0, 20)
        : result.data;
      lean.data = clone;
    } catch (_) { /* ignore */ }
  }
  if (result.document) {
    lean.document = {
      filename: result.document.filename,
      mimetype: result.document.mimetype || "application/pdf",
      note: "document sent as attachment to the user",
    };
  }
  let json;
  try {
    json = JSON.stringify(lean);
  } catch (_) {
    json = JSON.stringify({ ok: lean.ok, reply: lean.reply || "(non-serializable result)" });
  }
  return json.slice(0, TOOL_RESULT_MAX_CHARS);
}

// If Claude called update_idea with preserve_literal=true but truncated or
// normalized the text, fall back to the original user message. This is the
// Phase 5 safeguard: prompt alone isn't always enough for byte-level fidelity.
function applyLiteralSafeguard(toolName, input, lastUserText) {
  if (toolName !== "update_idea") return input;
  if (!input || !input.preserve_literal) return input;
  if (!lastUserText || typeof lastUserText !== "string") return input;

  const modelText = String(input.text || "");
  const userText = lastUserText;

  // Heuristic: if the user sent a multi-line block > 100 chars and the model's
  // version is shorter or missing newlines, prefer the user's original text.
  const userHasBlock = userText.length > 100 && userText.includes("\n");
  if (!userHasBlock) return input;

  const modelLen = modelText.length;
  const userLen = userText.length;
  const modelHasNewlines = modelText.includes("\n");

  if (modelLen < userLen * 0.9 || !modelHasNewlines) {
    return Object.assign({}, input, { text: userText });
  }
  return input;
}

async function runAgent({
  ctx,
  userText,
  history = [],
  state = null,
  rules = [],
  facts = [],
  suggestedHint = null,
  basePrompt = "",
} = {}) {
  const toolCalls = [];
  let lastDoc = null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastModel = null;
  let lastStopReason = null;

  const systemPrompt = buildSystemPrompt({
    basePrompt,
    state,
    rules,
    facts,
    suggestedHint,
  });

  const messages = [];
  for (const entry of history) {
    if (!entry || !entry.role || !entry.content) continue;
    // Legacy rows store `content` as string. That's fine for Claude.
    messages.push({ role: entry.role, content: String(entry.content) });
  }
  messages.push({ role: "user", content: String(userText || "") });

  for (let iter = 0; iter < MAX_ITERATIONS; iter += 1) {
    let resp;
    try {
      resp = await complete({
        system: systemPrompt,
        messages,
        tools: ALL_TOOLS,
        maxTokens: MAX_TOKENS_PER_CALL,
      });
    } catch (e) {
      console.error("[DHIEGO.AI agent] Claude call failed:", e.message);
      return {
        ok: false,
        reply: "⚠️ Erro ao falar com o Claude: " + e.message,
        document: lastDoc,
        toolCalls,
        usage: { input: totalInputTokens, output: totalOutputTokens },
        stopReason: "error",
        model: lastModel,
      };
    }

    lastModel = resp.model;
    lastStopReason = resp.stopReason;
    if (resp.usage) {
      totalInputTokens += resp.usage.input_tokens || 0;
      totalOutputTokens += resp.usage.output_tokens || 0;
    }

    // End turn — Claude is done, return the final text.
    if (resp.stopReason !== "tool_use") {
      const replyText = extractText(resp.content);
      return {
        ok: true,
        reply: replyText || "(resposta vazia do modelo)",
        document: lastDoc,
        toolCalls,
        usage: { input: totalInputTokens, output: totalOutputTokens },
        stopReason: resp.stopReason,
        model: lastModel,
      };
    }

    // Claude asked for tool_use. Append the assistant turn (with all blocks)
    // to the conversation so the next turn has a valid pairing.
    messages.push({ role: "assistant", content: resp.content });

    // Execute every tool_use block, collect tool_result blocks.
    const toolResults = [];
    for (const block of resp.content || []) {
      if (!block || block.type !== "tool_use") continue;
      const handler = TOOL_DISPATCH[block.name];
      if (!handler) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          is_error: true,
          content: "Unknown tool: " + block.name,
        });
        continue;
      }
      const safeInput = applyLiteralSafeguard(block.name, block.input, ctx && ctx.lastUserText);
      let result;
      try {
        result = await handler(safeInput, ctx);
      } catch (e) {
        console.error("[DHIEGO.AI agent] tool error", block.name, e.message);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          is_error: true,
          content: "Tool error: " + e.message,
        });
        continue;
      }
      toolCalls.push({ name: block.name, input: safeInput, result });
      if (result && result.document) lastDoc = result.document;
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: serializeToolResult(result),
      });
    }

    if (!toolResults.length) {
      // Claude said tool_use but there were no executable blocks. Bail.
      return {
        ok: false,
        reply: "⚠️ Claude pediu tool_use mas não mandou blocos válidos.",
        document: lastDoc,
        toolCalls,
        usage: { input: totalInputTokens, output: totalOutputTokens },
        stopReason: resp.stopReason,
        model: lastModel,
      };
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Iteration cap hit.
  return {
    ok: false,
    reply: "⚠️ O assistente ficou em loop — tente reformular a mensagem.",
    document: lastDoc,
    toolCalls,
    usage: { input: totalInputTokens, output: totalOutputTokens },
    stopReason: lastStopReason || "max_iterations",
    model: lastModel,
  };
}

// Synthesizes a legacy `intent` object from the last tool call so that
// state.syncStateAfterTurn (state.js:174) keeps working unchanged. If no tools
// were called (plain conversation), returns llm-freeform.
function synthesizeIntentForState(result) {
  const last = result && result.toolCalls && result.toolCalls[result.toolCalls.length - 1];
  if (!last) return { tool: "llm-freeform", args: {} };
  return {
    tool: mapToolNameToLegacyIntent(last.name),
    args: toolInputToLegacyArgs(last.name, last.input),
  };
}

module.exports = {
  runAgent,
  synthesizeIntentForState,
  MAX_ITERATIONS,
};
