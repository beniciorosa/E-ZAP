// ===== DHIEGO.AI — Conversation history =====
// Load & persist turns in dhiego_conversations so the assistant has
// continuity across messages. Scoped by (user_id, session_id) — every
// authorized phone sharing a session shares the same memory.

const { supaRest } = require("../supabase");

const DEFAULT_LIMIT = parseInt(process.env.DHIEGO_HISTORY_LIMIT || "20", 10);

// Returns the last N turns in Anthropic messages format:
//   [{ role: "user"|"assistant", content: "..." }, ...]
// Ordered oldest → newest so Claude reads them chronologically.
async function loadRecentTurns(ctx, limit = DEFAULT_LIMIT) {
  if (!ctx || !ctx.userId || !ctx.sessionId) return [];
  try {
    const rows = await supaRest(
      "/rest/v1/dhiego_conversations" +
      "?user_id=eq." + encodeURIComponent(ctx.userId) +
      "&session_id=eq." + encodeURIComponent(ctx.sessionId) +
      "&select=role,content" +
      "&order=created_at.desc" +
      "&limit=" + limit
    );
    return (rows || [])
      .reverse()
      .map(r => ({ role: r.role, content: r.content }));
  } catch (e) {
    console.error("[DHIEGO.AI] loadRecentTurns failed:", e.message);
    return [];
  }
}

async function loadRecentEntries(ctx, limit = DEFAULT_LIMIT) {
  if (!ctx || !ctx.userId || !ctx.sessionId) return [];
  try {
    const rows = await supaRest(
      "/rest/v1/dhiego_conversations" +
      "?user_id=eq." + encodeURIComponent(ctx.userId) +
      "&session_id=eq." + encodeURIComponent(ctx.sessionId) +
      "&select=role,content,intent,created_at" +
      "&order=created_at.desc" +
      "&limit=" + limit
    );
    return (rows || []).reverse();
  } catch (e) {
    console.error("[DHIEGO.AI] loadRecentEntries failed:", e.message);
    return [];
  }
}

// Persists a single turn. Fire-and-forget — logs on error but never throws.
async function saveTurn(ctx, role, content, intent = null) {
  if (!ctx || !ctx.userId || !ctx.sessionId || !content) return;
  try {
    await supaRest(
      "/rest/v1/dhiego_conversations",
      "POST",
      {
        user_id: ctx.userId,
        session_id: ctx.sessionId,
        chat_jid: ctx.chatJid || "",
        sender_phone: ctx.sourcePhone || "",
        role,
        content: String(content).slice(0, 8000),
        intent,
      },
      "return=minimal"
    );
  } catch (e) {
    console.error("[DHIEGO.AI] saveTurn failed:", e.message);
  }
}

module.exports = { loadRecentTurns, loadRecentEntries, saveTurn };
