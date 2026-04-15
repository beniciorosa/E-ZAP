// ===== Contact routes =====
const express = require("express");
const router = express.Router();
const baileys = require("../services/baileys");
const { supaRest } = require("../services/supabase");

// GET /api/contacts/:sessionId — List all contacts
router.get("/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { q, limit = 100, offset = 0 } = req.query;

    let path = "/rest/v1/wa_contacts?session_id=eq." + sessionId +
      "&select=contact_jid,name,push_name,phone,is_group,is_business,synced_at" +
      "&order=synced_at.desc" +
      "&limit=" + Math.min(parseInt(limit), 500) +
      "&offset=" + parseInt(offset);

    if (q) {
      // Search by name, push_name, or phone
      path += "&or=(name.ilike.*" + encodeURIComponent(q) + "*,push_name.ilike.*" + encodeURIComponent(q) + "*,phone.ilike.*" + encodeURIComponent(q) + "*)";
    }

    const contacts = await supaRest(path);
    res.json(contacts || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/contacts/:sessionId/read — Mark chat as read
router.post("/:sessionId/read", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { chatJid } = req.body;
    if (!chatJid) return res.status(400).json({ error: "chatJid é obrigatório" });
    if (baileys.isQuarantined(sessionId)) {
      return res.status(409).json({ error: "Sessão em quarentena — tente novamente após liberar" });
    }

    const ok = await baileys.readChatMessages(sessionId, chatJid);
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/contacts/:sessionId/group-info?jid=xxx — Get group metadata
router.get("/:sessionId/group-info", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { jid } = req.query;
    if (!jid) return res.status(400).json({ error: "jid é obrigatório" });
    if (!jid.endsWith("@g.us")) return res.status(400).json({ error: "JID não é um grupo" });
    if (baileys.isQuarantined(sessionId)) {
      return res.status(409).json({ error: "Sessão em quarentena — tente novamente após liberar" });
    }

    const info = await baileys.getGroupInfo(sessionId, jid);
    if (!info) return res.status(404).json({ error: "Grupo não encontrado" });
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
