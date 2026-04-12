// ===== Contact routes =====
const express = require("express");
const router = express.Router();
const baileys = require("../services/baileys");

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
