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

  // Initialize progress counters from the cache so the UI is meaningful before
  // the first group is processed by the worker loop.
  const preloadWithLink = preLoaded.filter(r => !!r.inviteLink).length;
  const preloadDone = preLoaded.filter(r => !!(r.inviteLink || r.inviteError)).length;
  const preloadAdminCount = preLoaded.filter(r => r.isAdmin).length;
  job.progress.withLink = preloadWithLink;
  job.progress.doneTotal = preloadDone;
  job.progress.adminCount = preloadAdminCount;
  job.progress.total = preLoaded.length;
  job.progress.updatedAt = new Date().toISOString();
  job.updatedAt = job.progress.updatedAt;

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
          // Merge this row into results (replace if jid existed, else push).
          // CRITICAL: if the row is "skipped" (cache hit), the worker loop does NOT
          // re-read the invite link — we must preserve what was pre-loaded.
          const idx = job.results.findIndex(r => r.jid === row.jid);
          if (idx >= 0) {
            const existing = job.results[idx];
            if (row.skipped && (existing.inviteLink || existing.inviteError)) {
              // Preserve the cached link/error. Refresh isAdmin/participants/name from live data.
              job.results[idx] = Object.assign({}, existing, {
                isAdmin: row.isAdmin,
                participants: row.participants || existing.participants,
                name: row.name || existing.name,
                skipped: true,
                fromCache: false,
              });
            } else {
              job.results[idx] = Object.assign({}, row, { fromCache: false });
            }
          } else {
            job.results.push(Object.assign({}, row, { fromCache: false }));
          }

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

  // Seed skipJids from prior SUCCESSFUL additions in Supabase
  // Only skip groups where the number was actually added/is already member.
  // Re-try groups that had errors, privacy blocks, rate limits, etc.
  const cachedAdds = await baileys.getCachedGroupAdditions(job.sessionId, job.config.phone);
  const successStatuses = new Set(["added", "added_and_promoted", "already_member", "already_admin", "promoted_only"]);
  const terminalJids = cachedAdds
    .filter(r => successStatuses.has(r.status))
    .map(r => r.group_jid);

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

  // Initialize progress counters from the cache
  const preAdminCount = job.results.filter(r => r.isAdmin).length;
  const preDone = job.results.filter(r => r.status && r.status !== "skipped").length;
  job.progress.adminCount = preAdminCount;
  job.progress.doneTotal = preDone;
  job.progress.total = job.results.length;
  job.progress.updatedAt = new Date().toISOString();
  job.updatedAt = job.progress.updatedAt;

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
          // Lightweight progress tick for groups skipped by the onlyJids filter:
          // baileys calls us with row=null just to advance the loop counter so
          // the progress bar doesn't get stuck at the last matched group.
          if (!row) {
            job.progress.total = total;
            job.progress.done = processed;
            job.progress.rateLimited = rateLimited;
            job.progress.updatedAt = new Date().toISOString();
            job.updatedAt = job.progress.updatedAt;
            return;
          }

          // Merge this row into results. If row is "skipped" (cache hit), preserve
          // the cached status but refresh metadata from the live loop.
          const idx = job.results.findIndex(r => r.jid === row.jid);
          if (idx >= 0) {
            const existing = job.results[idx];
            if (row.status === "skipped" && existing.status && existing.status !== "skipped") {
              // Preserve cached terminal status
              job.results[idx] = Object.assign({}, existing, {
                isAdmin: row.isAdmin,
                participants: row.participants || existing.participants,
                name: row.name || existing.name,
                fromCache: false,
              });
            } else {
              job.results[idx] = Object.assign({}, row, { fromCache: false });
            }
          } else {
            job.results.push(Object.assign({}, row, { fromCache: false }));
          }

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

// ===== Create-groups worker =====

async function startCreateGroupsJob(sessionId, specs, config = {}) {
  // Server-side cooldown: reject if the session hit a rate-limit recently.
  // The user already sees a red banner after a rate-limit; this prevents an
  // impatient second click from re-poking the account and making it worse.
  const rl = baileys.getRateLimitStatus(sessionId);
  if (rl) {
    const minutes = Math.ceil(rl.remainingMs / 60000);
    const err = new Error("Sessão em cooldown pós-rate-limit. Aguarde ~" + minutes + "min antes de iniciar outra criação.");
    err.statusCode = 429;
    throw err;
  }

  // Jitter configurável: soma aleatória entre [jitterMinSec, jitterMaxSec]
  // no delay entre grupos. Default 0/0 (sem jitter). Range [0, 3600s] = [0, 60min].
  const jitterMinSec = Math.max(0, Math.min(3600, Number(config.jitterMinSec) || 0));
  const jitterMaxSec = Math.max(jitterMinSec, Math.min(3600, Number(config.jitterMaxSec) || 0));

  const job = createJob("create-groups", sessionId, {
    delaySec: Math.max(60, Number(config.delaySec) || 180),
    jitterMinSec: jitterMinSec,
    jitterMaxSec: jitterMaxSec,
    specCount: Array.isArray(specs) ? specs.length : 0,
  });
  // Specs are kept on the job object but not serialized in summaries
  job._specs = Array.isArray(specs) ? specs : [];
  runCreateGroupsWorker(job).catch(e => {
    job.status = "error";
    job.lastError = e.message || String(e);
    job.updatedAt = new Date().toISOString();
    console.error("[JOBS] Create-groups worker crashed:", e);
  });
  return job;
}

