// ===== Activity Log Routes =====
// Endpoints pra frontend (sidebar de log em grupos.html):
//  - GET /api/activity         → lista eventos filtrados por dia/sessão/tipo/level
//  - GET /api/activity/insights → agregados do dia pra o header da sidebar
//
// Real-time via socket.io canal "activity:event" (ver services/activity-log.js).
// Essa rota serve o bootstrap HTTP inicial + pedidos históricos de outros dias.

const express = require("express");
const router = express.Router();
const { supaRest } = require("../services/supabase");

// Normaliza "today" / "yesterday" / "YYYY-MM-DD" em timezone America/Sao_Paulo.
// Retorna "YYYY-MM-DD" pra usar com a coluna generated `day`.
function normalizeDay(input) {
  if (!input || input === "today") {
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    return d.toISOString().slice(0, 10);
  }
  if (input === "yesterday") {
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  // YYYY-MM-DD literal — valida
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(input))) return String(input);
  // fallback: hoje
  return new Date().toISOString().slice(0, 10);
}

// GET /api/activity
// Query params: day (today|yesterday|YYYY-MM-DD), session_id, event_type, level, limit
router.get("/", async (req, res) => {
  try {
    const day = normalizeDay(req.query.day);
    const sessionId = req.query.session_id || null;
    const eventType = req.query.event_type || null;
    const level = req.query.level || null;
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));

    let qs = "/rest/v1/activity_events?day=eq." + day +
      "&select=id,occurred_at,event_type,level,session_id,session_label,session_phone,job_id,group_jid,group_name,message,metadata" +
      "&order=occurred_at.desc&limit=" + limit;
    if (sessionId) qs += "&session_id=eq." + encodeURIComponent(sessionId);
    if (eventType) {
      // event_type pode ser prefixo ("group_create" pega tudo que começa com isso)
      if (eventType.endsWith(":*") || !eventType.includes(":")) {
        const prefix = eventType.replace(/:\*$/, "");
        qs += "&event_type=like." + encodeURIComponent(prefix + "%");
      } else {
        qs += "&event_type=eq." + encodeURIComponent(eventType);
      }
    }
    if (level) qs += "&level=eq." + encodeURIComponent(level);

    const rows = await supaRest(qs);
    res.json({ ok: true, day, events: Array.isArray(rows) ? rows : [] });
  } catch (e) {
    console.error("[ACTIVITY] list error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/activity/insights?day=today|yesterday|YYYY-MM-DD
// Agregados pra header da sidebar.
router.get("/insights", async (req, res) => {
  try {
    const day = normalizeDay(req.query.day);

    // Puxa todos os eventos relevantes do dia. 2000 linhas cobrem qualquer dia
    // realista (hoje fazemos ~100 grupos/dia com ~10 eventos cada).
    const rows = await supaRest(
      "/rest/v1/activity_events?day=eq." + day +
      "&select=event_type,level,session_id,session_label,session_phone,metadata,occurred_at" +
      "&limit=5000&order=occurred_at.asc"
    );
    const events = Array.isArray(rows) ? rows : [];

    // Agregações
    const insights = {
      day,
      totalEvents: events.length,
      groupsCreated: 0,
      groupsFailed: 0,
      groupsRateLimited: 0,
      badRequestFallbacks: 0,
      dmsSent: { client: 0, cx2: 0, escalada: 0 },
      dmsFailed: { client: 0, cx2: 0, escalada: 0 },
      resolveTicketsCalls: 0,
      phonesAdjusted9br: 0,
      phonesNotOnWhatsapp: 0,
      quarantineEnters: 0,
      mostActiveSessions: [], // [{label, phone, count}]
      firstEventAt: events[0] ? events[0].occurred_at : null,
      lastEventAt: events.length > 0 ? events[events.length - 1].occurred_at : null,
    };

    const sessionCounts = new Map(); // session_id -> {label, phone, count}
    for (const ev of events) {
      const t = ev.event_type;
      if (t === "group_create:success") insights.groupsCreated++;
      else if (t === "group_create:failed") insights.groupsFailed++;
      else if (t === "group_create:rate_limit") insights.groupsRateLimited++;
      else if (t === "group_create:bad_request_fallback") insights.badRequestFallbacks++;
      else if (t === "resolve_tickets") insights.resolveTicketsCalls++;
      else if (t === "phone_validation:adjusted_9_br") insights.phonesAdjusted9br++;
      else if (t === "phone_validation:not_on_whatsapp") insights.phonesNotOnWhatsapp++;
      else if (t === "session:quarantine_enter") insights.quarantineEnters++;

      // DM metrics via metadata do group_create:success
      if (t === "group_create:success" && ev.metadata) {
        if (ev.metadata.clientDmSent === true) insights.dmsSent.client++;
        if (ev.metadata.clientDmSent === false) insights.dmsFailed.client++;
        if (ev.metadata.cx2DmSent === true) insights.dmsSent.cx2++;
        if (ev.metadata.cx2DmSent === false) insights.dmsFailed.cx2++;
        if (ev.metadata.escaladaDmSent === true) insights.dmsSent.escalada++;
        if (ev.metadata.escaladaDmSent === false) insights.dmsFailed.escalada++;
      }

      // Contagem por sessão — só eventos "ativos"
      if (ev.session_id && (t === "group_create:success" || t === "group_create:failed" || t === "group_create:rate_limit")) {
        const k = ev.session_id;
        if (!sessionCounts.has(k)) {
          sessionCounts.set(k, { sessionId: k, label: ev.session_label, phone: ev.session_phone, created: 0, failed: 0, rateLimited: 0 });
        }
        const c = sessionCounts.get(k);
        if (t === "group_create:success") c.created++;
        else if (t === "group_create:failed") c.failed++;
        else c.rateLimited++;
      }
    }

    insights.mostActiveSessions = Array.from(sessionCounts.values())
      .sort((a, b) => (b.created + b.failed + b.rateLimited) - (a.created + a.failed + a.rateLimited))
      .slice(0, 5);

    res.json({ ok: true, insights });
  } catch (e) {
    console.error("[ACTIVITY] insights error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
