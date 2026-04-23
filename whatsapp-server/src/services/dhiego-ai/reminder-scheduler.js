// ===== DHIEGO.AI — Reminder scheduler =====
// Varre a tabela dhiego_reminders a cada minuto e entrega os lembretes que já
// chegaram no horário (scheduled_at <= now, status='pending'). Usa
// baileys.sendMessage pra mandar texto no chat original onde o lembrete foi
// criado.
//
// Falhas transitórias incrementam `attempts` e mantêm status='pending'. Após
// MAX_ATTEMPTS o lembrete é marcado como 'failed' com last_error pra
// diagnóstico. Isso evita loops infinitos quando a sessão está desconectada
// por muito tempo.

const { supaRest } = require("../supabase");

const POLL_INTERVAL_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const BATCH_LIMIT = 25;

let _interval = null;
let _running = false;

function formatBrasilia(date) {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    }).format(date);
  } catch (_) { return ""; }
}

async function fetchDueReminders() {
  const nowIso = new Date().toISOString();
  const rows = await supaRest(
    "/rest/v1/dhiego_reminders" +
    "?status=eq.pending" +
    "&scheduled_at=lte." + encodeURIComponent(nowIso) +
    "&order=scheduled_at.asc" +
    "&limit=" + BATCH_LIMIT +
    "&select=id,user_id,session_id,chat_jid,message,scheduled_at,attempts"
  );
  return Array.isArray(rows) ? rows : [];
}

async function markSent(row) {
  const nowIso = new Date().toISOString();
  await supaRest(
    "/rest/v1/dhiego_reminders?id=eq." + row.id,
    "PATCH",
    { status: "sent", sent_at: nowIso, updated_at: nowIso, attempts: (row.attempts || 0) + 1 },
    "return=minimal"
  );
}

async function markFailure(row, err) {
  const attempts = (row.attempts || 0) + 1;
  const nextStatus = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
  const nowIso = new Date().toISOString();
  const payload = {
    attempts,
    last_error: (err && err.message ? err.message : String(err || "")).slice(0, 500),
    updated_at: nowIso,
  };
  if (nextStatus === "failed") payload.status = "failed";
  await supaRest(
    "/rest/v1/dhiego_reminders?id=eq." + row.id,
    "PATCH",
    payload,
    "return=minimal"
  ).catch(e => console.error("[REMINDERS] markFailure patch failed:", e.message));
}

async function deliverOne(row, baileys) {
  const prefix = "⏰ Lembrete (" + formatBrasilia(new Date(row.scheduled_at)) + "):\n";
  const body = prefix + (row.message || "");
  try {
    await baileys.sendMessage(row.session_id, row.chat_jid, { text: body });
    await markSent(row);
    console.log("[REMINDERS] delivered #" + row.id + " to " + row.chat_jid);
  } catch (e) {
    console.error("[REMINDERS] deliver #" + row.id + " failed:", e.message);
    await markFailure(row, e);
  }
}

async function tick(baileys) {
  if (_running) return;
  _running = true;
  try {
    const due = await fetchDueReminders();
    if (!due.length) return;
    console.log("[REMINDERS] delivering " + due.length + " due reminder(s)");
    for (const row of due) {
      // Serial delivery: evita rajada contra Baileys quando vários lembretes
      // caem no mesmo minuto.
      await deliverOne(row, baileys);
    }
  } catch (e) {
    console.error("[REMINDERS] tick failed:", e.message);
  } finally {
    _running = false;
  }
}

function start(baileys) {
  if (_interval) return;
  if (!baileys || typeof baileys.sendMessage !== "function") {
    console.warn("[REMINDERS] baileys.sendMessage não disponível — scheduler não iniciado");
    return;
  }
  console.log("[REMINDERS] scheduler iniciado (poll a cada " + POLL_INTERVAL_MS / 1000 + "s)");
  // Primeiro tick após pequeno delay pra não colidir com boot das sessões.
  setTimeout(() => tick(baileys), 10 * 1000);
  _interval = setInterval(() => tick(baileys), POLL_INTERVAL_MS);
}

function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

module.exports = { start, stop, tick };
