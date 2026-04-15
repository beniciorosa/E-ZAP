const { complete } = require("./llm");

// ===== DHIEGO.AI - Intent router =====
// Converts raw user text into a structured { tool, args } decision.
//
// Strategy:
//   1. Fast regex path for obvious commands.
//   2. Contextual follow-up resolver using recent history + persisted state.
//   3. LLM classifier fallback with the same context summary.

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function inferIdeaStatus(text, fallback = null) {
  const lower = normalizeText(text);
  if (!lower) return fallback;

  if (
    /nao\s+(?:mostre|inclua|quero|manda)\s+(?:a\s+)?cancelad/.test(lower)
    || /sem\s+cancelad/.test(lower)
    || /so\s+(?:as\s+)?abert/.test(lower)
    || /somente\s+(?:as\s+)?abert/.test(lower)
    || /apenas\s+(?:as\s+)?abert/.test(lower)
  ) {
    return "open";
  }

  if (/inclu(?:a|i)\s+(?:as\s+)?cancelad/.test(lower)) return "all";
  if (/\bcancelad/.test(lower)) return "cancelled";
  if (/\bconcluid/.test(lower) || /\bfeitas?\b/.test(lower)) return "done";
  if (/\babert/.test(lower) || /\bpendentes?\b/.test(lower)) return "open";
  if (/\btodas?\b/.test(lower)) return "all";
  return fallback;
}

function getLastAssistantIntent(history = []) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry && entry.role === "assistant" && entry.intent) return entry.intent;
  }
  return null;
}

function getRecentUserTexts(history = []) {
  return history
    .filter(entry => entry && entry.role === "user" && entry.content)
    .slice(-6)
    .map(entry => String(entry.content || ""));
}

