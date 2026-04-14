// ===== Background job routes (temporary tools) =====
// Fire-and-forget workers for extract/add operations. The frontend polls
// GET /api/jobs/:id to update progress independently of the HTTP request
// that started the job. Closing the browser does not interrupt the worker.

const express = require("express");
const router = express.Router();
const jobs = require("../services/jobs");

// POST /api/jobs/extract/start — start a new extraction worker
// Body: { sessionId, delaySec? }
router.post("/extract/start", async (req, res) => {
  try {
    const { sessionId, delaySec } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId é obrigatório" });
    const job = await jobs.startExtractJob(sessionId, { delaySec });
    res.status(201).json({ ok: true, job: jobs.summarizeJob(job) });
  } catch (e) {
    console.error("[JOBS] Start extract error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/jobs/add/start — start a new add-to-groups worker
// Body: { sessionId, phone, delaySec?, promoteToAdmin?, onlyJids? }
router.post("/add/start", async (req, res) => {
  try {
    const { sessionId, phone, delaySec, promoteToAdmin, onlyJids } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId é obrigatório" });
    if (!phone) return res.status(400).json({ error: "phone é obrigatório" });
    const job = await jobs.startAddJob(sessionId, phone, { delaySec, promoteToAdmin, onlyJids });
    res.status(201).json({ ok: true, job: jobs.summarizeJob(job) });
  } catch (e) {
    console.error("[JOBS] Start add error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/jobs/create-groups/start — start a bulk group creation worker
// Body: { sessionId, specs: [{specHash, name, description?, photoUrl?, members:[], lockInfo?, welcomeMessage?}], delaySec? }
router.post("/create-groups/start", async (req, res) => {
  try {
    const { sessionId, specs, delaySec } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId é obrigatório" });
    if (!Array.isArray(specs) || specs.length === 0) {
      return res.status(400).json({ error: "specs (lista de grupos) é obrigatório" });
    }
    if (specs.length > 100) {
      return res.status(400).json({ error: "Máximo de 100 grupos por job" });
    }

    for (const s of specs) {
      if (!s || typeof s !== "object") {
        return res.status(400).json({ error: "Cada linha de specs precisa ser um objeto" });
      }
      if (!s.name || typeof s.name !== "string") {
        return res.status(400).json({ error: "Cada grupo precisa de nome" });
      }
      if (!Array.isArray(s.members) || s.members.length === 0) {
        return res.status(400).json({ error: `Grupo "${s.name}" sem membros` });
      }
      if (!s.specHash || typeof s.specHash !== "string") {
        return res.status(400).json({ error: `Grupo "${s.name}" sem specHash` });
      }
    }

    if (delaySec !== undefined && Number(delaySec) < 60) {
      return res.status(400).json({ error: "Delay mínimo é 60s (segurança anti-ban)" });
    }

    const job = await jobs.startCreateGroupsJob(sessionId, specs, { delaySec });
    res.status(201).json({ ok: true, job: jobs.summarizeJob(job) });
  } catch (e) {
    console.error("[JOBS] Start create-groups error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/jobs — list jobs (optionally filtered by sessionId, type, active)
router.get("/", (req, res) => {
  try {
    const filter = {
      sessionId: req.query.sessionId,
      type: req.query.type,
      activeOnly: req.query.active === "1" || req.query.active === "true",
    };
    res.json({ ok: true, jobs: jobs.listJobs(filter) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/jobs/:jobId — full snapshot (includes results array)
router.get("/:jobId", (req, res) => {
  try {
    const job = jobs.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job não encontrado" });
    // Return everything; frontend decides what to render.
    res.json({
      ok: true,
      job: {
        id: job.id,
        type: job.type,
        sessionId: job.sessionId,
        status: job.status,
        config: job.config,
        progress: job.progress,
        results: job.results,
        lastError: job.lastError,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/jobs/:jobId/cancel — request cancellation (worker stops at next group)
router.post("/:jobId/cancel", (req, res) => {
  try {
    const result = jobs.cancelJob(req.params.jobId);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
