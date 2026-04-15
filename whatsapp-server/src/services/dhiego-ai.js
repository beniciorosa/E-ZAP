// ===== DHIEGO.AI — Entrypoint =====
// Hooked into baileys.js `handleIncomingMessage`. For each incoming message,
// decides whether this is a command for the assistant:
//
//   1. Is DHIEGO.AI enabled in app_settings?
//   2. Is the message on the configured assistant session?
//   3. Is the sender authorized (fromMe OR phone in allowlist)?
//
// If all yes → extract text (transcribe audio if needed) → save user turn →
// route → execute tool → save assistant turn → reply via sock.sendMessage.
// If any no → silently ignore (return false so baileys continues normal flow).
//
// Persistent memory lives in dhiego_conversations; every turn (user +
// assistant) is stored so the freeform LLM can load recent context.

const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const { loadConfig } = require("./dhiego-ai/config");
const { routeIntent } = require("./dhiego-ai/router");
const { loadRecentTurns, saveTurn } = require("./dhiego-ai/history");
const { transcribeAudio } = require("./dhiego-ai/transcribe");
const ideasTool = require("./dhiego-ai/tools/ideas");
const ideasPdfTool = require("./dhiego-ai/tools/ideas-pdf");
const freeformTool = require("./dhiego-ai/tools/llm-freeform");
const { supaRest } = require("./supabase");

// Unwrap common Baileys message envelopes. When a message is sent between
// the user's own linked devices (e.g. iPhone -> our baileys linked device,
// or "Message yourself"), it often comes wrapped in deviceSentMessage. Same
// for ephemeral chats and view-once. Unwrap recursively until we hit the
// actual content.
function unwrapMessage(m) {
  if (!m) return m;
  if (m.deviceSentMessage && m.deviceSentMessage.message) return unwrapMessage(m.deviceSentMessage.message);
  if (m.ephemeralMessage && m.ephemeralMessage.message) return unwrapMessage(m.ephemeralMessage.message);
  if (m.viewOnceMessage && m.viewOnceMessage.message) return unwrapMessage(m.viewOnceMessage.message);
  if (m.viewOnceMessageV2 && m.viewOnceMessageV2.message) return unwrapMessage(m.viewOnceMessageV2.message);
  if (m.viewOnceMessageV2Extension && m.viewOnceMessageV2Extension.message) return unwrapMessage(m.viewOnceMessageV2Extension.message);
  if (m.documentWithCaptionMessage && m.documentWithCaptionMessage.message) return unwrapMessage(m.documentWithCaptionMessage.message);
  return m;
}

// Extracts plain text from a Baileys message. Returns empty string if the
// message is audio-only or has no readable content — audio is handled
// separately via extractTextOrTranscribe.
function extractText(msg) {
  const m = unwrapMessage(msg.message) || {};
  return m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || "";
}

