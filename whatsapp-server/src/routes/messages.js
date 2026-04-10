// ===== Message routes =====
const express = require("express");
const router = express.Router();
const { supaRest } = require("../services/supabase");
const baileys = require("../services/baileys");

// POST /api/messages/send — Send a message
router.post("/send", async (req, res) => {
  try {
    const { sessionId, to, text, image, caption } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId é obrigatório" });
    if (!to) return res.status(400).json({ error: "Destinatário (to) é obrigatório" });
    if (!text && !image) return res.status(400).json({ error: "text ou image é obrigatório" });

    const content = image ? { image, caption } : { text };
    await baileys.sendMessage(sessionId, to, content);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/messages/:sessionId — Get recent messages for a session
router.get("/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { chatJid, limit = 50 } = req.query;

    let path = "/rest/v1/wa_messages?session_id=eq." + sessionId +
      "&order=timestamp.desc&limit=" + Math.min(parseInt(limit), 200) +
      "&select=id,message_id,chat_jid,chat_name,from_me,sender_name,body,media_type,timestamp";

    if (chatJid) path += "&chat_jid=eq." + encodeURIComponent(chatJid);

    const messages = await supaRest(path);
    res.json(messages || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/messages/:sessionId/chats — Get chat list (distinct chats)
router.get("/:sessionId/chats", async (req, res) => {
  try {
    const { sessionId } = req.params;
    // Get distinct chats with last message
    const chats = await supaRest(
      "/rest/v1/rpc/get_wa_chats",
      "POST",
      { p_session_id: sessionId }
    );
    res.json(chats || []);
  } catch (e) {
    // Fallback: simple distinct query
    try {
      const messages = await supaRest(
        "/rest/v1/wa_messages?session_id=eq." + req.params.sessionId +
        "&select=chat_jid,chat_name,from_me,body,timestamp" +
        "&order=timestamp.desc&limit=500"
      );
      // Group by chat_jid, take latest
      const chatMap = {};
      for (const m of (messages || [])) {
        if (!chatMap[m.chat_jid]) {
          chatMap[m.chat_jid] = {
            chatJid: m.chat_jid,
            chatName: m.chat_name || m.chat_jid,
            lastMessage: m.body || "",
            lastTimestamp: m.timestamp,
            fromMe: m.from_me,
          };
        }
      }
      res.json(Object.values(chatMap));
    } catch (e2) {
      res.status(500).json({ error: e2.message });
    }
  }
});

module.exports = router;
