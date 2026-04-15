// ===== DHIEGO.AI — Freeform LLM tool =====
// Fallback when the router doesn't match a specific tool. Loads recent
// conversation history + the admin-editable system prompt, sends everything
// to Claude, and returns the reply as text.

const { complete } = require("../llm");
const { loadConfig } = require("../config");
const { loadRecentTurns } = require("../history");

const DEFAULT_SYSTEM_PROMPT = `Você é o DHIEGO.AI, um assistente pessoal do Dhiego rodando dentro do WhatsApp dele.
Responda de forma direta, curta e útil — como se fosse uma conversa no WhatsApp.
Use no máximo 3-4 parágrafos e prefira listas curtas quando fizer sentido.
NUNCA invente dados pessoais, contas ou números que você não tenha. Se não souber, diz que não sabe.
Idioma: português brasileiro.`;

async function answerFreeform({ text, ctx }) {
  if (!text || !text.trim()) {
    return { ok: false, reply: "❌ Preciso de uma pergunta ou comando." };
  }

  try {
    const cfg = await loadConfig();
    const systemPrompt = (cfg.systemPrompt && cfg.systemPrompt.trim())
      || DEFAULT_SYSTEM_PROMPT;

    // Reuse the router history when available so we do not duplicate the
    // current user turn after dhiego-ai.js persists it with the detected
    // intent. Fall back to DB only when the preloaded history is absent.
    const rawHistory = ctx && Array.isArray(ctx.prefetchedHistory)
      ? ctx.prefetchedHistory
      : ctx ? await loadRecentTurns(ctx) : [];
    const history = rawHistory.map(entry => ({
      role: entry.role,
      content: entry.content,
    })).filter(entry => entry.role && entry.content);
    const state = ctx && ctx.activeState;
    const stateSummary = state ? [
      "Contexto ativo do assistente:",
      "- tarefa: " + (state.activeTask || "nenhuma"),
      "- tool: " + (state.activeTool || "nenhuma"),
      "- ideia em foco: " + (state.focusIdeaId || "nenhuma"),
      "- payload: " + JSON.stringify(state.payload || {}),
    ].join("\n") : "";
    const messages = [
      ...history,
      ...(stateSummary ? [{ role: "assistant", content: stateSummary }] : []),
      { role: "user", content: text.trim() },
    ];

    const resp = await complete({
      system: systemPrompt,
      messages,
      maxTokens: 1024,
    });
    return {
      ok: true,
      reply: resp.text || "(resposta vazia do modelo)",
      meta: { model: resp.model, usage: resp.usage, historyLen: history.length },
    };
  } catch (e) {
    console.error("[DHIEGO.AI] llm-freeform error:", e.message);
    return { ok: false, reply: "⚠️ Erro no LLM: " + e.message };
  }
}

module.exports = { answerFreeform };
