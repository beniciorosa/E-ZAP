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
      "/rest/v1/wa_sessions?select=id,user_id,phone,label,status,last_seen,created_at,skip_group_sync&order=created_at.asc"
    );
    // Enrich with live status
    const active = baileys.getActiveSessions();
    const activeMap = {};
    for (const a of active) activeMap[a.sessionId] = a;

    const result = (dbSessions || []).map(s => {
      const meta = baileys.getSessionMeta(s.id);
      const quarantine = baileys.getQuarantineStatus(s.id);
      return {
        ...s,
        live: activeMap[s.id] || null,
        connectedAt: meta.connectedAt,
        rateLimitHitAt: meta.rateLimitHitAt,
        rateLimitRemainingMs: meta.rateLimitRemainingMs,
        quarantine, // { enteredAt, reason, durationMs } | null
      };
    });

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

// GET /api/sessions/:id/qr-raw — Returns the current QR string (or null).
// Use as fallback when the admin Socket.io subscription doesn't deliver
// session:qr events. The caller can render it with any QR generator.
router.get("/:id/qr-raw", (req, res) => {
  try {
    const live = baileys.getSession(req.params.id);
    if (!live) return res.status(404).json({ error: "Sessão não está ativa em memória" });
    res.json({
      sessionId: req.params.id,
      status: live.status,
      qr: live.qr || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/sessions/:id — Update session (rename, etc.)
router.patch("/:id", async (req, res) => {
  try {
    const { label, userId, skipGroupSync } = req.body;
    const body = {};
    if (label) body.label = label;
    if (userId !== undefined) body.user_id = userId || null;
    if (skipGroupSync !== undefined) body.skip_group_sync = !!skipGroupSync;
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

// POST /api/sessions/:id/fresh-qr — Force new QR scan (clears creds, keeps session_id + all history)
router.post("/:id/fresh-qr", async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Stop current connection
    await baileys.stopSession(id);

    // 2. Clear credentials (forces new QR on next connect)
    await supaRest(
      "/rest/v1/wa_sessions?id=eq." + id,
      "PATCH",
      { creds: null, status: "qr_pending" },
      "return=minimal"
    );

    // 3. Start fresh session (will generate new QR)
    await baileys.startSession(id, null);

    res.json({
      ok: true,
      sessionId: id,
      status: "qr_pending",
      message: "Novo QR gerado. Escaneie para reconectar. Todo o histórico foi preservado."
    });
  } catch (e) {
    console.error("[SESSIONS] Fresh QR error:", e.message);
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

// POST /api/sessions/:id/list-admin-groups — Quickly list all groups where session is admin
// Returns: { ok, count, groups: [{ jid, name, participants }] } sorted by name (pt-BR)
router.post("/:id/list-admin-groups", async (req, res) => {
  try {
    if (baileys.isQuarantined(req.params.id)) {
      return res.status(409).json({ error: "Sessão em quarentena — tente novamente após liberar" });
    }
    const groups = await baileys.listAdminGroups(req.params.id);
    res.json({ ok: true, count: groups.length, groups });
  } catch (e) {
    console.error("[SESSIONS] List admin groups error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sessions/:id/list-admin-groups-with-membership
// Body: { targetPhone?: string }
// If targetPhone is provided AND there's a connected session with that phone,
// cross-references group membership and returns { ..., memberStatus: "not_member"|"member"|"admin" }.
// Otherwise groups come back with memberStatus="unknown".
router.post("/:id/list-admin-groups-with-membership", async (req, res) => {
  try {
    if (baileys.isQuarantined(req.params.id)) {
      return res.status(409).json({ error: "Sessão em quarentena — tente novamente após liberar" });
    }
    const targetPhone = req.body?.targetPhone || "";
    const result = await baileys.listAdminGroupsWithMembership(req.params.id, targetPhone);
    res.json({
      ok: true,
      count: result.groups.length,
      targetSessionFound: result.targetSessionFound,
      groups: result.groups,
    });
  } catch (e) {
    console.error("[SESSIONS] List admin groups with membership error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sessions/:id/cached-invites — fetch all extracted invite links from Supabase
router.get("/:id/cached-invites", async (req, res) => {
  try {
    const rows = await baileys.getCachedGroupLinks(req.params.id);
    res.json({ ok: true, count: rows.length, invites: rows });
  } catch (e) {
    console.error("[SESSIONS] Cached invites error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sessions/:id/import-cache — bulk import legacy localStorage cache
// Body: { links: [{jid, link, error}], additionsByPhone: { "5511...": [{jid, status, statusMessage}] } }
router.post("/:id/import-cache", async (req, res) => {
  try {
    const payload = req.body || {};
    const result = await baileys.importLocalCache(req.params.id, payload);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("[SESSIONS] Import cache error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sessions/:id/cached-additions?phone=X — fetch addition history for (session, phone)
router.get("/:id/cached-additions", async (req, res) => {
  try {
    const phone = String(req.query.phone || "").replace(/\D/g, "");
    if (!phone) return res.status(400).json({ error: "Query param 'phone' é obrigatório" });
    const rows = await baileys.getCachedGroupAdditions(req.params.id, phone);
    res.json({ ok: true, count: rows.length, additions: rows });
  } catch (e) {
    console.error("[SESSIONS] Cached additions error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sessions/:id/add-to-groups — Add a phone number to all admin groups (temporary tool)
// Body:
//   phone: string            — phone to add, digits only (e.g. "5511999999999")
//   skipJids?: string[]      — group JIDs already processed (cached results)
//   maxCalls?: number        — max IQ calls per batch (default 10, max 50)
//   promoteToAdmin?: boolean — if true, promote the target to admin after adding
//   onlyJids?: string[]      — if provided, only process groups whose JID is in this list
router.post("/:id/add-to-groups", async (req, res) => {
  try {
    if (baileys.isQuarantined(req.params.id)) {
      return res.status(409).json({ error: "Sessão em quarentena — tente novamente após liberar" });
    }
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: "Campo 'phone' é obrigatório" });
    const skipJids = Array.isArray(req.body?.skipJids) ? req.body.skipJids : [];
    const maxCalls = Number(req.body?.maxCalls) || 10;
    const promoteToAdmin = req.body?.promoteToAdmin === true;
    const onlyJids = Array.isArray(req.body?.onlyJids) ? req.body.onlyJids : null;
    const data = await baileys.addParticipantToAllGroups(
      req.params.id,
      phone,
      skipJids,
      maxCalls,
      { promoteToAdmin, onlyJids }
    );
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
    if (baileys.isQuarantined(req.params.id)) {
      return res.status(409).json({ error: "Sessão em quarentena — tente novamente após liberar" });
    }
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

// ===== Session quarantine (airplane mode) =====
// Puts a session in "no IQs" state: photo-worker paused, event handlers gated,
// ezapweb routes return 409. Used before creating groups on flagged numbers,
// or automatically by createGroupsFromList. Does NOT disconnect the socket —
// credentials preserved, no re-QR risk.

// POST /api/sessions/:id/quarantine — Manually enter quarantine
// Body: { reason?: string }
router.post("/:id/quarantine", (req, res) => {
  try {
    const { id } = req.params;
    const reason = (req.body && req.body.reason) || "manual";
    baileys.quarantineSession(id, reason);
    res.json({ ok: true, status: baileys.getQuarantineStatus(id) });
  } catch (e) {
    console.error("[SESSIONS] Quarantine enter error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sessions/:id/quarantine/release — Manually release quarantine
router.post("/:id/quarantine/release", (req, res) => {
  try {
    baileys.releaseSession(req.params.id);
    res.json({ ok: true, status: baileys.getQuarantineStatus(req.params.id) });
  } catch (e) {
    console.error("[SESSIONS] Quarantine release error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sessions/:id/quarantine — Current quarantine status
router.get("/:id/quarantine", (req, res) => {
  try {
    res.json({ ok: true, status: baileys.getQuarantineStatus(req.params.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
