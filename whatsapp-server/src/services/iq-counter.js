// ===== IQ Counter =====
// Conta IQs (XMPP info/query stanzas) que cada sessão Baileys emite em runtime.
// Implementação: monkey-patch em sock.query (feito no baileys.js startSession).
// Dados in-memory (Map por sessionId) — zeram em pm2 restart. Historical
// persistido via logEvent({type: "iq:snapshot"}) a cada 5 min (ver startSnapshotLoop).
//
// Por que fazer: anti-spam do WhatsApp conta IQs. Saber quantos IQs uma sessão
// emitiu, de que tipo, nos últimos X segundos permite:
//  1. Correlacionar rate-limit events com contagem de IQ no momento
//     (ex: "Maylon bateu rate-limit no IQ 47 da janela de 1h")
//  2. Monitorar budget remanescente por sessão (badge ⚡ 47 IQs/h no card)
//  3. Calibração empírica das hipóteses em _insights.md com dados duros
//
// Não conta: message stanzas (sendMessage), presence, acks. Só IQs via sock.query.

// Map<sessionId, { iqByType, total, events, firstAt, lastAt }>
// events é sliding window — mantém só últimos 1h pra métrica lastHour.
const counters = new Map();

// Metadata opcional da sessão (label, phone) pra enriquecer stats response.
// Atualizado via setMeta quando sessão conecta com label/phone conhecidos.
function setMeta(sessionId, label, phone) {
  const c = getOrInit(sessionId);
  if (label) c.label = label;
  if (phone) c.phone = phone;
}

function getOrInit(sessionId) {
  if (!counters.has(sessionId)) {
    counters.set(sessionId, {
      sessionId,
      label: null,
      phone: null,
      iqByType: {},
      total: 0,
      events: [],          // [{ ts: ms, type: string }]
      firstAt: null,
      lastAt: null,
    });
  }
  return counters.get(sessionId);
}

const WINDOW_MS = 60 * 60 * 1000; // 1h sliding window

// Chamado pelo monkey-patch em sock.query. Type classificado previamente.
function recordIq(sessionId, type) {
  if (!sessionId || !type) return;
  const c = getOrInit(sessionId);
  const now = Date.now();

  c.iqByType[type] = (c.iqByType[type] || 0) + 1;
  c.total++;
  c.events.push({ ts: now, type });

  // Trim window — evita memória crescer indefinidamente
  const cutoff = now - WINDOW_MS;
  while (c.events.length > 0 && c.events[0].ts < cutoff) {
    c.events.shift();
  }

  if (!c.firstAt) c.firstAt = now;
  c.lastAt = now;
}

// Classifica IQ a partir do node enviado ao sock.query.
// Baileys monta nodes tipo {tag: "iq", attrs: {xmlns, type, ...}, content: [...]}.
// O xmlns e tag do first child são a melhor dica do tipo de operação.
function classifyIqNode(node) {
  try {
    if (!node || typeof node !== "object") return "iq_unknown";
    const attrs = node.attrs || {};
    const xmlns = String(attrs.xmlns || "").toLowerCase();
    const content = Array.isArray(node.content) ? node.content : [];
    const firstTag = content[0] && content[0].tag ? String(content[0].tag).toLowerCase() : "";

    // WhatsApp group operations (w:g2)
    if (xmlns === "w:g2") {
      if (firstTag === "create") return "groupCreate";
      if (firstTag === "participants") return "groupParticipantsUpdate";
      if (firstTag === "description") return "groupUpdateDescription";
      if (firstTag === "subject") return "groupUpdateSubject";
      if (firstTag === "locked" || firstTag === "unlocked") return "groupSettingLock";
      if (firstTag === "announcement" || firstTag === "not_announcement") return "groupSettingAnnouncement";
      if (firstTag === "member_add_mode") return "groupMemberAddMode";
      if (firstTag === "invite") return "groupInviteCode";
      if (firstTag === "query") return "groupMetadata";
      if (firstTag === "picture") return "groupPicture";
      return "groupOther";
    }

    // User sync / onWhatsApp
    if (xmlns === "usync" || xmlns === "w:usync") {
      return "onWhatsApp";
    }

    // Profile picture (individual)
    if (xmlns === "w:profile:picture") return "profilePictureUrl";

    // Business info
    if (xmlns === "w:biz") return "businessProfile";

    // Presence subscription
    if (xmlns === "w:chat:presence") return "presenceSubscribe";

    // Passive (connection keep-alive related)
    if (xmlns === "passive") return "passive";

    // Fallback: usa xmlns OR firstTag como label
    if (xmlns) return "iq:" + xmlns;
    if (firstTag) return "iq:" + firstTag;
    return "iq_unknown";
  } catch (_) {
    return "iq_unknown";
  }
}

