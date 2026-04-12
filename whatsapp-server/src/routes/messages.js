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
      "&select=id,message_id,chat_jid,chat_name,from_me,sender_name,sender_jid,body,media_type,media_url,timestamp,is_deleted,is_edited,status";

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

    const { archived: showArchived } = req.query;

    // 1. Get synced chats from wa_chats table (from history sync)
    let chatFilter = "&order=last_message_timestamp.desc.nullslast&limit=500";
    if (showArchived === "true") {
      chatFilter = "&archived=eq.true" + chatFilter;
    } else if (showArchived === "false") {
      chatFilter = "&archived=eq.false" + chatFilter;
    }
    // If no archived param, return all chats

    const syncedChats = await supaRest(
      "/rest/v1/wa_chats?session_id=eq." + sessionId +
      "&select=chat_jid,chat_name,unread_count,is_group,last_message_timestamp,pinned,archived,photo_url,description,participants_count,is_read_only" +
      chatFilter
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
        archived: c.archived || false,
        photoUrl: c.photo_url || null,
        description: c.description || null,
        participantsCount: c.participants_count || null,
        isReadOnly: c.is_read_only || false,
      };
    }

    // 3. Get contact names from wa_contacts (most reliable source for individual chats)
    const contacts = await supaRest(
      "/rest/v1/wa_contacts?session_id=eq." + sessionId +
      "&select=contact_jid,name,push_name" +
      "&limit=2000"
    ).catch(() => []);

    const contactNames = {};
    for (const c of (contacts || [])) {
      if (c.name || c.push_name) {
        contactNames[c.contact_jid] = c.name || c.push_name;
      }
    }

    // Enrich with message data (latest message text) and contact names
    for (const m of (messages || [])) {
      if (!chatMap[m.chat_jid]) {
        // Chat only exists in messages, not in wa_chats
        const isGroup = m.chat_jid.endsWith("@g.us");
        // For individual chats, use contact name; for from_me, DON'T use pushName (it's our name)
        let name = contactNames[m.chat_jid] || "";
        if (!name && !m.from_me) name = m.chat_name || "";
        if (!name) name = m.chat_jid.split("@")[0];

        chatMap[m.chat_jid] = {
          chatJid: m.chat_jid,
          chatName: name,
          lastMessage: m.body || (m.media_type ? "[" + m.media_type + "]" : ""),
          lastTimestamp: m.timestamp,
          fromMe: m.from_me,
          unreadCount: 0,
          isGroup: isGroup,
          pinned: false,
          archived: false,
          photoUrl: null,
        };
      } else {
        const existing = chatMap[m.chat_jid];
        // Add latest message text if missing
        if (!existing.lastMessage) {
          existing.lastMessage = m.body || (m.media_type ? "[" + m.media_type + "]" : "");
          existing.fromMe = m.from_me;
        }
        // Use latest timestamp
        if (m.timestamp && (!existing.lastTimestamp || new Date(m.timestamp) > new Date(existing.lastTimestamp))) {
          existing.lastTimestamp = m.timestamp;
        }
      }
    }

    // Apply contact names as override (most reliable for individual chats)
    for (const jid in chatMap) {
      if (!jid.endsWith("@g.us") && contactNames[jid]) {
        const existing = chatMap[jid];
        // Only override if current name is a phone number or generic
        const phone = jid.split("@")[0];
        if (existing.chatName === phone || /^\d+$/.test(existing.chatName)) {
          existing.chatName = contactNames[jid];
        }
      }
    }

    // Resolve LID-based chats — batch lookup names from wa_contacts/wa_chats
    const lidChats = Object.values(chatMap).filter(c => c.chatJid.endsWith("@lid") && /^\d+$/.test(c.chatName));
    if (lidChats.length > 0) {
      // Single batch query instead of per-LID queries
      const lidJids = lidChats.map(c => c.chatJid);
      try {
        const lidContacts = await supaRest(
          "/rest/v1/wa_contacts?contact_jid=in.(" + lidJids.map(j => encodeURIComponent(j)).join(",") + ")" +
          "&or=(name.not.is.null,push_name.not.is.null)" +
          "&select=contact_jid,name,push_name&limit=500"
        ).catch(() => []);
        const lidNames = {};
        (lidContacts || []).forEach(c => {
          if (c.name || c.push_name) lidNames[c.contact_jid] = c.name || c.push_name;
        });
        // Also check wa_chats for names
        const lidChatNames = await supaRest(
          "/rest/v1/wa_chats?chat_jid=in.(" + lidJids.map(j => encodeURIComponent(j)).join(",") + ")" +
          "&select=chat_jid,chat_name&limit=500"
        ).catch(() => []);
        (lidChatNames || []).forEach(c => {
          const lid = c.chat_jid.split("@")[0];
          if (c.chat_name && c.chat_name !== lid && !lidNames[c.chat_jid]) {
            lidNames[c.chat_jid] = c.chat_name;
          }
        });
        // Apply resolved names
        lidChats.forEach(c => {
          if (lidNames[c.chatJid]) c.chatName = lidNames[c.chatJid];
        });
      } catch(e) {}
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
