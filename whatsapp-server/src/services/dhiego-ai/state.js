const { supaRest } = require("../supabase");

const DEFAULT_TTL_HOURS = parseInt(process.env.DHIEGO_STATE_TTL_HOURS || "12", 10);
const memoryState = new Map();

function normalizePayload(payload) {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

function getScope(ctx) {
  if (!ctx || !ctx.userId || !ctx.sessionId || !ctx.chatJid) return null;
  return {
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    chatJid: ctx.chatJid,
  };
}

function computeExpiryIso(hours = DEFAULT_TTL_HOURS) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function buildMemoryKey(scope) {
  if (!scope) return "";
  return [scope.userId, scope.sessionId, scope.chatJid].join(":");
}

function readMemoryState(scope) {
  const key = buildMemoryKey(scope);
  const row = key ? memoryState.get(key) : null;
  if (!row) return null;
  if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
    memoryState.delete(key);
    return null;
  }
  return Object.assign({}, row, { payload: normalizePayload(row.payload) });
}

function writeMemoryState(scope, next) {
  const key = buildMemoryKey(scope);
  if (!key) return null;
  const row = {
    activeTask: next.activeTask || null,
    activeTool: next.activeTool || null,
    focusIdeaId: next.focusIdeaId || null,
    payload: normalizePayload(next.payload),
    updatedAt: next.updatedAt || new Date().toISOString(),
    expiresAt: next.expiresAt || computeExpiryIso(),
  };
  memoryState.set(key, row);
  return row;
}

function clearMemoryState(scope) {
  const key = buildMemoryKey(scope);
  if (key) memoryState.delete(key);
}

async function loadState(ctx) {
  const scope = getScope(ctx);
  if (!scope) return null;

  try {
    const rows = await supaRest(
      "/rest/v1/dhiego_ai_state" +
      "?user_id=eq." + encodeURIComponent(scope.userId) +
      "&session_id=eq." + encodeURIComponent(scope.sessionId) +
      "&chat_jid=eq." + encodeURIComponent(scope.chatJid) +
      "&select=id,active_task,active_tool,focus_idea_id,state_payload,updated_at,expires_at" +
      "&limit=1"
    );

    const row = (rows || [])[0];
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      await clearState(ctx).catch(() => null);
      return null;
    }
    return {
      id: row.id,
      activeTask: row.active_task || null,
      activeTool: row.active_tool || null,
      focusIdeaId: row.focus_idea_id || null,
      payload: normalizePayload(row.state_payload),
      updatedAt: row.updated_at || null,
      expiresAt: row.expires_at || null,
    };
  } catch (e) {
    console.error("[DHIEGO.AI] loadState failed:", e.message);
    return readMemoryState(scope);
  }
}

async function saveState(ctx, next = {}) {
  const scope = getScope(ctx);
  if (!scope) return null;

  const payload = {
    user_id: scope.userId,
    session_id: scope.sessionId,
    chat_jid: scope.chatJid,
    active_task: next.activeTask || null,
    active_tool: next.activeTool || null,
    focus_idea_id: next.focusIdeaId || null,
    state_payload: normalizePayload(next.payload),
    updated_at: new Date().toISOString(),
    expires_at: next.expiresAt || computeExpiryIso(),
  };

  try {
    await supaRest(
      "/rest/v1/dhiego_ai_state?on_conflict=user_id,session_id,chat_jid",
      "POST",
      payload,
      "resolution=merge-duplicates,return=minimal"
    );
    return {
      activeTask: payload.active_task,
      activeTool: payload.active_tool,
      focusIdeaId: payload.focus_idea_id,
      payload: payload.state_payload,
      updatedAt: payload.updated_at,
      expiresAt: payload.expires_at,
    };
  } catch (e) {
    console.error("[DHIEGO.AI] saveState failed:", e.message);
    return writeMemoryState(scope, {
      activeTask: payload.active_task,
      activeTool: payload.active_tool,
      focusIdeaId: payload.focus_idea_id,
      payload: payload.state_payload,
      updatedAt: payload.updated_at,
      expiresAt: payload.expires_at,
    });
  }
}

