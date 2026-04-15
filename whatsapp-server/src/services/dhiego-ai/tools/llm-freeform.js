// ===== DHIEGO.AI — Freeform LLM tool =====
// Fallback when the router doesn't match a specific tool. Sends the user's
// message to Claude with a short system prompt and returns the reply as text.
//
// Kept intentionally simple — no conversation history yet (Phase 4 idea).
// Each invocation is stateless.

const { complete } = require("../llm");

const SYSTEM_PROMPT = `Você é o DHIEGO.AI, um assistente pessoal do Dhiego rodando dentro do WhatsApp dele.
Responda de forma direta, curta e útil — como se fosse uma conversa no WhatsApp.
Use no máximo 3-4 parágrafos e prefira listas curtas quando fizer sentido.
NUNCA invente dados pessoais, contas ou números que você não tenha. Se não souber, diz que não sabe.
Idioma: português brasileiro.`;

async function answerFreeform({ text }) {
  if (!text || !text.trim()) {
    return { ok: false, reply: "❌ Preciso de uma pergunta ou comando." };
  }

  try {
    const resp = await complete({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text.trim() }],
      maxTokens: 1024,
    });
    return {
      ok: true,
      reply: resp.text || "(resposta vazia do modelo)",
      meta: { model: resp.model, usage: resp.usage },
    };
  } catch (e) {
    console.error("[DHIEGO.AI] llm-freeform error:", e.message);
    return { ok: false, reply: "⚠️ Erro no LLM: " + e.message };
  }
}

module.exports = { answerFreeform };
