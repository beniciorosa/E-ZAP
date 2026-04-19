// ===== DHIEGO.AI admin routes =====
// Used by admin.html tab to manage config + browse/edit ideas.
// All routes require the existing requireAuth middleware (mounted in index.js).

const express = require("express");
const router = express.Router();
const { supaRest } = require("../services/supabase");
const { loadConfig, invalidateCache } = require("../services/dhiego-ai/config");
const { clearStateForUser } = require("../services/dhiego-ai/state");
const baileys = require("../services/baileys");
const dhiegoAI = require("../services/dhiego-ai");

// Phone hardcoded for the /inject endpoint — any caller with ADMIN_TOKEN
// injects messages AS the Dhiego's own number.
const INJECTED_SENDER_PHONE = "5511989473088";
const INJECTED_SENDER_JID = INJECTED_SENDER_PHONE + "@s.whatsapp.net";

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
      systemPrompt: cfg.systemPrompt,
      hasClaudeKey: !!cfg.claudeApiKey,
      hasOpenaiKey: !!cfg.openaiApiKey,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/dhiego-ai/config — update one or more config keys at once
// Body: { enabled?, sessionId?, authorizedPhones?, llmModel?, systemPrompt? }
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
    if (typeof body.systemPrompt === "string") {
      updates.push({ key: "dhiego_ai_system_prompt", value: body.systemPrompt });
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
        systemPrompt: fresh.systemPrompt,
        hasClaudeKey: !!fresh.claudeApiKey,
        hasOpenaiKey: !!fresh.openaiApiKey,
      },
    });
  } catch (e) {
    console.error("[DHIEGO.AI] config PATCH error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ===== Conversations (memory) =====

// GET /api/dhiego-ai/conversations?userId=...&limit=50
// Returns the latest N turns ordered DESC (most recent first) so the admin
// can scroll back through what the user and the assistant said.
router.get("/conversations", async (req, res) => {
  try {
    const { userId, limit = 50 } = req.query;
    if (!userId) return res.status(400).json({ error: "userId obrigatório" });
    const safeLimit = Math.min(parseInt(limit, 10) || 50, 500);
    const rows = await supaRest(
      "/rest/v1/dhiego_conversations?user_id=eq." + encodeURIComponent(userId) +
      "&select=id,session_id,chat_jid,sender_phone,role,content,intent,created_at" +
      "&order=created_at.desc&limit=" + safeLimit
    );
    res.json(rows || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/dhiego-ai/state?userId=...&sessionId=...&chatJid=...
router.get("/state", async (req, res) => {
  try {
    const { userId, sessionId, chatJid } = req.query;
    if (!userId) return res.status(400).json({ error: "userId obrigatÃ³rio" });
    let path = "/rest/v1/dhiego_ai_state?user_id=eq." + encodeURIComponent(userId) +
      "&select=id,session_id,chat_jid,active_task,active_tool,focus_idea_id,state_payload,updated_at,expires_at" +
      "&order=updated_at.desc&limit=20";
    if (sessionId) path += "&session_id=eq." + encodeURIComponent(sessionId);
    if (chatJid) path += "&chat_jid=eq." + encodeURIComponent(chatJid);
    const rows = await supaRest(path);
    res.json(rows || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/dhiego-ai/conversations?userId=... — wipe memory for a user
// Requires explicit userId to prevent accidental global deletes.
router.delete("/conversations", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "userId obrigatório" });
    await supaRest(
      "/rest/v1/dhiego_conversations?user_id=eq." + encodeURIComponent(userId),
      "DELETE",
      null,
      "return=minimal"
    );
    await clearStateForUser(userId);
    res.json({ ok: true });
  } catch (e) {
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

// ===== Inject =====
// POST /api/dhiego-ai/inject { text }
// Fabricates a synthetic WhatsApp message as if Dhiego's phone
// (INJECTED_SENDER_PHONE) had sent `text` to the DHIEGO.BOT session, then
// fires maybeHandle() in background. The reply flows through the normal
// WhatsApp pipeline (sock.sendMessage → Dhiego's phone).
//
// Use case: external tools (dashboards, apps) that want to query DHIEGO.AI
// without typing on the WhatsApp keyboard. Response arrives in WhatsApp.
router.post("/inject", async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "text (string não vazio) é obrigatório" });
    }

    const cfg = await loadConfig();
    if (!cfg.enabled) {
      return res.status(503).json({ error: "DHIEGO.AI está desabilitado no admin" });
    }
    if (!cfg.sessionId) {
      return res.status(500).json({ error: "dhiego_ai_session_id não configurado" });
    }
    if (!cfg.authorizedPhones.includes(INJECTED_SENDER_PHONE)) {
      return res.status(500).json({
        error: "sender " + INJECTED_SENDER_PHONE + " não está na allowlist. Adicione no admin.",
      });
    }

    const session = baileys.getSession(cfg.sessionId);
    if (!session || !session.sock || session.status !== "connected") {
      return res.status(503).json({
        error: "DHIEGO.BOT não está conectado",
        sessionStatus: session ? session.status : "not_found",
      });
    }

    const messageId = "INJECT_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const msg = {
      key: {
        remoteJid: INJECTED_SENDER_JID,
        fromMe: false,
        participant: INJECTED_SENDER_JID,
        id: messageId,
      },
      participantPn: INJECTED_SENDER_JID,
      pushName: "Dhiego (injected)",
      message: {
        conversation: text.trim(),
      },
    };

    // Fire-and-forget — response goes back via sock.sendMessage on completion.
    dhiegoAI.maybeHandle(cfg.sessionId, msg, session.sock).catch(function (e) {
      console.error("[DHIEGO.AI /inject] background error:", e.message);
    });

    console.log(
      "[DHIEGO.AI /inject] queued messageId=" + messageId +
      " text=" + text.slice(0, 80)
    );
    res.json({
      ok: true,
      queued: true,
      messageId,
      sessionId: cfg.sessionId,
    });
  } catch (e) {
    console.error("[DHIEGO.AI /inject] handler error:", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
