// ===== vCard Routes =====
// Feature "📇 VCard" — manda lista de nome+telefone pro self-chat de cada
// mentor. Objetivo: mentor salva os clientes na agenda ANTES de criar grupos,
// evitando `bad-request` no groupCreate (cliente não-contato do criador).
//
// Por que texto e não vCard real: WhatsApp não permite compartilhar contato
// que o remetente NÃO tem na agenda. Texto com "Nome | +55 DDD 9XXXX-XXXX"
// é auto-detectado pelo WhatsApp e vira link clicável → mentor toca →
// "Adicionar aos contatos".
//
// Self-chat: sendMessage(sock.user.id, ...) manda pro próprio JID.
// Aparece em todos os devices do mentor.

const express = require("express");
const router = express.Router();
const { supaRest } = require("../services/supabase");
const { logEvent } = require("../services/activity-log");

// Lazy load pra evitar ciclo
let baileysRef = null;
function _getBaileys() {
  if (!baileysRef) baileysRef = require("../services/baileys");
  return baileysRef;
}

// Formata dígitos BR num padrão legível que WhatsApp auto-detecta como link:
//   551198947-3088  →  +55 11 98947-3088 (13 dígitos, com "9" mobile)
//   5511989473088   →  +55 11 8947-3088  (12 dígitos, sem "9")
function formatBrPhone(digits) {
  const d = String(digits || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 13 && d.startsWith("55")) {
    return "+55 " + d.slice(2, 4) + " " + d.slice(4, 9) + "-" + d.slice(9);
  }
  if (d.length === 12 && d.startsWith("55")) {
    return "+55 " + d.slice(2, 4) + " " + d.slice(4, 8) + "-" + d.slice(8);
  }
  // Fallback genérico
  return "+" + d;
}

// Monta texto da mensagem single pro mentor com N clientes.
function buildMessageText(clients) {
  const lines = [];
  const header = clients.length === 1
    ? "📇 1 novo contato pra adicionar na sua agenda:"
    : "📇 " + clients.length + " novos contatos pra adicionar na sua agenda:";
  lines.push(header);
  lines.push("");
  for (const c of clients) {
    const name = String(c.name || "Cliente").replace(/[\r\n|]/g, " ").trim() || "Cliente";
    const phone = formatBrPhone(c.phone);
    lines.push(name + " | " + phone);
    lines.push(""); // linha em branco entre contatos
  }
  lines.push("💡 Toque no número pra salvar na sua agenda (chegue no grupo antes de criar).");
  return lines.join("\n");
}

