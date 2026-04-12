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
    const { chatJid, limit = 50, before, after } = req.query;

    let path = "/rest/v1/wa_messages?session_id=eq." + sessionId +
      "&order=timestamp.desc&limit=" + Math.min(parseInt(limit), 200) +
      "&select=id,message_id,chat_jid,chat_name,from_me,sender_name,sender_jid,body,media_type,media_url,timestamp";

    if (chatJid) path += "&chat_jid=eq." + encodeURIComponent(chatJid);
    if (before) path += "&timestamp=lt." + encodeURIComponent(before);
    if (after) path += "&timestamp=gt." + encodeURIComponent(after);

    const messages = await supaRest(path);
    res.json(messages || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/messages/:sessionId/chats — Get chat list (synced chats + messages)
router.get("/:sessionId/chats", async (req, res) => {
  try {
    const { sessionId } = req.params;

    // 1. Get synced chats from wa_chats table (from history sync)
    const syncedChats = await supaRest(
      "/rest/v1/wa_chats?session_id=eq." + sessionId +
      "&select=chat_jid,chat_name,unread_count,is_group,last_message_timestamp,pinned,archived" +
      "&archived=eq.false&order=last_message_timestamp.desc.nullslast&limit=500"
    ).catch(() => []);

    // 2. Get latest message per chat from wa_messages
    const messages = await supaRest(
      "/rest/v1/wa_messages?session_id=eq." + sessionId +
      "&select=chat_jid,chat_name,from_me,body,media_type,timestamp" +
      "&order=timestamp.desc&limit=1000"
    ).catch(() => []);

    // Build combined map: wa_chats as base, enriched with latest message
    const chatMap = {};

    // Start with synced chats
    for (const c of (syncedChats || [])) {
      chatMap[c.chat_jid] = {
        chatJid: c.chat_jid,
        chatName: c.chat_name || c.chat_jid.split("@")[0],
        lastMessage: "",
        lastTimestamp: c.last_message_timestamp,
        fromMe: false,
        unreadCount: c.unread_count || 0,
        isGroup: c.is_group || false,
        pinned: c.pinned || false,
      };
    }

    // Enrich with message data (latest message text + better names)
    for (const m of (messages || [])) {
      if (!chatMap[m.chat_jid]) {
        chatMap[m.chat_jid] = {
          chatJid: m.chat_jid,
          chatName: m.chat_name || m.chat_jid.split("@")[0],
          lastMessage: m.body || (m.media_type ? "[" + m.media_type + "]" : ""),
          lastTimestamp: m.timestamp,
          fromMe: m.from_me,
          unreadCount: 0,
          isGroup: m.chat_jid.endsWith("@g.us"),
          pinned: false,
        };
      } else {
        const existing = chatMap[m.chat_jid];
        // Add latest message text if missing
        if (!existing.lastMessage) {
          existing.lastMessage = m.body || (m.media_type ? "[" + m.media_type + "]" : "");
          existing.fromMe = m.from_me;
        }
        // Use better name if available
        if (m.chat_name && m.chat_name !== m.chat_jid.split("@")[0] && /^\d+$/.test(existing.chatName)) {
          existing.chatName = m.chat_name;
        }
        // Use latest timestamp
        if (m.timestamp && (!existing.lastTimestamp || new Date(m.timestamp) > new Date(existing.lastTimestamp))) {
          existing.lastTimestamp = m.timestamp;
        }
      }
    }

    // Sort: pinned first, then by timestamp desc
    const result = Object.values(chatMap).sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0);
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/messages/:sessionId/resync — Force reconnect to trigger history sync
router.post("/:sessionId/resync", async (req, res) => {
  try {
    const { sessionId } = req.params;
    // Disconnect and reconnect to trigger a fresh history sync
    await baileys.stopSession(sessionId);
    // Fetch creds and restart
    const rows = await supaRest("/rest/v1/wa_sessions?id=eq." + sessionId + "&select=creds");
    const creds = rows && rows.length > 0 ? rows[0].creds : null;
    await baileys.startSession(sessionId, creds);
    res.json({ ok: true, message: "Re-sincronização iniciada. Aguarde alguns segundos." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