// Retorna snapshot completo pra 1 sessão. null se sessão sem atividade.
function getStats(sessionId) {
  const c = counters.get(sessionId);
  if (!c) return null;

  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const lastHourEvents = c.events.filter(e => e.ts >= cutoff);

  const lastHourByType = {};
  for (const e of lastHourEvents) {
    lastHourByType[e.type] = (lastHourByType[e.type] || 0) + 1;
  }

  return {
    sessionId,
    label: c.label,
    phone: c.phone,
    total: c.total,                    // acumulado desde pm2 start
    iqByType: { ...c.iqByType },       // acumulado por tipo
    lastHour: lastHourEvents.length,   // IQs na janela de 1h
    lastHourByType,                     // breakdown do lastHour por tipo
    firstAt: c.firstAt ? new Date(c.firstAt).toISOString() : null,
    lastAt: c.lastAt ? new Date(c.lastAt).toISOString() : null,
  };
}

function getAllStats() {
  const out = {};
  for (const [id] of counters) {
    const s = getStats(id);
    if (s) out[id] = s;
  }
  return out;
}

// Reset individual (uso admin — ex: depois de QR novo, começar zerado).
function resetSession(sessionId) {
  counters.delete(sessionId);
}

// Aplica o monkey-patch em sock.query — chamado pelo startSession depois que
// makeWASocket retorna. Preserva `this` e spread de args. Try/catch defensivo
// garante que nunca quebra o fluxo do Baileys se algo inesperado acontecer.
function attachToSock(sessionId, sock) {
  if (!sock || typeof sock.query !== "function") {
    console.warn("[IQ-COUNTER] sock.query não existe — patch pulado pra", sessionId);
    return false;
  }
  // Marca no sock que já está patcheado (evita patch duplo em reconnect, etc)
  if (sock.__iqCounterPatched) return true;
  const origQuery = sock.query.bind(sock);
  sock.query = function patchedQuery(...args) {
    try {
      const node = args[0];
      const type = classifyIqNode(node);
      recordIq(sessionId, type);
    } catch (_) { /* never block */ }
    return origQuery(...args);
  };
  sock.__iqCounterPatched = true;
  return true;
}

// Snapshot loop — a cada 5 min emite 1 evento iq:snapshot por sessão ativa.
// Permite análise histórica posterior mesmo após pm2 restart (dados persistem
// em activity_events). Chamado 1x no index.js após setIO.
let _loopStarted = false;
let _loopInterval = null;
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // 5 min

function startSnapshotLoop(logEventFn) {
  if (_loopStarted) return;
  _loopStarted = true;
  _loopInterval = setInterval(() => {
    try {
      const all = getAllStats();
      for (const [sid, stats] of Object.entries(all)) {
        if (!stats || stats.total === 0) continue;
        // Só emite se houve atividade nos últimos 5 min (lastHour > 0 + lastAt recente)
        const recentActivity = stats.lastAt &&
          (Date.now() - new Date(stats.lastAt).getTime()) < (10 * 60 * 1000);
        if (!recentActivity && stats.lastHour === 0) continue;

        try {
          logEventFn({
            type: "iq:snapshot",
            level: "debug",
            message: "IQ snapshot: " + stats.lastHour + " IQs na última hora (total " + stats.total + ")",
            sessionId: sid,
            sessionLabel: stats.label,
            sessionPhone: stats.phone,
            metadata: {
              total: stats.total,
              lastHour: stats.lastHour,
              iqByType: stats.iqByType,
              lastHourByType: stats.lastHourByType,
            },
          });
        } catch (_) { /* never block */ }
      }
    } catch (e) {
      console.error("[IQ-COUNTER] snapshot loop error:", e.message);
    }
  }, SNAPSHOT_INTERVAL_MS);
}

function stopSnapshotLoop() {
  if (_loopInterval) {
    clearInterval(_loopInterval);
    _loopInterval = null;
  }
  _loopStarted = false;
}

module.exports = {
  recordIq,
  classifyIqNode,
  getStats,
  getAllStats,
  resetSession,
  setMeta,
  attachToSock,
  startSnapshotLoop,
  stopSnapshotLoop,
};
