// ===== DHIEGO.AI — Intent router =====
// Converts the raw user text into a structured { tool, args } decision.
//
// Two-layer strategy for cost + latency:
//   1. Fast regex path — catches obvious prefixes like "nova ideia:", "listar
//      ideias", "completei X", "gera PDF" without hitting the LLM. Saves
//      tokens on the common commands.
//   2. Claude classifier fallback — for anything the regex doesn't match,
//      ask Claude to pick one of the tools OR decide it's a freeform query.
//
// Tools recognized in Phase 1:
//   - ideas-add       { text }
//   - ideas-list      { status: "open" | "done" | "all" }
//   - ideas-complete  { ideaId }
//   - ideas-cancel    { ideaId }
//   - ideas-pdf       { status?: string }
//   - llm-freeform    {} — fallback

const { complete } = require("./llm");

// ===== Layer 1: regex fast-path =====

function tryRegexRoute(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const lower = t.toLowerCase();

  // ideas-add: "nova ideia: X" / "ideia: X" / "anotar: X" / "add idea: X"
  const addMatch = t.match(/^(?:nova\s+ideia|ideia|anotar|add\s+idea)\s*[:\-]\s*(.+)$/i);
  if (addMatch && addMatch[1]) {
    return { tool: "ideas-add", args: { text: addMatch[1].trim() } };
  }

  // ideas-complete: "completei (a )?ideia N" / "ideia N feita" / "marcar ideia N como feita/done/concluida"
  const completeMatch = t.match(/^(?:completei|conclui|terminei|marcar|marca)\s+(?:a\s+)?ideia\s+#?(\d+)(?:\s+(?:como\s+)?(?:feita|done|conclu[ií]da|pronta))?$/i)
    || t.match(/^ideia\s+#?(\d+)\s+(?:feita|done|conclu[ií]da|pronta)$/i);
  if (completeMatch && completeMatch[1]) {
    return { tool: "ideas-complete", args: { ideaId: completeMatch[1] } };
  }

  // ideas-cancel: "cancelar ideia N" / "deletar ideia N"
  const cancelMatch = t.match(/^(?:cancelar|cancela|deletar|deleta|remover|remove|apagar)\s+(?:a\s+)?ideia\s+#?(\d+)$/i);
  if (cancelMatch && cancelMatch[1]) {
    return { tool: "ideas-cancel", args: { ideaId: cancelMatch[1] } };
  }

  // ideas-pdf: "gera(r) (o )?PDF (das|de) ideias", "pdf das ideias", "relatorio de ideias"
  if (/^(?:gera|gerar|gere|cria|criar)\s+(?:o\s+)?pdf/i.test(t)
      || /\bpdf\s+(?:das?|de)\s+ideias?\b/i.test(t)
      || /^relat[óo]rio\s+(?:das?|de)\s+ideias?/i.test(t)) {
    const statusMatch = t.match(/\b(abertas?|conclu[ií]das?|canceladas?|todas?)\b/i);
    let status = "all";
    if (statusMatch) {
      const s = statusMatch[1].toLowerCase();
      if (s.startsWith("abert")) status = "open";
      else if (s.startsWith("conclu")) status = "done";
      else if (s.startsWith("cancel")) status = "cancelled";
    }
    return { tool: "ideas-pdf", args: { status } };
  }

  // ideas-list: "listar ideias", "minhas ideias", "ideias abertas"
  if (/^(?:listar?|lista|mostrar?|mostra|ver|quais)\s+(?:as\s+|minhas\s+)?ideias?/i.test(t)
      || /^ideias?\s+(?:abertas?|conclu[ií]das?|todas?|pendentes)/i.test(t)
      || /^minhas\s+ideias?/i.test(t)) {
    const statusMatch = t.match(/\b(abertas?|conclu[ií]das?|todas?|pendentes)\b/i);
    let status = "open";
    if (statusMatch) {
      const s = statusMatch[1].toLowerCase();
      if (s.startsWith("conclu")) status = "done";
      else if (s.startsWith("tod")) status = "all";
    }
    return { tool: "ideas-list", args: { status } };
  }

  return null; // regex didn't match — fall through to LLM classifier
}

// ===== Layer 2: Claude classifier =====

const CLASSIFIER_SYSTEM = `Você é um classificador de intenções para o DHIEGO.AI (assistente pessoal via WhatsApp). Dado um texto do usuário, responda APENAS com um JSON no formato:

{"tool": "<nome>", "args": { ... }}

Tools válidas:
- "ideas-add" — args: {"text": "<texto da ideia>"}. Usar quando o usuário quer registrar uma nova ideia, tarefa, anotação, lembrete. Ex: "preciso lembrar de X", "vou fazer Y depois"
- "ideas-list" — args: {"status": "open"|"done"|"all"}. Usar quando pedem listar, mostrar, ver ideias.
- "ideas-complete" — args: {"ideaId": <n>}. Usar quando o usuário confirma que terminou uma ideia por número.
- "ideas-cancel" — args: {"ideaId": <n>}. Usar quando o usuário quer cancelar/deletar uma ideia por número.
- "ideas-pdf" — args: {"status": "open"|"done"|"cancelled"|"all"}. Usar quando pedem um PDF, relatório, documento das ideias.
- "llm-freeform" — args: {}. FALLBACK para perguntas gerais, pedidos de explicação, sugestões, cálculos, traduções, conversa livre, qualquer coisa que não seja gerenciamento de ideias.

REGRAS:
- Responda SÓ o JSON, sem markdown, sem explicação, sem \\\`\\\`\\\`json.
- Se estiver em dúvida entre uma tool de ideias e freeform, prefira freeform.
- Para ideas-complete e ideas-cancel, só use se o usuário disse o número claramente.`;

async function classifyWithLlm(text) {
  try {
    const resp = await complete({
      system: CLASSIFIER_SYSTEM,
      messages: [{ role: "user", content: text }],
      maxTokens: 200,
    });
    const raw = (resp.text || "").trim();
    // Strip accidental markdown fences
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed.tool === "string") {
      return { tool: parsed.tool, args: parsed.args || {} };
    }
  } catch (e) {
    console.error("[DHIEGO.AI] classifier parse error:", e.message);
  }
  // Last-resort fallback
  return { tool: "llm-freeform", args: {} };
}

// ===== Main entry =====

async function routeIntent(text) {
  const fast = tryRegexRoute(text);
  if (fast) {
    console.log("[DHIEGO.AI] routed via regex:", fast.tool);
    return fast;
  }
  const llm = await classifyWithLlm(text);
  console.log("[DHIEGO.AI] routed via Claude:", llm.tool);
  return llm;
}

module.exports = { routeIntent, tryRegexRoute };
