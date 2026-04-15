// ===== DHIEGO.AI - Ideas backlog tool =====
// CRUD for the dhiego_ideas table via natural language commands.
//
// The classifier decides which action to run based on user intent:
//   ideas-add      -> add a new idea
//   ideas-list     -> list open/all ideas
//   ideas-complete -> mark an idea as done
//   ideas-cancel   -> mark an idea as cancelled
//   ideas-delete   -> permanently delete an idea
//   ideas-update   -> update the text of an idea
//   ideas-latest   -> recall the latest active idea first

const { supaRest } = require("../../supabase");

async function fetchIdeaById({ userId, ideaId }) {
  const id = parseInt(ideaId, 10);
  if (!id || id <= 0) return null;
  const rows = await supaRest(
    "/rest/v1/dhiego_ideas?id=eq." + id +
    "&user_id=eq." + encodeURIComponent(userId) +
    "&select=id,text,status,source,created_at,updated_at,completed_at&limit=1"
  ).catch(() => []);
  return (rows || [])[0] || null;
}

async function fetchLatestOpenIdea(userId) {
  const rows = await supaRest(
    "/rest/v1/dhiego_ideas?user_id=eq." + encodeURIComponent(userId) +
    "&status=eq.open&order=created_at.desc&limit=1" +
    "&select=id,text,status,source,created_at,updated_at,completed_at"
  ).catch(() => []);
  return (rows || [])[0] || null;
}

async function addIdea({ userId, sessionId, text, source = "text", sourceMessageId }) {
  if (!text || !text.trim()) {
    return { ok: false, reply: "Preciso do texto da ideia. Exemplo: \"nova ideia: criar painel de metricas\"" };
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
    reply: "Ideia #" + row.id + " salva:\n> " + row.text,
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
    const emptyMsg = status === "open" ? "Nenhuma ideia aberta." : "Nenhuma ideia encontrada.";
    return { ok: true, reply: emptyMsg, data: [] };
  }

  const statusEmoji = { open: "⏳", done: "✅", cancelled: "❌" };
  const lines = rows.map(r => {
    const emoji = statusEmoji[r.status] || "•";
    return emoji + " #" + r.id + " - " + r.text;
  });

  const header = status === "open" ? "Ideias abertas (" + rows.length + "):" :
    status === "done" ? "Ideias concluidas (" + rows.length + "):" :
      status === "cancelled" ? "Ideias canceladas (" + rows.length + "):" :
        "Ideias (" + rows.length + "):";

  return {
    ok: true,
    reply: header + "\n\n" + lines.join("\n"),
    data: rows,
  };
}

async function latestIdea({ userId }) {
  const row = await fetchLatestOpenIdea(userId).catch(e => { throw new Error("Erro ao buscar ultima ideia aberta: " + e.message); });

  if (row) {
    return {
      ok: true,
      reply: "Sua ultima ideia aberta e a #" + row.id + ":\n> " + row.text,
      data: row,
    };
  }

  const fallbackRows = await supaRest(
    "/rest/v1/dhiego_ideas?user_id=eq." + encodeURIComponent(userId) +
    "&order=created_at.desc&limit=1" +
    "&select=id,text,status,source,created_at,updated_at,completed_at"
  ).catch(e => { throw new Error("Erro ao buscar ultima ideia: " + e.message); });

  if (!fallbackRows || !fallbackRows[0]) {
    return { ok: true, reply: "Voce ainda nao tem ideias salvas.", data: null };
  }

  const fallback = fallbackRows[0];
  const label = fallback.status === "done"
    ? "ultima ideia concluida"
    : fallback.status === "cancelled"
      ? "ultima ideia cancelada"
      : "ultima ideia";
  return {
    ok: true,
    reply: "Sua " + label + " e a #" + fallback.id + ":\n> " + fallback.text,
    data: fallback,
  };
}

