// ===== DHIEGO.AI admin routes =====
// Used by admin.html tab to manage config + browse/edit ideas.
// All routes require the existing requireAuth middleware (mounted in index.js).

const express = require("express");
const router = express.Router();
const { supaRest } = require("../services/supabase");
const { loadConfig, invalidateCache } = require("../services/dhiego-ai/config");

// ===== Config =====

// GET /api/dhiego-ai/config — current runtime config (reads from app_settings)
router.get("/config", async (req, res) => {
  try {
    const cfg = await loadConfig(true);
    // Never leak the api key, just signal presence
    res.json({
      enabled: cfg.enabled,
      sessionId: cfg.sessionId,
      authorizedPhones: cfg.authorizedPhones,
      llmModel: cfg.llmModel,
      hasClaudeKey: !!cfg.claudeApiKey,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/dhiego-ai/config — update one or more config keys at once
// Body: { enabled?, sessionId?, authorizedPhones?, llmModel? }
router.patch("/config", async (req, res) => {
  try {
    const body = req.body || {};
    const updates = [];

    if (typeof body.enabled === "boolean") {
      updates.push({ key: "dhiego_ai_enabled", value: body.enabled ? "true" : "false" });
    }
    if (typeof body.sessionId === "string") {
      updates.push({ key: "dhiego_ai_session_id", value: body.sessionId });
    }
    if (Array.isArray(body.authorizedPhones)) {
      const clean = body.authorizedPhones
        .map(p => String(p || "").replace(/\D/g, ""))
        .filter(p => p.length >= 10);
      updates.push({ key: "dhiego_ai_authorized_phones", value: JSON.stringify(clean) });
    }
    if (typeof body.llmModel === "string" && body.llmModel) {
      updates.push({ key: "dhiego_ai_llm_model", value: body.llmModel });
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "Nada pra atualizar" });
    }

    for (const u of updates) {
      await supaRest(
        "/rest/v1/app_settings?on_conflict=key",
        "POST",
        { key: u.key, value: u.value, updated_at: new Date().toISOString() },
        "resolution=merge-duplicates,return=minimal"
      );
    }

    invalidateCache();
    const fresh = await loadConfig(true);
    res.json({
      ok: true,
      config: {
        enabled: fresh.enabled,
        sessionId: fresh.sessionId,
        authorizedPhones: fresh.authorizedPhones,
        llmModel: fresh.llmModel,
        hasClaudeKey: !!fresh.claudeApiKey,
      },
    });
  } catch (e) {
    console.error("[DHIEGO.AI] config PATCH error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ===== Ideas CRUD =====

// GET /api/dhiego-ai/ideas?userId=...&status=open|done|cancelled|all
router.get("/ideas", async (req, res) => {
  try {
    const { userId, status = "all", limit = 200 } = req.query;
    if (!userId) return res.status(400).json({ error: "userId obrigatório" });
    const statusFilter = status && status !== "all" ? "&status=eq." + encodeURIComponent(status) : "";
    const rows = await supaRest(
      "/rest/v1/dhiego_ideas?user_id=eq." + encodeURIComponent(userId) +
      statusFilter +
      "&order=id.desc&limit=" + Math.min(parseInt(limit, 10) || 200, 500) +
      "&select=id,text,status,source,created_at,updated_at,completed_at"
    );
    res.json(rows || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/dhiego-ai/ideas — manually create (admin flow)
// Body: { userId, text, source? }
router.post("/ideas", async (req, res) => {
  try {
    const { userId, text, source = "admin" } = req.body || {};
    if (!userId || !text) return res.status(400).json({ error: "userId e text obrigatórios" });
    const rows = await supaRest(
      "/rest/v1/dhiego_ideas",
      "POST",
      { user_id: userId, text: String(text).trim(), source },
      "return=representation"
    );
    res.status(201).json(Array.isArray(rows) ? rows[0] : rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/dhiego-ai/ideas/:id — change status or text
// Body: { status?, text? }
router.patch("/ideas/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: "id inválido" });
    const body = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (body.status && ["open", "done", "cancelled"].includes(body.status)) {
      patch.status = body.status;
      if (body.status === "done") patch.completed_at = new Date().toISOString();
    }
    if (typeof body.text === "string" && body.text.trim()) patch.text = body.text.trim();
    await supaRest(
      "/rest/v1/dhiego_ideas?id=eq." + id,
      "PATCH",
      patch,
      "return=minimal"
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/dhiego-ai/ideas/:id
router.delete("/ideas/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: "id inválido" });
    await supaRest("/rest/v1/dhiego_ideas?id=eq." + id, "DELETE", null, "return=minimal");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
