// ===== DHIEGO.AI — Reminders tool =====
// Agenda mensagens para serem entregues ao Dhiego em um horário futuro.
// Persistência em dhiego_reminders (migration 065). Um scheduler rodando
// no processo principal (services/dhiego-ai/reminder-scheduler.js) varre
// a tabela a cada minuto e dispara os lembretes prontos via baileys.sendMessage.
//
// Claude (agent) chama create_reminder passando ISO 8601 já resolvido a partir
// de linguagem natural do Dhiego ("amanhã às 9h", "daqui a 2 horas"). O prompt
// do sistema fornece a data atual em America/Sao_Paulo pra facilitar essa
// resolução. Se o ISO vier sem offset, assumimos -03:00 (America/Sao_Paulo).

const { supaRest } = require("../../supabase");

const MAX_MESSAGE_LEN = 2000;
const SAO_PAULO_OFFSET = "-03:00";

function parseScheduledAt(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Se já vier com offset explícito ou Z, usa direto.
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed);
  const normalized = hasTz ? trimmed : trimmed + SAO_PAULO_OFFSET;

  const d = new Date(normalized);
  if (isNaN(d.getTime())) return null;
  return d;
}

function formatForUser(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function createReminder({
  userId,
  sessionId,
  chatJid,
  message,
  scheduledAt,
  sourceMessageId,
  createdVia = "agent",
}) {
  if (!userId || !sessionId || !chatJid) {
    return { ok: false, reply: "Contexto incompleto para criar lembrete (sessão/chat)." };
  }
  if (!message || !String(message).trim()) {
    return { ok: false, reply: "Preciso do texto do lembrete. Ex: 'me lembra amanhã 9h de ligar pro cliente'." };
  }

  const parsed = parseScheduledAt(scheduledAt);
  if (!parsed) {
    return {
      ok: false,
      reply: "Não entendi o horário do lembrete. Me passa data e hora (ex: amanhã às 9h, 23/04 14:30).",
    };
  }
  if (parsed.getTime() <= Date.now() + 5000) {
    return {
      ok: false,
      reply: "Esse horário já passou — me dá um horário futuro pra eu te lembrar.",
    };
  }

  const body = String(message).trim().slice(0, MAX_MESSAGE_LEN);

  const rows = await supaRest(
    "/rest/v1/dhiego_reminders",
    "POST",
    {
      user_id: userId,
      session_id: sessionId,
      chat_jid: chatJid,
      message: body,
      scheduled_at: parsed.toISOString(),
      status: "pending",
      created_via: createdVia,
      source_message_id: sourceMessageId || null,
    },
    "return=representation"
  ).catch(e => { throw new Error("Erro ao salvar lembrete: " + e.message); });

  const row = Array.isArray(rows) ? rows[0] : rows;

  return {
    ok: true,
    reply:
      "⏰ Lembrete #" + row.id + " agendado para " + formatForUser(parsed) +
      " (horário de Brasília):\n> " + body,
    data: row,
  };
}

async function listReminders({ userId, status = "pending", limit = 20 }) {
  if (!userId) return { ok: false, reply: "Sem usuário para listar lembretes." };
  const statusFilter =
    status && status !== "all" ? "&status=eq." + encodeURIComponent(status) : "";
  const rows = await supaRest(
    "/rest/v1/dhiego_reminders?user_id=eq." + encodeURIComponent(userId) +
    statusFilter +
    "&order=scheduled_at.asc&limit=" + limit +
    "&select=id,message,scheduled_at,status,sent_at,created_at"
  ).catch(e => { throw new Error("Erro ao listar lembretes: " + e.message); });

  if (!rows || rows.length === 0) {
    const emptyMsg =
      status === "pending" ? "Nenhum lembrete pendente." :
      status === "sent" ? "Nenhum lembrete disparado ainda." :
      "Nenhum lembrete encontrado.";
    return { ok: true, reply: emptyMsg, data: [] };
  }

  const statusEmoji = { pending: "⏰", sent: "✅", cancelled: "❌", failed: "⚠️" };
  const lines = rows.map(r => {
    const emoji = statusEmoji[r.status] || "•";
    const when = formatForUser(new Date(r.scheduled_at));
    return emoji + " #" + r.id + " — " + when + " — " + r.message;
  });
  const header =
    status === "pending" ? "Lembretes pendentes (" + rows.length + "):" :
    status === "sent" ? "Lembretes já enviados (" + rows.length + "):" :
    "Lembretes (" + rows.length + "):";

  return { ok: true, reply: header + "\n\n" + lines.join("\n"), data: rows };
}

async function cancelReminder({ userId, reminderId }) {
  const id = parseInt(reminderId, 10);
  if (!id || id <= 0) {
    return { ok: false, reply: "ID inválido. Diz o número do lembrete (ex: 'cancela lembrete 3')." };
  }

  const existing = await supaRest(
    "/rest/v1/dhiego_reminders?id=eq." + id +
    "&user_id=eq." + encodeURIComponent(userId) +
    "&select=id,message,scheduled_at,status&limit=1"
  ).catch(() => []);
  const row = (existing || [])[0];
  if (!row) return { ok: false, reply: "Lembrete #" + id + " não encontrado." };
  if (row.status !== "pending") {
    return {
      ok: false,
      reply: "Lembrete #" + id + " já está " + row.status + ", não dá pra cancelar.",
    };
  }

  await supaRest(
    "/rest/v1/dhiego_reminders?id=eq." + id,
    "PATCH",
    { status: "cancelled", updated_at: new Date().toISOString() },
    "return=minimal"
  );

  return {
    ok: true,
    reply: "Lembrete #" + id + " cancelado (era: " + formatForUser(new Date(row.scheduled_at)) + ").",
    data: Object.assign({}, row, { status: "cancelled" }),
  };
}

module.exports = {
  createReminder,
  listReminders,
  cancelReminder,
  parseScheduledAt,
  formatForUser,
};