// POST /api/vcard/send-batch
// Body: { groups: [{ mentorSessionId, clients: [{phone, name, ticketId, resolvedJid}] }] }
// Executa 1 sendMessage por mentor (self-chat) com todos os contatos agrupados.
// Persiste em vcard_sent_registry pra evitar duplicata futura.
router.post("/send-batch", async (req, res) => {
  try {
    const groups = Array.isArray(req.body && req.body.groups) ? req.body.groups : [];
    if (!groups.length) {
      return res.status(400).json({ error: "groups (array) é obrigatório" });
    }

    const baileys = _getBaileys();
    const results = [];

    for (const group of groups) {
      const mentorSessionId = group.mentorSessionId;
      const rawClients = Array.isArray(group.clients) ? group.clients : [];
      if (!mentorSessionId || rawClients.length === 0) continue;

      // Filtra clientes válidos (precisa de name + phone)
      const clients = rawClients.filter(c => c && c.phone && c.name);
      if (clients.length === 0) {
        results.push({ mentorSessionId, status: "no_valid_clients", count: 0 });
        continue;
      }

      // Pega sock da sessão do mentor
      const mentorSess = baileys.getSession(mentorSessionId);
      if (!mentorSess || mentorSess.status !== "connected" || !mentorSess.sock) {
        results.push({ mentorSessionId, status: "session_offline", count: 0 });
        logEvent({
          type: "vcard:failed",
          level: "warn",
          message: "Sessão do mentor offline — vCards não enviados",
          sessionId: mentorSessionId,
          metadata: { clientCount: clients.length, reason: "session_offline" },
        });
        continue;
      }

      const sock = mentorSess.sock;
      const selfJid = sock.user && sock.user.id;
      if (!selfJid) {
        results.push({ mentorSessionId, status: "no_jid", count: 0 });
        continue;
      }

      // Canoniza o JID do próprio mentor pra self-chat.
      // sock.user.id pode vir como "551198...:42@s.whatsapp.net" com device suffix;
      // pra self-chat é melhor usar só o número puro.
      const selfDigits = String(selfJid).split(":")[0].split("@")[0].replace(/\D/g, "");
      const selfChatJid = selfDigits + "@s.whatsapp.net";

      // Monta texto
      const text = buildMessageText(clients);

      // Envia
      try {
        await sock.sendMessage(selfChatJid, { text });

        // Persiste no registry — 1 row por cliente, UNIQUE previne dup
        const rows = clients.map(c => ({
          mentor_session_id: mentorSessionId,
          client_phone: String(c.phone || "").replace(/\D/g, ""),
          client_name: c.name || null,
          ticket_id: c.ticketId || null,
          resolved_jid: c.resolvedJid || null,
          status: "sent",
        }));
        try {
          await supaRest(
            "/rest/v1/vcard_sent_registry?on_conflict=mentor_session_id,client_phone",
            "POST",
            rows,
            "resolution=merge-duplicates,return=minimal"
          );
        } catch (dbErr) {
          console.warn("[VCARD] registry upsert failed:", dbErr.message);
        }

        results.push({ mentorSessionId, status: "sent", count: clients.length });
        logEvent({
          type: "vcard:sent",
          level: "info",
          message: clients.length + " contato(s) enviado(s) pra self-chat de " + (mentorSess.label || selfDigits),
          sessionId: mentorSessionId,
          sessionLabel: mentorSess.label || null,
          sessionPhone: mentorSess.phone || null,
          metadata: {
            count: clients.length,
            phones: clients.map(c => String(c.phone).replace(/\D/g, "")),
            names: clients.map(c => c.name),
          },
        });
      } catch (sendErr) {
        results.push({ mentorSessionId, status: "send_failed", count: 0, error: sendErr.message });
        logEvent({
          type: "vcard:failed",
          level: "error",
          message: "Falha ao enviar contatos pra self-chat: " + sendErr.message,
          sessionId: mentorSessionId,
          sessionLabel: mentorSess.label || null,
          metadata: { count: clients.length, error: sendErr.message },
        });
      }

      // Pequeno delay entre mentores pra não martelar
      await new Promise(r => setTimeout(r, 800));
    }

    res.json({ ok: true, results });
  } catch (e) {
    console.error("[VCARD] send-batch error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/vcard/registry?mentor_session_id=&phones=phone1,phone2
// Retorna quais phones já foram enviados pro mentor. Usado pelo frontend
// opcionalmente pra cruzar com listas arbitrárias.
router.get("/registry", async (req, res) => {
  try {
    const mentorId = req.query.mentor_session_id;
    const phonesCsv = req.query.phones || "";
    if (!mentorId) return res.status(400).json({ error: "mentor_session_id obrigatório" });
    const phones = String(phonesCsv).split(",").map(p => p.replace(/\D/g, "")).filter(Boolean);
    if (phones.length === 0) return res.json({ ok: true, sent: [] });
    const rows = await supaRest(
      "/rest/v1/vcard_sent_registry?mentor_session_id=eq." + encodeURIComponent(mentorId) +
      "&client_phone=in.(" + phones.map(p => '"' + p + '"').join(",") + ")" +
      "&select=client_phone,client_name,sent_at,status"
    );
    res.json({ ok: true, sent: Array.isArray(rows) ? rows : [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