// Returns { text, wasTranscribed }. Text priority:
// 1. Normal text (conversation, extendedText, captions)
// 2. Audio → download + Whisper transcription
// 3. Empty string if neither
async function extractTextOrTranscribe(msg, sock) {
  const plain = extractText(msg);
  if (plain && plain.trim()) return { text: plain, wasTranscribed: false };

  const m = msg.message || {};
  const audio = m.audioMessage;
  if (!audio) return { text: "", wasTranscribed: false };

  console.log("[DHIEGO.AI] Received audio message — downloading + transcribing");
  try {
    const buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { reuploadRequest: sock.updateMediaMessage }
    );
    const mimetype = audio.mimetype || "audio/ogg";
    const transcribed = await transcribeAudio(buffer, mimetype);
    console.log("[DHIEGO.AI] Transcription:", transcribed.slice(0, 120));
    return { text: transcribed, wasTranscribed: true };
  } catch (e) {
    console.error("[DHIEGO.AI] audio transcription failed:", e.message);
    return { text: "", wasTranscribed: false, error: e.message };
  }
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

    // Self-chat mode: when the bot session is the user's OWN primary WhatsApp
    // number, we only want to react to "Message yourself" — not to every
    // fromMe message the user sends to clients, friends, etc. If the chat is
    // with the bot's own JID, it's a self-message and we proceed. Everything
    // else gets ignored.
    //
    // This is the recommended mode for users who don't have a dedicated
    // burner phone for the assistant: messaging yourself avoids all the
    // Signal cross-device issues that plague the linked-device approach.
    const ownJid = sock.user?.id || "";
    const ownPhone = jidToPhone(ownJid);
    const chatPhone = jidToPhone(chatJid);
    const isSelfChat = ownPhone && chatPhone === ownPhone;

    // Authorization rules (kept strict to avoid hijacking real conversations):
    //   - fromMe messages are ONLY handled when the chat is the bot's own JID
    //     (WhatsApp "Message yourself"). If the user types to a client or
    //     friend, those fromMe messages are ignored — even though fromMe is
    //     technically "our" message, it's not a command to the bot.
    //   - Incoming (not-fromMe) messages are handled when the sender's phone
    //     is in the authorized allowlist (allows another person like a
    //     partner or admin to command the bot from a different number).
    const isFromMe = !!msg.key?.fromMe;
    const senderJid = msg.key?.participant || chatJid;
    const senderPhone = jidToPhone(senderJid);
    const isInAllowlist =
      cfg.authorizedPhones && cfg.authorizedPhones.includes(senderPhone);

    let isAllowed = false;
    if (isFromMe) {
      // Only allow if the conversation IS the self-chat. Typing to anyone
      // else never triggers the bot.
      isAllowed = isSelfChat;
    } else {
      // Incoming from another number — must be explicitly allowed.
      isAllowed = isInAllowlist;
    }
    if (!isAllowed) return false;

    // Resolve user_id first — all turns must be tagged with it and saveTurn
    // requires a valid userId.
    const userId = await resolveUserIdForSession(sessionId);
    if (!userId) {
      await sock.sendMessage(chatJid, {
        text: "⚠️ Sessão DHIEGO.AI não está vinculada a um user_id. Configure no admin.html.",
      });
      return true;
    }

    const ctx = {
      userId,
      sessionId,
      chatJid,
      sourceMessageId: msg.key?.id || null,
      sourcePhone: senderPhone,
    };

    // Extract text (or transcribe audio). If we still have nothing, tell the
    // user we need text or a voice note.
    const { text, wasTranscribed, error: audioErr } =
      await extractTextOrTranscribe(msg, sock);

    if (!text || !text.trim()) {
      if (audioErr) {
        await sock.sendMessage(chatJid, {
          text: "⚠️ Não consegui transcrever o áudio: " + audioErr,
        });
        return true;
      }
      console.log("[DHIEGO.AI] ignoring empty/non-text message from", senderPhone);
      return false;
    }

    console.log(
      "[DHIEGO.AI] Processing message from", senderPhone,
      wasTranscribed ? "(transcribed) " : "",
      "text:", text.slice(0, 80)
    );

    // Save the user turn BEFORE routing so the history reflects the
    // conversation order even if the tool fails below.
    await saveTurn(ctx, "user", text, wasTranscribed ? "audio" : null);

    // Route the intent
    const intent = await routeIntent(text).catch(e => {
      console.error("[DHIEGO.AI] routeIntent error:", e.message);
      return { tool: "llm-freeform", args: {} };
    });

    // Dispatch
    let result;
    try {
      result = await dispatch(intent, ctx, text);
    } catch (e) {
      console.error("[DHIEGO.AI] tool execution error:", e);
      result = { ok: false, reply: "⚠️ Erro ao executar: " + e.message };
    }

    // Send reply
    let replyText = result && result.reply ? result.reply : "⚠️ Comando não produziu resposta.";
    if (result && result.document) {
      await sock.sendMessage(chatJid, {
        document: result.document.buffer,
        fileName: result.document.filename,
        mimetype: result.document.mimetype || "application/pdf",
        caption: result.reply || undefined,
      });
    } else {
      await sock.sendMessage(chatJid, { text: replyText });
    }

    // Save the assistant turn so the next message has full context.
    await saveTurn(ctx, "assistant", replyText, intent.tool);
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
      return freeformTool.answerFreeform({ text: originalText, ctx });
    }
  }
}

module.exports = { maybeHandle };