function extractIdeaId(text) {
  const raw = String(text || "");
  const match = raw.match(/(?:ideia|#|numero|n)\s*#?(\d+)/i) || raw.match(/\b#(\d+)\b/);
  return match ? parseInt(match[1], 10) : null;
}

function extractUpdateText(text) {
  const raw = String(text || "");
  if (!raw.trim()) return "";

  const patterns = [
    /^(?:ok[.!?,\s]*)?(?:atualizar|atualiza|atualize|editar|edita|edite|alterar|altera|altere|trocar|troca|troque|substituir|substitui|substitua)(?:\s+(?:a|essa|ela|isso|a\s+ideia|essa\s+ideia))?(?:\s+(?:pra|para|por))?(?:\s+(?:essa|isso|essa\s+aqui|isso\s+aqui|aqui))?\s*(?::|-)\s*([\s\S]+)$/i,
    /^(?:ok[.!?,\s]*)?(?:atualizar|atualiza|atualize|editar|edita|edite|alterar|altera|altere|trocar|troca|troque|substituir|substitui|substitua)(?:\s+(?:isso|essa|ela|essa\s+ideia|a\s+ideia))?\s+(?:pra|para|por)\s*:?\s*([\s\S]+)$/i,
    /^(?:ok[.!?,\s]*)?(?:atualizar|atualiza|atualize|editar|edita|edite|alterar|altera|altere|trocar|troca|troque|substituir|substitui|substitua)(?:\s+(?:isso|essa|ela|essa\s+ideia|a\s+ideia))?\s+(?:pra|para|por)\s+(?:essa|isso|essa\s+aqui|isso\s+aqui|aqui)\s*:?\s*([\s\S]+)$/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match && match[1]) return match[1].trim();
  }

  return "";
}

function findRecentUpdateCandidate(history = []) {
  const userTexts = getRecentUserTexts(history).slice().reverse();
  for (const candidate of userTexts) {
    const extracted = extractUpdateText(candidate);
    if (extracted) return extracted;
  }
  return "";
}

function resolveFocusIdeaId(text, state) {
  return extractIdeaId(text)
    || state && state.focusIdeaId
    || state && state.payload && state.payload.idea && state.payload.idea.id
    || null;
}

function summarizeState(state) {
  if (!state) return null;
  return {
    activeTask: state.activeTask || null,
    activeTool: state.activeTool || null,
    focusIdeaId: state.focusIdeaId || null,
    payload: state.payload || {},
  };
}

function buildContextHints(history = [], state = null) {
  const recentUserTexts = getRecentUserTexts(history);
  const lastAssistantIntent = getLastAssistantIntent(history);
  const safeState = summarizeState(state);
  const preferredStatus =
    inferIdeaStatus(recentUserTexts[recentUserTexts.length - 1])
    || safeState && safeState.payload && safeState.payload.report && safeState.payload.report.status
    || safeState && safeState.payload && safeState.payload.list && safeState.payload.list.status
    || null;

  return {
    recentUserTexts,
    lastAssistantIntent,
    state: safeState,
    preferredStatus,
  };
}

function tryExplicitRoute(text, state) {
  const t = String(text || "").trim();
  if (!t) return null;

  const addMatch = t.match(/^(?:nova\s+ideia|ideia|anotar|add\s+idea|anota\s+isso)\s*[:\-]\s*([\s\S]+)$/i);
  if (addMatch && addMatch[1]) {
    return { tool: "ideas-add", args: { text: addMatch[1].trim() } };
  }

  const updateExplicitMatch = t.match(/^(?:atualizar|atualiza|atualize|editar|edita|edite|alterar|altera|altere|trocar|troca|troque|substituir|substitui|substitua)(?:\s+(?:a\s+)?)?ideia\s+#?(\d+)\s*(?::|\-|\s+para\s*:?\s*|\s+por\s*:?\s*)([\s\S]+)$/i);
  if (updateExplicitMatch && updateExplicitMatch[1] && updateExplicitMatch[2]) {
    return { tool: "ideas-update", args: { ideaId: updateExplicitMatch[1], text: updateExplicitMatch[2].trim() } };
  }

  const completeMatch = t.match(/^(?:completei|conclui|terminei|marcar|marca)\s+(?:a\s+)?ideia\s+#?(\d+)(?:\s+(?:como\s+)?(?:feita|done|conclu[ií]da|pronta))?$/i)
    || t.match(/^ideia\s+#?(\d+)\s+(?:feita|done|conclu[ií]da|pronta)$/i);
  if (completeMatch && completeMatch[1]) {
    return { tool: "ideas-complete", args: { ideaId: completeMatch[1] } };
  }

  const cancelMatch = t.match(/^(?:cancelar|cancela)\s+(?:a\s+)?ideia\s+#?(\d+)$/i);
  if (cancelMatch && cancelMatch[1]) {
    return { tool: "ideas-cancel", args: { ideaId: cancelMatch[1] } };
  }

  const deleteMatch = t.match(/^(?:deletar|deleta|deletei|remover|remove|removi|apagar|apaga|apaguei|excluir|exclui)\s+(?:a\s+)?ideia\s+#?(\d+)$/i);
  if (deleteMatch && deleteMatch[1]) {
    return { tool: "ideas-delete", args: { ideaId: deleteMatch[1] } };
  }

  if (/\b(ultima|última|mais recente)\s+ideia\b/i.test(t)
      || /^(?:me\s+)?lembra(?:r|)\s+(?:da\s+)?(?:minha\s+)?(?:ultima|última)\s+ideia/i.test(t)
      || /^qual\s+(?:foi\s+)?(?:a\s+)?(?:minha\s+)?(?:ultima|última)\s+ideia/i.test(t)) {
    return { tool: "ideas-latest", args: {} };
  }

  const showIdeaMatch = t.match(/^(?:me\s+)?lembra(?:r|)\s+(?:da\s+)?ideia\s+#?(\d+)$/i)
    || t.match(/^(?:qual\s+(?:e|é)\s+|como\s+esta\s+|como\s+ta\s+)?(?:a\s+)?ideia\s+#?(\d+)$/i)
    || t.match(/^(?:status\s+da\s+)?ideia\s+#?(\d+)$/i);
  if (showIdeaMatch && showIdeaMatch[1]) {
    return { tool: "ideas-show", args: { ideaId: showIdeaMatch[1] } };
  }

  if (/^(?:gera|gerar|gere|cria|criar|manda|envia)\s+(?:o\s+)?pdf/i.test(t)
      || /\bpdf\s+(?:das?|de)\s+ideias?\b/i.test(t)
      || /^relat[óo]rio\s+(?:das?|de)\s+ideias?/i.test(t)
      || /\b(?:atualiza|atualize)\s+(?:o\s+)?relat[óo]rio\b/i.test(t)) {
    return { tool: "ideas-pdf", args: { status: inferIdeaStatus(t, "all") } };
  }

  if (/^(?:listar?|lista|mostrar?|mostra|ver|quais)\s+(?:as\s+|minhas\s+)?ideias?/i.test(t)
      || /^ideias?\s+(?:abertas?|conclu[ií]das?|canceladas?|todas?|pendentes)/i.test(t)
      || /^minhas\s+ideias?/i.test(t)) {
    return { tool: "ideas-list", args: { status: inferIdeaStatus(t, "open") } };
  }

  const focusId = resolveFocusIdeaId(t, state);
  const extractedUpdate = extractUpdateText(t);
  if (focusId && extractedUpdate) {
    return { tool: "ideas-update", args: { ideaId: focusId, text: extractedUpdate } };
  }

  if (focusId && /^(?:conclui|conclui essa|marca como feita|finaliza ela|termina ela)$/i.test(t)) {
    return { tool: "ideas-complete", args: { ideaId: focusId } };
  }

  if (focusId && /^(?:cancela ela|cancela essa|deleta ela|deleta essa|remove ela|remove essa|apaga ela|apaga essa)$/i.test(t)) {
    const lower = normalizeText(t);
    const destructive = /(deleta|remove|apaga)/.test(lower) ? "ideas-delete" : "ideas-cancel";
    return { tool: destructive, args: { ideaId: focusId } };
  }

  if (focusId && /^(?:me\s+)?lembra(?:r|)\s+(?:dela|dessa|dessa\s+ideia|da\s+ideia)$/i.test(t)) {
    return { tool: "ideas-show", args: { ideaId: focusId } };
  }

  return null;
}

function routeContextualFollowup(text, history = [], state = null) {
  const lower = normalizeText(text);
  if (!lower) return null;

  const hints = buildContextHints(history, state);
  const activeTask = hints.state && hints.state.activeTask;
  const activeTool = hints.state && hints.state.activeTool;
  const preferredStatus = inferIdeaStatus(text, hints.preferredStatus || "all");
  const focusIdeaId = resolveFocusIdeaId(text, hints.state);
  const priorUpdateCandidate = findRecentUpdateCandidate(history);

  const asksForRefresh = /^(manda|me manda|envia|gera|cria|mostra|lista|atualiza|atualize)(?:\s+(?:atualizado|de novo|novamente))?$/.test(lower);
  const asksForReportLike = /\b(pdf|relatorio|documento|arquivo)\b/.test(lower);
  const asksForFilterOnly = preferredStatus && !/\bideia\b/.test(lower) && !extractIdeaId(text);

  if (asksForReportLike || (asksForRefresh && (activeTask === "ideas-report" || activeTool === "ideas-pdf"))) {
    return { tool: "ideas-pdf", args: { status: preferredStatus || hints.preferredStatus || "all" } };
  }

  if (asksForFilterOnly && (activeTask === "ideas-report" || activeTool === "ideas-pdf")) {
    return { tool: "ideas-pdf", args: { status: preferredStatus } };
  }

  if (asksForRefresh && (activeTask === "ideas-list" || activeTool === "ideas-list")) {
    return { tool: "ideas-list", args: { status: preferredStatus || hints.preferredStatus || "open" } };
  }

  if (asksForFilterOnly && (activeTask === "ideas-list" || activeTool === "ideas-list")) {
    return { tool: "ideas-list", args: { status: preferredStatus } };
  }

  const extractedUpdate = extractUpdateText(text);
  if (focusIdeaId && extractedUpdate) {
    return { tool: "ideas-update", args: { ideaId: focusIdeaId, text: extractedUpdate } };
  }

  if (
    focusIdeaId
    && priorUpdateCandidate
    && /(?:exatamente\s+como\s+eu\s+te\s+mandei|igual\s+eu\s+te\s+mandei|como\s+eu\s+te\s+mandei\s+aqui\s+acima|igual\s+eu\s+te\s+mandei\s+aqui\s+acima)/.test(lower)
  ) {
    return { tool: "ideas-update", args: { ideaId: focusIdeaId, text: priorUpdateCandidate } };
  }

  if (focusIdeaId && /^(?:como\s+ela\s+ta|como\s+esta\s+ela|me\s+lembra\s+dela|me\s+lembra\s+dessa)$/i.test(lower)) {
    return { tool: "ideas-show", args: { ideaId: focusIdeaId } };
  }

  return null;
}

const CLASSIFIER_SYSTEM = `Voce e um classificador de intencoes para o DHIEGO.AI, um assistente pessoal via WhatsApp.
Responda APENAS com JSON no formato {"tool":"<nome>","args":{...}}.

Tools validas:
- ideas-add -> {"text":"<texto>"}
- ideas-list -> {"status":"open"|"done"|"cancelled"|"all"}
- ideas-latest -> {}
- ideas-show -> {"ideaId":<n>}
- ideas-complete -> {"ideaId":<n>}
- ideas-cancel -> {"ideaId":<n>}
- ideas-delete -> {"ideaId":<n>}
- ideas-update -> {"ideaId":<n>,"text":"<novo texto>"}
- ideas-pdf -> {"status":"open"|"done"|"cancelled"|"all"}
- llm-freeform -> {}

Regras:
- Use ideas-update quando o usuario pedir para trocar, editar, alterar, atualizar ou substituir o texto de uma ideia.
- Use ideas-show quando o usuario quiser ver ou confirmar o conteudo/status de uma ideia especifica.
- Se o contexto recente indicar que o assunto atual e um PDF/relatorio de ideias, follow-ups como "manda atualizado", "envia de novo" e "nao mostre a cancelada" devem virar ideas-pdf.
- Se o contexto recente indicar que existe uma ideia em foco, follow-ups como "atualiza para: ...", "atualize ela pra essa aqui:" ou "me lembra dela" podem usar essa ideia em foco mesmo sem repetir o numero.
- Se o usuario pedir para colocar "exatamente como eu te mandei" ou "igual eu te mandei aqui acima", reutilize o ultimo bloco grande de atualizacao do historico recente.
- Para ideas-complete, ideas-cancel, ideas-delete, ideas-update e ideas-show, so use sem numero quando o contexto recente deixar claro qual e a ideia em foco.
- Se estiver em duvida entre uma tool e llm-freeform, prefira llm-freeform.
- Nunca responda texto fora do JSON.`;

async function classifyWithLlm(text, history = [], state = null) {
  try {
    const stateSummary = summarizeState(state);
    const contextBlock = [];
    if (stateSummary) {
      contextBlock.push("Estado ativo: " + JSON.stringify(stateSummary));
    }
    if (history.length) {
      contextBlock.push(
        "Contexto recente:\n" + history
          .slice(-8)
          .map(entry => `- ${entry.role}${entry.intent ? " [" + entry.intent + "]" : ""}: ${String(entry.content || "").slice(0, 240)}`)
          .join("\n")
      );
    }

    const resp = await complete({
      system: CLASSIFIER_SYSTEM,
      messages: [{ role: "user", content: String(text || "") + (contextBlock.length ? "\n\n" + contextBlock.join("\n\n") : "") }],
      maxTokens: 220,
    });
    const raw = (resp.text || "").trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed.tool === "string") {
      return { tool: parsed.tool, args: parsed.args || {} };
    }
  } catch (e) {
    console.error("[DHIEGO.AI] classifier parse error:", e.message);
  }
  return { tool: "llm-freeform", args: {} };
}

async function routeIntent(text, options = {}) {
  const history = Array.isArray(options.history) ? options.history : [];
  const state = options.state || null;

  const explicit = tryExplicitRoute(text, state);
  if (explicit) {
    console.log("[DHIEGO.AI] routed via regex:", explicit.tool);
    return explicit;
  }

  const contextual = routeContextualFollowup(text, history, state);
  if (contextual) {
    console.log("[DHIEGO.AI] routed via context:", contextual.tool);
    return contextual;
  }

  const llm = await classifyWithLlm(text, history, state);
  console.log("[DHIEGO.AI] routed via Claude:", llm.tool);
  return llm;
}

module.exports = {
  routeIntent,
  tryExplicitRoute,
  routeContextualFollowup,
  inferIdeaStatus,
  extractIdeaId,
  extractUpdateText,
};
