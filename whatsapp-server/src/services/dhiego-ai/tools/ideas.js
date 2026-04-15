// ===== DHIEGO.AI — Ideas backlog tool =====
// CRUD for the dhiego_ideas table via natural language commands.
//
// The classifier decides which action to run based on user intent:
//   ideas-add      -> add a new idea
//   ideas-list     -> list open/all ideas
//   ideas-complete -> mark an idea as done
//   ideas-cancel   -> mark an idea as cancelled
//
// Ideas use SERIAL ids so the user can say "completei a ideia 5" — the
// short number is much easier to type than a UUID.

const { supaRest } = require("../../supabase");

async function addIdea({ userId, sessionId, text, source = "text", sourceMessageId }) {
  if (!text || !text.trim()) {
    return { ok: false, reply: "❌ Preciso do texto da ideia. Exemplo: \"nova ideia: criar painel de métricas\"" };
  }
  const rows = await supaRest(
    "/rest/v1/dhiego_ideas",
    "POST",
    {
      user_id: userId,
      session_id: sessionId || null,
      text: text.trim(),
      source,
      source_message_id: sourceMessageId || null,
    },
    "return=representation"
  ).catch(e => { throw new Error("Erro ao salvar ideia: " + e.message); });

  const row = Array.isArray(rows) ? rows[0] : rows;
  return {
    ok: true,
    reply: "💡 Ideia #" + row.id + " salva:\n> " + row.text,
    data: row,
  };
}

async function listIdeas({ userId, status = "open", limit = 20 }) {
  const statusFilter = status && status !== "all" ? "&status=eq." + encodeURIComponent(status) : "";
  const rows = await supaRest(
    "/rest/v1/dhiego_ideas?user_id=eq." + encodeURIComponent(userId) +
    statusFilter +
    "&order=id.desc&limit=" + limit +
    "&select=id,text,status,source,created_at"
  ).catch(e => { throw new Error("Erro ao listar ideias: " + e.message); });

  if (!rows || rows.length === 0) {
    const emptyMsg = status === "open" ? "✅ Nenhuma ideia aberta — tudo em dia!" : "📭 Nenhuma ideia encontrada.";
    return { ok: true, reply: emptyMsg, data: [] };
  }

  const statusEmoji = { open: "⏳", done: "✅", cancelled: "❌" };
  const lines = rows.map(r => {
    const emoji = statusEmoji[r.status] || "•";
    return emoji + " #" + r.id + " — " + r.text;
  });

  const header = status === "open" ? "💡 Ideias abertas (" + rows.length + "):" :
                 status === "done" ? "✅ Ideias concluídas (" + rows.length + "):" :
                 "📝 Ideias (" + rows.length + "):";

  return {
    ok: true,
    reply: header + "\n\n" + lines.join("\n"),
    data: rows,
  };
}

async function completeIdea({ userId, ideaId }) {
  const id = parseInt(ideaId, 10);
  if (!id || id <= 0) {
    return { ok: false, reply: "❌ ID inválido. Diz o número da ideia: \"completei a ideia 5\"" };
  }
  // Verify ownership and status before updating
  const existing = await supaRest(
    "/rest/v1/dhiego_ideas?id=eq." + id +
    "&user_id=eq." + encodeURIComponent(userId) +
    "&select=id,text,status&limit=1"
  ).catch(() => []);
  const row = (existing || [])[0];
  if (!row) {
    return { ok: false, reply: "❌ Ideia #" + id + " não encontrada." };
  }
  if (row.status === "done") {
    return { ok: false, reply: "ℹ️ Ideia #" + id + " já está marcada como concluída." };
  }

  await supaRest(
    "/rest/v1/dhiego_ideas?id=eq." + id,
    "PATCH",
    { status: "done", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    "return=minimal"
  );

  return {
    ok: true,
    reply: "✅ Ideia #" + id + " marcada como concluída:\n> " + row.text,
  };
}

async function cancelIdea({ userId, ideaId }) {
  const id = parseInt(ideaId, 10);
  if (!id || id <= 0) {
    return { ok: false, reply: "❌ ID inválido." };
  }
  const existing = await supaRest(
    "/rest/v1/dhiego_ideas?id=eq." + id +
    "&user_id=eq." + encodeURIComponent(userId) +
    "&select=id,text,status&limit=1"
  ).catch(() => []);
  const row = (existing || [])[0];
  if (!row) return { ok: false, reply: "❌ Ideia #" + id + " não encontrada." };

  await supaRest(
    "/rest/v1/dhiego_ideas?id=eq." + id,
    "PATCH",
    { status: "cancelled", updated_at: new Date().toISOString() },
    "return=minimal"
  );
  return { ok: true, reply: "❌ Ideia #" + id + " cancelada." };
}

module.exports = { addIdea, listIdeas, completeIdea, cancelIdea };
