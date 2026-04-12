// ===== Contact routes =====
const express = require("express");
const router = express.Router();
const baileys = require("../services/baileys");
const { supaRest } = require("../services/supabase");

// GET /api/contacts/:sessionId — List all contacts with photos
router.get("/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { q, limit = 100, offset = 0 } = req.query;

    let path = "/rest/v1/wa_contacts?session_id=eq." + sessionId +
      "&select=contact_jid,name,push_name,phone,is_group,is_business,photo_url,synced_at" +
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

// POST /api/contacts/:sessionId/photos/refresh — Force re-download photos
router.post("/:sessionId/photos/refresh", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { jids } = req.body || {};

    if (jids && jids.length > 0) {
      // Reset specific JIDs
      for (const jid of jids) {
        await supaRest(
          "/rest/v1/wa_photo_queue?session_id=eq." + sessionId + "&jid=eq." + encodeURIComponent(jid),
          "PATCH", { status: "pending", attempts: 0, error: null }, "return=minimal"
        ).catch(() => {});
      }
      res.json({ ok: true, refreshed: jids.length });
    } else {
      // Reset ALL non-done items
      await supaRest(
        "/rest/v1/wa_photo_queue?session_id=eq." + sessionId + "&status=neq.done",
        "PATCH", { status: "pending", attempts: 0, error: null }, "return=minimal"
      ).catch(() => {});
      res.json({ ok: true, refreshed: "all" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/contacts/:sessionId/profile-pic?jid=xxx — Proxy profile picture
router.get("/:sessionId/profile-pic", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { jid } = req.query;
    if (!jid) return res.status(400).json({ error: "jid é obrigatório" });

    const url = await baileys.getProfilePicture(sessionId, jid);
    if (!url) return res.status(404).json({ error: "Sem foto de perfil" });

    // Proxy the image from WhatsApp CDN (bypasses CORS)
    const response = await fetch(url);
    if (!response.ok) return res.status(404).json({ error: "Imagem não encontrada" });

    res.set("Content-Type", response.headers.get("content-type") || "image/jpeg");
    res.set("Cache-Control", "public, max-age=600"); // 10 min cache
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
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

    const ok = await baileys.readChatMessages(sessionId, chatJid);
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