// Helper — extrai dm_sent de uma role em members_list (JSONB) cacheado no DB.
// Retorna null se não achar row ou se a role não teve DM (entrou direto).
function extractDmStatus(membersList, role) {
  if (!Array.isArray(membersList)) return null;
  const m = membersList.find(x => x && x.role === role);
  if (!m) return null;
  // dm_sent: true/false se tentou; null se N/A (entrou direto, não precisou DM)
  return m.dm_sent === true ? true : (m.dm_sent === false ? false : null);
}

async function runCreateGroupsWorker(job) {
  job.status = "running";
  job.progress.startedAt = new Date().toISOString();
  job.progress.updatedAt = job.progress.startedAt;
  job.updatedAt = job.progress.startedAt;

  // Dedup cache: rows already created (by spec_hash) are skipped in this run
  const cached = await baileys.getCachedGroupCreations(job.sessionId);
  const createdHashes = new Set(
    cached.filter(r => r.status === "created").map(r => r.spec_hash)
  );
  const pendingSpecs = job._specs.filter(s => s && s.specHash && !createdHashes.has(s.specHash));

  // Pre-populate results with the cached entries (so the frontend sees progress immediately)
  job.results = cached.map(r => ({
    specHash: r.spec_hash,
    name: r.group_name || "(sem nome)",
    groupJid: r.group_jid || null,
    status: r.status,
    statusMessage: r.status_message || null,
    membersTotal: r.members_total || 0,
    membersAdded: r.members_added || 0,
    hasDescription: !!r.has_description,
    hasPhoto: !!r.has_photo,
    locked: !!r.locked,
    welcomeSent: !!r.welcome_sent,
    inviteLink: r.invite_link || null,
    // Puxa o created_at do banco pra coluna "Criado em" funcionar em grupos
    // que foram feitos em rodadas anteriores (fromCache) além dos da rodada atual.
    createdAt: r.created_at || null,
    // Lista de membros + status de DMs (modo convite) — pro card exibir
    // ✓/✗/— nas colunas de DM Cliente/CX2/Escalada mesmo em rows do cache.
    membersList: Array.isArray(r.members_list) ? r.members_list : null,
    clientDmSent: extractDmStatus(r.members_list, "client"),
    cx2DmSent: extractDmStatus(r.members_list, "cx2"),
    escaladaDmSent: extractDmStatus(r.members_list, "escalada"),
    fromCache: true,
  }));

  // Initialize progress from cache
  const preCreated = job.results.filter(r => r.status === "created").length;
  job.progress.total = job._specs.length;
  job.progress.done = 0;
  job.progress.doneTotal = preCreated;
  job.progress.newInThisRun = 0;
  job.progress.updatedAt = new Date().toISOString();
  job.updatedAt = job.progress.updatedAt;

  // Edge case: nothing to do (all specs already created)
  if (pendingSpecs.length === 0) {
    job.status = "completed";
    job.updatedAt = new Date().toISOString();
    return;
  }

  let newThisRun = 0;

  try {
    const result = await baileys.createGroupsFromList(job.sessionId, pendingSpecs, {
      delaySec: job.config.delaySec,
      jitterMinSec: job.config.jitterMinSec || 0,
      jitterMaxSec: job.config.jitterMaxSec || 0,
      shouldCancel: () => job.cancelRequested,
      onProgress: (payload) => {
        // "processing_spec" marca qual spec o worker está começando a criar
        // AGORA — UI usa pra mostrar "⏳ Pendente" na linha certa.
        if (payload && payload.phase === "processing_spec") {
          job.progress.currentSpecHash = payload.specHash || null;
          job.progress.currentSpecName = payload.name || null;
          job.progress.updatedAt = new Date().toISOString();
          job.updatedAt = job.progress.updatedAt;
          return;
        }

        // waitForGroupCreateBudget / waitWithHeartbeat send heartbeat ticks with
        // { phase, remainingMs, ... } and no row/processed. Surface these as
        // waitPhase on job.progress so the frontend can render the right message.
        if (payload && payload.phase && !payload.row) {
          job.progress.waitPhase = payload.phase;
          job.progress.waitRemainingMs = payload.remainingMs || 0;
          if (typeof payload.used === "number") job.progress.hourlyUsed = payload.used;
          if (typeof payload.cap === "number") job.progress.hourlyCap = payload.cap;
          job.progress.updatedAt = new Date().toISOString();
          job.updatedAt = job.progress.updatedAt;
          return;
        }

        // Normal per-row progress tick — clear any leftover wait state + current spec
        job.progress.waitPhase = null;
        job.progress.waitRemainingMs = 0;
        job.progress.currentSpecHash = null;
        job.progress.currentSpecName = null;

        const { processed, total, row, rateLimited } = payload;

        // Merge the row into results by specHash
        const idx = job.results.findIndex(r => r.specHash === row.specHash);
        if (idx >= 0) {
          job.results[idx] = Object.assign({}, row, { fromCache: false });
        } else {
          job.results.push(Object.assign({}, row, { fromCache: false }));
        }

        if (row.status === "created") newThisRun++;

        const doneTotal = job.results.filter(r => r.status === "created").length;

        job.progress.total = job._specs.length;
        job.progress.done = processed;
        job.progress.doneTotal = doneTotal;
        job.progress.newInThisRun = newThisRun;
        job.progress.rateLimited = rateLimited;
        job.progress.updatedAt = new Date().toISOString();
        job.updatedAt = job.progress.updatedAt;
      },
    });

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

// Retry a single spec in an already-finished create-groups job. Called when
// the user clicks "↻ Tentar" on a failed row. Re-runs createGroupsFromList
// with just that spec, overwrites the row in job.results, upserts the new
// wa_group_creations row (on_conflict=source_session_id,spec_hash → replaces
// the old failed record). Fire-and-forget: the HTTP response acks immediately
// and the frontend sees progress via the next poll.
async function retryGroupInJob(jobId, specHash) {
  const job = getJob(jobId);
  if (!job) throw Object.assign(new Error("job_not_found"), { statusCode: 404 });
  if (job.type !== "create-groups") throw Object.assign(new Error("not a create-groups job"), { statusCode: 400 });
  if (!Array.isArray(job._specs) || job._specs.length === 0) {
    throw Object.assign(new Error("specs_not_available (job muito antigo, PM2 reiniciou)"), { statusCode: 410 });
  }

  const spec = job._specs.find(s => s && s.specHash === specHash);
  if (!spec) throw Object.assign(new Error("spec_not_found_in_job"), { statusCode: 404 });

  const rl = baileys.getRateLimitStatus(job.sessionId);
  if (rl) {
    const minutes = Math.ceil(rl.remainingMs / 60000);
    throw Object.assign(new Error("Sessão em cooldown (~" + minutes + "min)"), { statusCode: 429 });
  }

  // Mark current row as retrying so the UI shows a spinner immediately
  const rowIdx = (job.results || []).findIndex(r => r.specHash === specHash);
  if (rowIdx >= 0) {
    job.results[rowIdx] = Object.assign({}, job.results[rowIdx], {
      status: "pending",
      statusMessage: "retry em andamento…",
      fromCache: false,
    });
  }
  job.updatedAt = new Date().toISOString();

  // Fire-and-forget — the HTTP caller sees ack immediately; real result lands
  // via the next GET /api/jobs/:id poll.
  (async () => {
    try {
      const result = await baileys.createGroupsFromList(job.sessionId, [spec], {
        delaySec: job.config?.delaySec || 180,
        _leadingDelayMs: 30000, // 30s leading (menor que o normal pq é só 1 grupo)
        shouldCancel: () => false,
        onProgress: (payload) => {
          if (!payload || !payload.row) return;
          const r = payload.row;
          const idx = (job.results || []).findIndex(x => x.specHash === r.specHash);
          const merged = Object.assign({}, r, { fromCache: false });
          if (idx >= 0) job.results[idx] = merged;
          else job.results.push(merged);
          job.updatedAt = new Date().toISOString();
        },
      });
      const resultRow = result && result.results && result.results[0];
      if (resultRow) {
        const idx = (job.results || []).findIndex(r => r.specHash === specHash);
        const merged = Object.assign({}, resultRow, { fromCache: false });
        if (idx >= 0) job.results[idx] = merged;
        else job.results.push(merged);
      }
      job.updatedAt = new Date().toISOString();
    } catch (e) {
      console.error("[JOBS] retryGroupInJob error:", e && e.message);
      const idx = (job.results || []).findIndex(r => r.specHash === specHash);
      if (idx >= 0) {
        job.results[idx] = Object.assign({}, job.results[idx], {
          status: "failed",
          statusMessage: "retry falhou: " + (e && e.message || e),
        });
      }
      job.updatedAt = new Date().toISOString();
    }
  })();

  return { job, spec };
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
  startCreateGroupsJob,
  retryGroupInJob,
  summarizeJob,
};
