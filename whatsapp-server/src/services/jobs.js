// ===== Jobs Manager =====
// Runs long operations (group extract / bulk add) in the background, decoupled
// from the HTTP request that started them. The frontend polls job status via
// GET /api/jobs/:jobId and displays progress.
//
// Jobs are stored in memory only — survive the HTTP request but NOT a PM2
// restart. That's fine because the Supabase cache preserves actual progress;
// after a restart the user just clicks "New extraction" again and it resumes
// from whatever is already in Supabase.

const { randomUUID } = require("crypto");
const baileys = require("./baileys");
const { supaRest } = require("./supabase");

// jobId -> job object
const jobs = new Map();

// ===== Job lifecycle =====

function createJob(type, sessionId, config) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
    type,                          // "extract" | "add"
    sessionId,
    status: "pending",             // "pending" | "running" | "paused" | "rate_limited" | "cancelled" | "completed" | "error"
    config: Object.assign({}, config || {}),
    progress: {
      total: 0,                    // total admin groups to process
      done: 0,                     // groups that reached a terminal state in THIS run
      doneTotal: 0,                // terminal states including those cached from prior runs
      adminCount: 0,
      newInThisRun: 0,             // newly extracted/added in the current run only
      rateLimited: false,
      startedAt: null,
      updatedAt: null,
    },
    results: [],                   // list of row objects (same shape as fetchGroupsWithInvites returns)
    lastError: null,
    cancelRequested: false,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(id, job);
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function listJobs(filter = {}) {
  const out = [];
  for (const [id, job] of jobs) {
    if (filter.sessionId && job.sessionId !== filter.sessionId) continue;
    if (filter.type && job.type !== filter.type) continue;
    if (filter.activeOnly && !isActiveStatus(job.status)) continue;
    out.push(summarizeJob(job));
  }
  // Most recent first
  out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return out;
}

function isActiveStatus(status) {
  return status === "pending" || status === "running";
}

function summarizeJob(job) {
  // Lighter snapshot used in list endpoints (no results array)
  return {
    id: job.id,
    type: job.type,
    sessionId: job.sessionId,
    status: job.status,
    config: job.config,
    progress: job.progress,
    lastError: job.lastError,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return { ok: false, error: "Job não encontrado" };
  if (!isActiveStatus(job.status)) return { ok: false, error: "Job não está ativo" };
  job.cancelRequested = true;
  job.updatedAt = new Date().toISOString();
  return { ok: true };
}

// Prevent the Map from growing forever: drop jobs that completed more than 24h ago.
function cleanupOldJobs() {
  const now = Date.now();
  const cutoff = 24 * 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (isActiveStatus(job.status)) continue;
    const finishedAt = Date.parse(job.updatedAt);
    if (!Number.isFinite(finishedAt)) continue;
    if ((now - finishedAt) > cutoff) jobs.delete(id);
  }
}
setInterval(cleanupOldJobs, 60 * 60 * 1000); // hourly

// ===== Extract worker =====

async function startExtractJob(sessionId, config = {}) {
  const job = createJob("extract", sessionId, {
    delaySec: Number(config.delaySec) || 60,
  });
  // Fire and forget
  runExtractWorker(job).catch(e => {
    job.status = "error";
    job.lastError = e.message || String(e);
    job.updatedAt = new Date().toISOString();
    console.error("[JOBS] Extract worker crashed:", e);
  });
  return job;
}

async function runExtractWorker(job) {
  job.status = "running";
  job.progress.startedAt = new Date().toISOString();
  job.progress.updatedAt = job.progress.startedAt;
  job.updatedAt = job.progress.startedAt;

  // Get cached links from Supabase — those are skipJids (already extracted, don't re-hit)
  const cachedInvites = await baileys.getCachedGroupLinks(job.sessionId);
  const cachedLinkJids = cachedInvites.filter(r => r.invite_link).map(r => r.group_jid);
  // Permanent errors also get skipped (e.g. community announce channels)
  const permanentErrorJids = cachedInvites
    .filter(r => !r.invite_link && r.invite_error && !isRateLimitMessageString(r.invite_error))
    .map(r => r.group_jid);
  const skipJids = cachedLinkJids.concat(permanentErrorJids);

  // Pre-populate results with the cached entries (so the frontend sees progress immediately)
  const preLoaded = cachedInvites.map(r => ({
    jid: r.group_jid,
    name: r.group_name || "(sem nome)",
    participants: r.participants_count || 0,
    isAdmin: !!r.is_admin,
    inviteLink: r.invite_link || null,
    inviteError: r.invite_error || null,
    skipped: true,
    fromCache: true,
  }));
  job.results = preLoaded.slice();

  // State counters
  let newThisRun = 0;

  try {
    const result = await baileys.fetchGroupsWithInvites(
      job.sessionId,
      skipJids,
      Infinity, // no batch limit in worker mode
      {
        delaySec: job.config.delaySec,
        shouldCancel: () => job.cancelRequested,
        onProgress: ({ processed, total, row, rateLimited }) => {
          // Merge this row into results (replace if jid existed, else push)
          const idx = job.results.findIndex(r => r.jid === row.jid);
          if (idx >= 0) job.results[idx] = Object.assign({}, row, { fromCache: false });
          else job.results.push(Object.assign({}, row, { fromCache: false }));

          if (row.inviteLink && !row.skipped) newThisRun++;

          const done = job.results.filter(r => r.inviteLink || r.inviteError).length;
          const adminCount = job.results.filter(r => r.isAdmin).length;
          const withLink = job.results.filter(r => !!r.inviteLink).length;

          job.progress.total = total;
          job.progress.done = processed;
          job.progress.doneTotal = done;
          job.progress.adminCount = adminCount;
          job.progress.withLink = withLink;
          job.progress.newInThisRun = newThisRun;
          job.progress.rateLimited = rateLimited;
          job.progress.updatedAt = new Date().toISOString();
          job.updatedAt = job.progress.updatedAt;
        },
      }
    );

    // Final status
    if (result.cancelled) {
      job.status = "cancelled";
    } else if (result.rateLimited) {
      job.status = "rate_limited";
    } else {
      job.status = "completed";
    }
    job.updatedAt = new Date().toISOString();
  } catch (e) {
    job.status = "error";
    job.lastError = e.message || String(e);
    job.updatedAt = new Date().toISOString();
    throw e;
  }
}