async function showIdea({ userId, ideaId }) {
  const id = parseInt(ideaId, 10);
  if (!id || id <= 0) {
    return { ok: false, reply: "ID invalido." };
  }

  const row = await fetchIdeaById({ userId, ideaId: id });
  if (!row) {
    return { ok: false, reply: "Ideia #" + id + " nao encontrada." };
  }

  const statusLabel = row.status === "done"
    ? "concluida"
    : row.status === "cancelled"
      ? "cancelada"
      : "aberta";

  return {
    ok: true,
    reply: "Ideia #" + id + " esta " + statusLabel + ":\n> " + row.text,
    data: row,
  };
}

async function completeIdea({ userId, ideaId }) {
  const id = parseInt(ideaId, 10);
  if (!id || id <= 0) {
    return { ok: false, reply: "ID invalido. Diz o numero da ideia: \"completei a ideia 5\"" };
  }

  const row = await fetchIdeaById({ userId, ideaId: id });
  if (!row) {
    return { ok: false, reply: "Ideia #" + id + " nao encontrada." };
  }
  if (row.status === "done") {
    return { ok: false, reply: "Ideia #" + id + " ja esta marcada como concluida." };
  }

  await supaRest(
    "/rest/v1/dhiego_ideas?id=eq." + id,
    "PATCH",
    { status: "done", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    "return=minimal"
  );

  return {
    ok: true,
    reply: "Ideia #" + id + " marcada como concluida:\n> " + row.text,
    data: Object.assign({}, row, { status: "done", completed_at: new Date().toISOString() }),
  };
}

async function cancelIdea({ userId, ideaId }) {
  const id = parseInt(ideaId, 10);
  if (!id || id <= 0) {
    return { ok: false, reply: "ID invalido." };
  }
  const row = await fetchIdeaById({ userId, ideaId: id });
  if (!row) return { ok: false, reply: "Ideia #" + id + " nao encontrada." };

  await supaRest(
    "/rest/v1/dhiego_ideas?id=eq." + id,
    "PATCH",
    { status: "cancelled", updated_at: new Date().toISOString() },
    "return=minimal"
  );
  return { ok: true, reply: "Ideia #" + id + " cancelada.", data: Object.assign({}, row, { status: "cancelled" }) };
}

async function deleteIdea({ userId, ideaId }) {
  const id = parseInt(ideaId, 10);
  if (!id || id <= 0) {
    return { ok: false, reply: "ID invalido." };
  }
  const row = await fetchIdeaById({ userId, ideaId: id });
  if (!row) return { ok: false, reply: "Ideia #" + id + " nao encontrada." };

  await supaRest(
    "/rest/v1/dhiego_ideas?id=eq." + id,
    "DELETE",
    null,
    "return=minimal"
  );
  return { ok: true, reply: "Ideia #" + id + " deletada:\n> " + row.text, data: row };
}

async function updateIdea({ userId, ideaId, text }) {
  const id = parseInt(ideaId, 10);
  if (!id || id <= 0) {
    return { ok: false, reply: "ID invalido. Diz algo como: \"atualiza a ideia 3: novo texto\"" };
  }
  if (!text || !text.trim()) {
    return { ok: false, reply: "Preciso do novo texto da ideia." };
  }

  const row = await fetchIdeaById({ userId, ideaId: id });
  if (!row) return { ok: false, reply: "Ideia #" + id + " nao encontrada." };

  const newText = text.trim();
  const updatedAt = new Date().toISOString();
  await supaRest(
    "/rest/v1/dhiego_ideas?id=eq." + id,
    "PATCH",
    { text: newText, updated_at: updatedAt },
    "return=minimal"
  );

  return {
    ok: true,
    reply: "Ideia #" + id + " atualizada:\n> " + newText,
    data: Object.assign({}, row, { text: newText, updated_at: updatedAt }),
  };
}

module.exports = {
  addIdea,
  listIdeas,
  latestIdea,
  showIdea,
  completeIdea,
  cancelIdea,
  deleteIdea,
  updateIdea,
  fetchIdeaById,
  fetchLatestOpenIdea,
};
