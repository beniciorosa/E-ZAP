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
// Body: { sessionId, specs: [...], delaySec?, jitterMinSec?, jitterMaxSec?, leadingDelaySec? }
router.post("/create-groups/start", async (req, res) => {
  try {
    const { sessionId, specs, delaySec, jitterMinSec, jitterMaxSec, leadingDelaySec } = req.body || {};
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
    // leadingDelaySec (tempo antes do 1o grupo): 0..600s. applyCriticalSessionOverrides
    // pode forcar 120s em sessoes criticas, independente do valor do user.
    if (leadingDelaySec !== undefined) {
      const v = Number(leadingDelaySec);
      if (!Number.isFinite(v) || v < 0 || v > 600) {
        return res.status(400).json({ error: "leadingDelaySec fora do range (0..600)" });
      }
    }

    const job = await jobs.startCreateGroupsJob(sessionId, specs, {
      delaySec,
      jitterMinSec,
      jitterMaxSec,
      leadingDelaySec,
    });
    res.status(201).json({ ok: true, job: jobs.summarizeJob(job) });
  } catch (e) {
    console.error("[JOBS] Start create-groups error:", e.message);
    res.status(e.statusCode || 500).json({ error: e.message });
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

// GET /api/jobs/:jobId — full snapshot (includes results array + pending specs)
router.get("/:jobId", (req, res) => {
  try {
    const job = jobs.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job não encontrado" });

    // Deriva a lista de specs pendentes (não processados ainda) pra UI mostrar
    // linhas "⏸ Aguardando" antes dos grupos terem sido criados.
    const processedHashes = new Set((job.results || []).map(r => r && r.specHash));
    const pendingSpecs = Array.isArray(job._specs)
      ? job._specs
          .filter(s => s && s.specHash && !processedHashes.has(s.specHash))
          .map(s => ({ specHash: s.specHash, name: s.name || "(sem nome)" }))
      : [];

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
        pendingSpecs,
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

// POST /api/jobs/:jobId/retry-group
// Body: { specHash: string }
// Re-runs createGroupsFromList for a single spec that previously failed.
// Used by the "↻ Tentar" button on failed rows in the job card. Fire-and-forget:
// returns 202 immediately; the frontend sees the new result in the next poll.
router.post("/:jobId/retry-group", async (req, res) => {
  try {
    const { specHash } = req.body || {};
    if (!specHash) return res.status(400).json({ error: "specHash é obrigatório" });
    const result = await jobs.retryGroupInJob(req.params.jobId, specHash);
    res.status(202).json({ ok: true, job: jobs.summarizeJob(result.job), specHash });
  } catch (e) {
    const status = e.statusCode || 500;
    res.status(status).json({ error: e.message || String(e) });
  }
});

module.exports = router;