// ===== Add worker =====

async function startAddJob(sessionId, phone, config = {}) {
  const job = createJob("add", sessionId, {
    phone: String(phone || "").replace(/\D/g, ""),
    delaySec: Number(config.delaySec) || 20,
    promoteToAdmin: !!config.promoteToAdmin,
    onlyJids: Array.isArray(config.onlyJids) ? config.onlyJids : null,
  });
  runAddWorker(job).catch(e => {
    job.status = "error";
    job.lastError = e.message || String(e);
    job.updatedAt = new Date().toISOString();
    console.error("[JOBS] Add worker crashed:", e);
  });
  return job;
}

async function runAddWorker(job) {
  job.status = "running";
  job.progress.startedAt = new Date().toISOString();
  job.progress.updatedAt = job.progress.startedAt;
  job.updatedAt = job.progress.startedAt;

  // Seed skipJids from prior terminal-state additions in Supabase
  const cachedAdds = await baileys.getCachedGroupAdditions(job.sessionId, job.config.phone);
  // Everything in the cache is a "previously processed" entry — skip those
  const terminalJids = cachedAdds.map(r => r.group_jid);

  // Pre-populate results so the frontend shows what was already done
  job.results = cachedAdds.map(r => ({
    jid: r.group_jid,
    name: r.group_name || "(sem nome)",
    participants: 0,
    isAdmin: true,
    status: r.status,
    statusMessage: r.status_message || null,
    fromCache: true,
  }));

  let newThisRun = 0;

  try {
    const result = await baileys.addParticipantToAllGroups(
      job.sessionId,
      job.config.phone,
      terminalJids,
      Infinity,
      {
        delaySec: job.config.delaySec,
        promoteToAdmin: job.config.promoteToAdmin,
        onlyJids: job.config.onlyJids || undefined,
        shouldCancel: () => job.cancelRequested,
        onProgress: ({ processed, total, row, rateLimited }) => {
          const idx = job.results.findIndex(r => r.jid === row.jid);
          if (idx >= 0) job.results[idx] = Object.assign({}, row, { fromCache: false });
          else job.results.push(Object.assign({}, row, { fromCache: false }));

          if (row.status && row.status !== "skipped" && row.status !== "not_admin"
              && row.status !== "aborted_rate_limit") {
            newThisRun++;
          }

          const adminCount = job.results.filter(r => r.isAdmin).length;
          const done = job.results.filter(r => r.status && r.status !== "skipped").length;

          job.progress.total = total;
          job.progress.done = processed;
          job.progress.doneTotal = done;
          job.progress.adminCount = adminCount;
          job.progress.newInThisRun = newThisRun;
          job.progress.rateLimited = rateLimited;
          job.progress.updatedAt = new Date().toISOString();
          job.updatedAt = job.progress.updatedAt;
        },
      }
    );

    if (result.cancelled) {
      job.status = "cancelled";
    } else if (result.rateLimited) {
      job.status = "rate_limited";
    } else {
      job.status = "completed";
    }
    job.updatedAt = new Date().toISOString();
  } catch (e) {
    job.status = "error";
    job.lastError = e.message || String(e);
    job.updatedAt = new Date().toISOString();
    throw e;
  }
}

// ===== Helpers =====

function isRateLimitMessageString(msg) {
  if (!msg) return false;
  const s = String(msg).toLowerCase();
  return s.includes("rate") || s.includes("abortado") || s.includes("too many");
}

module.exports = {
  createJob,
  getJob,
  listJobs,
  cancelJob,
  startExtractJob,
  startAddJob,
  summarizeJob,
};
