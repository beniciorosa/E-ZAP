// ===== DHIEGO.AI — Entrypoint =====
// Hooked into baileys.js `handleIncomingMessage`. For each incoming message,
// decides whether this is a command for the assistant:
//
//   1. Is DHIEGO.AI enabled in app_settings?
//   2. Is the message on the configured assistant session?
//   3. Is the sender authorized (fromMe OR phone in allowlist)?
//
// If all yes → extract text → route → execute tool → reply via sock.sendMessage.
// If any no → silently ignore (return false so baileys continues normal flow).
//
// This function is idempotent: baileys.js already persists every message to
// wa_messages. Nothing here writes to wa_messages.

const { loadConfig } = require("./dhiego-ai/config");
const { routeIntent } = require("./dhiego-ai/router");
const ideasTool = require("./dhiego-ai/tools/ideas");
const ideasPdfTool = require("./dhiego-ai/tools/ideas-pdf");
const freeformTool = require("./dhiego-ai/tools/llm-freeform");
const { supaRest } = require("./supabase");

// Extracts plain text from a Baileys message. Returns empty string if the
// message has no readable text (stickers, media without caption, etc).
function extractText(msg) {
  const m = msg.message || {};
  return m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || "";
}

// Normalizes a JID to a bare phone string (digits only), matching how the
// allowlist stores phones. "5511999@s.whatsapp.net" -> "5511999"
function jidToPhone(jid) {
  if (!jid) return "";
  return String(jid).split(":")[0].split("@")[0].replace(/\D/g, "");
}

async function resolveUserIdForSession(sessionId) {
  const rows = await supaRest(
    "/rest/v1/wa_sessions?id=eq." + encodeURIComponent(sessionId) + "&select=user_id&limit=1"
  ).catch(() => []);
  return (rows && rows[0] && rows[0].user_id) || null;
}

// Main entry called from baileys.js. Returns true if the message was handled,
// false if it was ignored/not for the assistant.
async function maybeHandle(sessionId, msg, sock) {
  try {
    const cfg = await loadConfig();
    if (!cfg.enabled) return false;
    if (!cfg.sessionId || cfg.sessionId !== sessionId) return false;

    const chatJid = msg.key?.remoteJid;
    if (!chatJid || chatJid === "status@broadcast") return false;

    // Authorization: fromMe (user talking to himself) OR sender phone in allowlist
    const isFromMe = !!msg.key?.fromMe;
    const senderJid = msg.key?.participant || chatJid;
    const senderPhone = jidToPhone(senderJid);
    const isAllowed = isFromMe
      || (cfg.authorizedPhones && cfg.authorizedPhones.includes(senderPhone));
    if (!isAllowed) return false;

    // Must have readable text (Phase 1 — audio in Phase 2)
    const text = extractText(msg);
    if (!text || !text.trim()) {
      console.log("[DHIEGO.AI] ignoring empty/non-text message from", senderPhone);
      return false;
    }

    console.log("[DHIEGO.AI] Processing message from", senderPhone, "text:", text.slice(0, 80));

    // Route the intent
    const intent = await routeIntent(text).catch(e => {
      console.error("[DHIEGO.AI] routeIntent error:", e.message);
      return { tool: "llm-freeform", args: {} };
    });

    // Need user_id for the ideas tools (they're per-user)
    const userId = await resolveUserIdForSession(sessionId);
    if (!userId && intent.tool.startsWith("ideas-")) {
      await sock.sendMessage(chatJid, {
        text: "⚠️ Sessão DHIEGO.AI não está vinculada a um user_id. Configure no admin.html.",
      });
      return true;
    }

    const ctx = {
      userId,
      sessionId,
      sourceMessageId: msg.key?.id || null,
      sourcePhone: senderPhone,
    };

    // Dispatch
    let result;
    try {
      result = await dispatch(intent, ctx, text);
    } catch (e) {
      console.error("[DHIEGO.AI] tool execution error:", e);
      result = { ok: false, reply: "⚠️ Erro ao executar: " + e.message };
    }

    // Send reply
    if (result && result.document) {
      // PDF / file attachment
      await sock.sendMessage(chatJid, {
        document: result.document.buffer,
        fileName: result.document.filename,
        mimetype: result.document.mimetype || "application/pdf",
        caption: result.reply || undefined,
      });
    } else if (result && result.reply) {
      await sock.sendMessage(chatJid, { text: result.reply });
    } else {
      await sock.sendMessage(chatJid, { text: "⚠️ Comando não produziu resposta." });
    }
    return true;
  } catch (e) {
    console.error("[DHIEGO.AI] maybeHandle fatal:", e);
    return false;
  }
}

async function dispatch(intent, ctx, originalText) {
  switch (intent.tool) {
    case "ideas-add": {
      return ideasTool.addIdea({
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        text: intent.args?.text || "",
        sourceMessageId: ctx.sourceMessageId,
      });
    }
    case "ideas-list": {
      return ideasTool.listIdeas({
        userId: ctx.userId,
        status: intent.args?.status || "open",
      });
    }
    case "ideas-complete": {
      return ideasTool.completeIdea({
        userId: ctx.userId,
        ideaId: intent.args?.ideaId,
      });
    }
    case "ideas-cancel": {
      return ideasTool.cancelIdea({
        userId: ctx.userId,
        ideaId: intent.args?.ideaId,
      });
    }
    case "ideas-pdf": {
      const { buffer, filename } = await ideasPdfTool.generateIdeasPdf({
        userId: ctx.userId,
        status: intent.args?.status || "all",
      });
      return {
        ok: true,
        reply: "📄 Segue o backlog de ideias.",
        document: { buffer, filename, mimetype: "application/pdf" },
      };
    }
    case "llm-freeform":
    default: {
      return freeformTool.answerFreeform({ text: originalText });
    }
  }
}

module.exports = { maybeHandle };
