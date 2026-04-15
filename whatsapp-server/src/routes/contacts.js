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

// GET /api/contacts/:sessionId/group-info?jid=xxx — Get group metadata
router.get("/:sessionId/group-info", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { jid } = req.query;
    if (!jid) return res.status(400).json({ error: "jid é obrigatório" });
    if (!jid.endsWith("@g.us")) return res.status(400).json({ error: "JID não é um grupo" });

    const info = await baileys.getGroupInfo(sessionId, jid);
    if (!info) return res.status(404).json({ error: "Grupo não encontrado" });
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/contacts/:sessionId/chat-photos — Batch get photo_url for multiple JIDs
//
// Source-of-truth strategy: wa_photo_queue status='done' means the file exists
// at the deterministic Supabase Storage path. We compute the URL from
// (sessionId, jid) without relying on wa_chats/wa_contacts.photo_url, which
// can be stale or missing when the original PATCH landed on a row that didn't
// exist yet. Falls back to merging whatever photo_url is present in
// wa_chats/wa_contacts too, so legacy rows still work.
router.get("/:sessionId/chat-photos", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const SUPA_URL = process.env.SUPABASE_URL;
    const sid = encodeURIComponent(sessionId);

    // Paginate through wa_photo_queue done rows to bypass the 1000-row cap.
    // Each session has at most a few thousand done photos so 5 chunks is plenty.
    const queueRows = [];
    for (let chunk = 0; chunk < 5; chunk++) {
      const offset = chunk * 1000;
      const rows = await supaRest(
        "/rest/v1/wa_photo_queue?session_id=eq." + sid +
        "&status=eq.done&select=jid&limit=1000&offset=" + offset
      ).catch(() => []);
      if (!rows || !rows.length) break;
      queueRows.push(...rows);
      if (rows.length < 1000) break;
    }

    const map = {};
    for (const r of queueRows) {
      if (!r.jid) continue;
      // Must mirror the safeName logic in photo-worker.js line 125
      const safeName = r.jid.replace(/@/g, "_").replace(/:/g, "_") + ".jpg";
      map[r.jid] = SUPA_URL + "/storage/v1/object/public/profile-photos/" + sessionId + "/" + safeName;
    }

    // Legacy merge — wa_chats/wa_contacts may have photo_url populated from
    // previous runs (or from single-contact profile refreshes). Only used
    // when the queue doesn't already have that jid covered.
    const fetchChunks = async (baseUrl) => {
      const out = [];
      for (let chunk = 0; chunk < 3; chunk++) {
        const rows = await supaRest(baseUrl + "&limit=1000&offset=" + (chunk * 1000)).catch(() => []);
        if (!rows || !rows.length) break;
        out.push(...rows);
        if (rows.length < 1000) break;
      }
      return out;
    };

    const chats = await fetchChunks(
      "/rest/v1/wa_chats?session_id=eq." + sid +
      "&photo_url=not.is.null&select=chat_jid,photo_url"
    );
    const contacts = await fetchChunks(
      "/rest/v1/wa_contacts?session_id=eq." + sid +
      "&photo_url=not.is.null&select=contact_jid,photo_url"
    );

    for (const c of chats) {
      if (c.photo_url && !map[c.chat_jid]) map[c.chat_jid] = c.photo_url;
    }
    for (const c of contacts) {
      if (c.photo_url && !map[c.contact_jid]) map[c.contact_jid] = c.photo_url;
    }

    res.json(map);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