async function clearState(ctx) {
  const scope = getScope(ctx);
  if (!scope) return;
  clearMemoryState(scope);
  try {
    await supaRest(
      "/rest/v1/dhiego_ai_state" +
      "?user_id=eq." + encodeURIComponent(scope.userId) +
      "&session_id=eq." + encodeURIComponent(scope.sessionId) +
      "&chat_jid=eq." + encodeURIComponent(scope.chatJid),
      "DELETE",
      null,
      "return=minimal"
    );
  } catch (e) {
    console.error("[DHIEGO.AI] clearState failed:", e.message);
  }
}

async function clearStateForUser(userId) {
  if (!userId) return;
  for (const key of Array.from(memoryState.keys())) {
    if (key.startsWith(userId + ":")) memoryState.delete(key);
  }
  try {
    await supaRest(
      "/rest/v1/dhiego_ai_state?user_id=eq." + encodeURIComponent(userId),
      "DELETE",
      null,
      "return=minimal"
    );
  } catch (e) {
    console.error("[DHIEGO.AI] clearStateForUser failed:", e.message);
  }
}

function deriveStateUpdate(intent, ctx, result, currentState) {
  const payload = Object.assign({}, normalizePayload(currentState && currentState.payload));
  const next = {
    activeTask: currentState && currentState.activeTask || null,
    activeTool: intent && intent.tool || currentState && currentState.activeTool || null,
    focusIdeaId: currentState && currentState.focusIdeaId || null,
    payload,
    expiresAt: computeExpiryIso(),
  };

  if (ctx && ctx.sourcePhone) payload.lastSenderPhone = ctx.sourcePhone;

  const tool = intent && intent.tool;
  const args = intent && intent.args || {};
  const data = result && result.data;

  if (tool === "ideas-pdf") {
    next.activeTask = "ideas-report";
    payload.report = {
      kind: "pdf",
      status: args.status || payload.report && payload.report.status || "all",
      filename: result && result.document ? result.document.filename : null,
      generatedAt: new Date().toISOString(),
    };
    return next;
  }

  if (tool === "ideas-list") {
    next.activeTask = "ideas-list";
    payload.list = {
      status: args.status || "open",
      lastCount: Array.isArray(data) ? data.length : null,
      generatedAt: new Date().toISOString(),
    };
    if (Array.isArray(data) && data[0] && data[0].id) next.focusIdeaId = data[0].id;
    return next;
  }

  if (tool === "ideas-latest") {
    next.activeTask = "idea-focus";
    if (data && data.id) next.focusIdeaId = data.id;
    if (data && data.id) {
      payload.idea = {
        id: data.id,
        status: data.status || null,
        text: data.text || "",
        source: "latest",
      };
    }
    return next;
  }

  if (tool === "ideas-add" || tool === "ideas-update" || tool === "ideas-show") {
    next.activeTask = "idea-focus";
    if (data && data.id) next.focusIdeaId = data.id;
    payload.idea = {
      id: data && data.id || next.focusIdeaId || null,
      status: data && data.status || payload.idea && payload.idea.status || "open",
      text: data && data.text || args.text || "",
      source: tool === "ideas-add" ? "created" : tool === "ideas-update" ? "updated" : "shown",
    };
    return next;
  }

  if (tool === "ideas-complete" || tool === "ideas-cancel" || tool === "ideas-delete") {
    next.activeTask = "idea-focus";
    const ideaId = parseInt(args.ideaId, 10) || next.focusIdeaId || null;
    next.focusIdeaId = tool === "ideas-delete" ? null : ideaId;
    payload.idea = {
      id: ideaId,
      status: tool === "ideas-complete" ? "done" : tool === "ideas-cancel" ? "cancelled" : "deleted",
      text: data && data.text || payload.idea && payload.idea.text || "",
      source: tool,
    };
    return next;
  }

  if (tool === "llm-freeform") {
    next.activeTask = currentState && currentState.activeTask || null;
    return next;
  }

  return next;
}

async function syncStateAfterTurn({ ctx, intent, result, currentState }) {
  const next = deriveStateUpdate(intent, ctx, result, currentState);
  if (!next.activeTask && !next.activeTool && !next.focusIdeaId && !Object.keys(next.payload || {}).length) {
    return clearState(ctx);
  }
  return saveState(ctx, next);
}

module.exports = {
  loadState,
  saveState,
  clearState,
  clearStateForUser,
  syncStateAfterTurn,
};
