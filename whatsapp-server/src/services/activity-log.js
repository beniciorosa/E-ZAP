// ===== Activity Log =====
// Serviço unificado pra registrar eventos de produção em 1 tabela
// (`activity_events`) + emitir em tempo real via socket.io pra sidebar do
// grupos.html. Fire-and-forget por design — NÃO bloqueia o fluxo principal
// se o INSERT do Supabase for lento/falhar.
//
// Uso:
//   const { logEvent } = require("./activity-log");
//   logEvent({
//     type: "group_create:success",
//     level: "info",
//     message: "Grupo criado: Cliente X | Mentor Y",
//     sessionId, sessionLabel, sessionPhone, jobId, groupJid, groupName,
//     metadata: { specHash: "...", memberCount: 4, deltaMs: 43000 }
//   });
//
// Padrão de nomes (event_type): <domain>:<action>
//   group_create_job:started | :completed | :rate_limited | :cancelled | :error
//   group_create:start | :success | :failed | :rate_limit | :bad_request_fallback
//   dm_sent:<client|cx2|escalada> / dm_failed:<same>
//   session:quarantine_enter | :quarantine_release
//   resolve_tickets | phone_validation:adjusted_9_br | :not_on_whatsapp
//   template:saved | :deleted

const { supaRest } = require("./supabase");

let ioRef = null;

function setIO(io) {
  ioRef = io;
}

function logEvent(opts) {
  const o = opts || {};
  const now = new Date().toISOString();
  const payload = {
    occurred_at: now,
    event_type: String(o.type || "unknown"),
    level: String(o.level || "info"),
    message: String(o.message || ""),
    session_id: o.sessionId || null,
    session_label: o.sessionLabel || null,
    session_phone: o.sessionPhone || null,
    job_id: o.jobId || null,
    group_jid: o.groupJid || null,
    group_name: o.groupName || null,
    metadata: o.metadata || null,
  };

  // 1. Emit via socket.io IMEDIATAMENTE — feedback instantâneo pro frontend.
  //    Não espera DB persistir.
  if (ioRef) {
    try {
      ioRef.emit("activity:event", payload);
    } catch (e) {
      console.warn("[ACTIVITY] socket emit failed:", e.message);
    }
  }

  // 2. Persiste no DB async (fire-and-forget). Erros só logados, não propagados.
  supaRest("/rest/v1/activity_events", "POST", payload, "return=minimal")
    .catch(e => {
      console.error("[ACTIVITY] persist failed:", e.message, "type=" + payload.event_type);
    });
}

// Helper pra log de erro com stacktrace legal
function logError(opts) {
  const err = opts.error || {};
  const metadata = Object.assign({}, opts.metadata || {}, {
    error_name: err.name || null,
    error_stack: typeof err.stack === "string" ? err.stack.split("\n").slice(0, 5).join("\n") : null,
  });
  logEvent(Object.assign({}, opts, {
    level: opts.level || "error",
    message: opts.message || (err.message || String(err)),
    metadata,
  }));
}

module.exports = { setIO, logEvent, logError };
