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
