// ===== Session management routes =====
const express = require("express");
const router = express.Router();
const { supaRest } = require("../services/supabase");
const baileys = require("../services/baileys");

// POST /api/sessions — Create new session and start QR
router.post("/", async (req, res) => {
  try {
    const { label, userId } = req.body;
    if (!label) return res.status(400).json({ error: "Label é obrigatório" });

    // Create session in database
    const rows = await supaRest("/rest/v1/wa_sessions", "POST", {
      label,
      user_id: userId || null,
      status: "qr_pending",
    }, "return=representation");

    const session = Array.isArray(rows) ? rows[0] : rows;
    if (!session || !session.id) throw new Error("Falha ao criar sessão");

    // Start Baileys connection (will emit QR via WebSocket)
    await baileys.startSession(session.id);

    res.status(201).json({ ok: true, sessionId: session.id, status: "qr_pending" });
  } catch (e) {
    console.error("[SESSIONS] Create error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sessions — List all sessions
router.get("/", async (req, res) => {
  try {
    const dbSessions = await supaRest(
      "/rest/v1/wa_sessions?select=id,user_id,phone,label,status,last_seen,created_at&order=created_at.asc"
    );
    // Enrich with live status
    const active = baileys.getActiveSessions();
    const activeMap = {};
    for (const a of active) activeMap[a.sessionId] = a;

    const result = (dbSessions || []).map(s => ({
      ...s,
      live: activeMap[s.id] || null,
    }));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sessions/:id — Get single session
router.get("/:id", async (req, res) => {
  try {
    const rows = await supaRest(
      "/rest/v1/wa_sessions?id=eq." + req.params.id + "&select=*"
    );
    if (!rows || !rows.length) return res.status(404).json({ error: "Sessão não encontrada" });

    const session = rows[0];
    const live = baileys.getSession(req.params.id);
    session.live = live ? { status: live.status, hasQr: !!live.qr } : null;

    // Don't expose creds
    delete session.creds;
    res.json(session);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/sessions/:id — Update session (rename, etc.)
router.patch("/:id", async (req, res) => {
  try {
    const { label, userId } = req.body;
    const body = {};
    if (label) body.label = label;
    if (userId !== undefined) body.user_id = userId || null;
    await supaRest("/rest/v1/wa_sessions?id=eq." + req.params.id, "PATCH", body, "return=minimal");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sessions/:id/reconnect — Reconnect existing session
router.post("/:id/reconnect", async (req, res) => {
  try {
    const rows = await supaRest(
      "/rest/v1/wa_sessions?id=eq." + req.params.id + "&select=id,creds"
    );
    if (!rows || !rows.length) return res.status(404).json({ error: "Sessão não encontrada" });

    await baileys.startSession(req.params.id, rows[0].creds);
    res.json({ ok: true, status: "reconnecting" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/sessions/:id — Disconnect and remove session
router.delete("/:id", async (req, res) => {
  try {
    await baileys.stopSession(req.params.id);
    // Keep in DB but mark as disconnected (don't delete — preserves history)
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sessions/:id/add-to-groups — Add a phone number to all admin groups (temporary tool)
// Body:
//   phone: string        — phone to add, digits only (e.g. "5511999999999")
//   skipJids?: string[]  — group JIDs already processed (cached results)
//   maxCalls?: number    — max groupParticipantsUpdate calls per batch (default 10, max 50)
router.post("/:id/add-to-groups", async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: "Campo 'phone' é obrigatório" });
    const skipJids = Array.isArray(req.body?.skipJids) ? req.body.skipJids : [];
    const maxCalls = Number(req.body?.maxCalls) || 10;
    const data = await baileys.addParticipantToAllGroups(req.params.id, phone, skipJids, maxCalls);
    res.json({
      ok: true,
      count: data.groups.length,
      total: data.total,
      processed: data.processed,
      callsMade: data.callsMade,
      batchLimitReached: data.batchLimitReached,
      rateLimited: data.rateLimited,
      groups: data.groups,
    });
  } catch (e) {
    console.error("[SESSIONS] Add to groups error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sessions/:id/groups — List groups with invite links (temporary tool)
// Body:
//   skipJids?: string[]   — JIDs to skip (caller already has them cached)
//   maxCalls?: number     — max groupInviteCode calls in this batch (default 10, max 50)
router.post("/:id/groups", async (req, res) => {
  try {
    const skipJids = Array.isArray(req.body?.skipJids) ? req.body.skipJids : [];
    const maxCalls = Number(req.body?.maxCalls) || 10;
    const data = await baileys.fetchGroupsWithInvites(req.params.id, skipJids, maxCalls);
    res.json({
      ok: true,
      count: data.groups.length,
      total: data.total,
      processed: data.processed,
      callsMade: data.callsMade,
      batchLimitReached: data.batchLimitReached,
      rateLimited: data.rateLimited,
      groups: data.groups,
      debug: data.debug,
    });
  } catch (e) {
    console.error("[SESSIONS] Groups error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
