// ===== Photo Download Worker =====
// Background worker that downloads profile pictures from WhatsApp CDN
// and uploads them to Supabase Storage for permanent access.
//
// ARCHITECTURE: One worker per session, each running independently.
// Each session has its own WhatsApp rate limit, so parallel is safe.
// Rate: 1 photo every 60 seconds per session — intentionally slow so the
// sync drifts in over days/week rather than flooding the IQ budget. After
// observing cascading "Timed Out" failures from WhatsApp silently rate-
// limiting the profilePictureUrl IQ, we prefer correctness over throughput.
//
// AUTO-PAUSE ON TIMEOUT CASCADE: if a session sees 10 consecutive Timed Out
// errors, we assume WhatsApp is silently throttling the account and pause
// this session's worker for 15 minutes (and mark rate-limit in baileys so
// create-groups jobs see the cooldown too).
//
// FAILED ROWS ARE NOT RETRIED: once a row hits MAX_ATTEMPTS it stays failed
// forever. The user can trigger a manual retry later via SQL when accounts
// are healthy — we do not auto-reset to avoid re-poking cold accounts.

const { supaRest } = require("./supabase");

const PHOTO_INTERVAL_MS = 60000; // 1 pic every 60 seconds per session
const MAX_ATTEMPTS = 3;
const FAILURE_STREAK_PAUSE_THRESHOLD = 10;
const AUTO_PAUSE_MS = 15 * 60 * 1000; // 15 min pause after cascade detected
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

// Active workers: sessionId -> intervalId
const activeWorkers = new Map();
// Paused workers: sessionId -> { sock, reason, autoResumeAt } — kept so resumeSession can restart without losing state
const pausedWorkers = new Map();
// Per-session consecutive failure counter (reset on any success or no_photo)
const failureStreaks = new Map();
// Global stats
const _stats = { processed: 0, done: 0, noPhoto: 0, failed: 0 };

// Injected by index.js on startup — avoids a require() cycle with baileys.js
let _markRateLimit = null;
function setRateLimitMarker(fn) { _markRateLimit = fn; }

// Reference to Socket.io for real-time updates
let _io = null;
function setIO(io) { _io = io; }

function startWorker(sessionId, sock) {
  if (activeWorkers.has(sessionId)) return;
  console.log("[PHOTO-WORKER] Starting for session:", sessionId);

  // Stagger start: random delay 0-5s to avoid all sessions hitting at once
  const stagger = Math.floor(Math.random() * 5000);
  setTimeout(() => {
    if (!activeWorkers.has(sessionId)) {
      const intervalId = setInterval(() => {
        processNext(sessionId, sock).catch(e => {
          // Only log every 10th error to avoid flooding
          if (_stats.failed % 10 === 1) {
            console.error("[PHOTO-WORKER] Tick error for", sessionId.substring(0, 8) + ":", e.message);
          }
        });
      }, PHOTO_INTERVAL_MS);
      activeWorkers.set(sessionId, intervalId);
    }
  }, stagger);
}

function stopWorker(sessionId) {
  const id = activeWorkers.get(sessionId);
  if (id) {
    clearInterval(id);
    activeWorkers.delete(sessionId);
    console.log("[PHOTO-WORKER] Stopped for session:", sessionId);
  }
  // Also drop any paused state — stopWorker is called on disconnect and the
  // underlying sock becomes invalid, so a stale paused entry would try to
  // resume on a dead socket.
  pausedWorkers.delete(sessionId);
}

// Temporarily silence the per-session IQ firehose (profilePictureUrl calls).
// Used by createGroupsFromList to avoid competing IQ stanzas that starve
// the WhatsApp rate budget and cause groupCreate to be rate-limited.
// Also used by the auto-pause-on-timeout-cascade logic.
// Safe to call even if the worker isn't running.
function pauseSession(sessionId, sock, meta) {
  if (pausedWorkers.has(sessionId)) return; // already paused
  const id = activeWorkers.get(sessionId);
  if (id) {
    clearInterval(id);
    activeWorkers.delete(sessionId);
  }
  pausedWorkers.set(sessionId, {
    sock: sock || null,
    reason: (meta && meta.reason) || "manual",
    autoResumeAt: (meta && meta.autoResumeAt) || null,
  });
  console.log("[PHOTO-WORKER] Paused for session:", sessionId, "reason:", (meta && meta.reason) || "manual");
}

// Resume a previously paused session. No-op if the session isn't paused.
function resumeSession(sessionId, sock) {
  const entry = pausedWorkers.get(sessionId);
  if (!entry) return;
  pausedWorkers.delete(sessionId);
  // Re-start the worker fresh. Prefer the sock provided here (caller has the
  // live one); fall back to whatever was stored at pause time.
  const live = sock || entry.sock;
  if (!live) return;
  startWorker(sessionId, live);
  console.log("[PHOTO-WORKER] Resumed for session:", sessionId);
}

function isPaused(sessionId) {
  return pausedWorkers.has(sessionId);
}

// Lightweight health snapshot for a session — used by sessions route and
// createGroupsFromList to decide whether a bulk job is safe right now.
function getSessionHealth(sessionId) {
  const paused = pausedWorkers.get(sessionId);
  return {
    failureStreak: failureStreaks.get(sessionId) || 0,
    paused: !!paused,
    pauseReason: paused ? paused.reason : null,
    autoResumeAt: paused && paused.autoResumeAt ? new Date(paused.autoResumeAt).toISOString() : null,
  };
}

async function processNext(sessionId, sock) {
  // Skip if socket disconnected
  if (!sock || !sock.user) return;

  // 1. Dequeue: get next pending item
  const rows = await supaRest(
    "/rest/v1/wa_photo_queue?session_id=eq." + sessionId +
    "&status=eq.pending&attempts=lt." + MAX_ATTEMPTS +
    "&order=created_at.asc&limit=1" +
    "&select=id,jid,attempts"
  ).catch(() => []);

  if (!rows || rows.length === 0) return; // Nothing for this session

  const item = rows[0];
  _stats.processed++;

  // Log progress every 100 items
  if (_stats.processed % 100 === 0) {
    console.log("[PHOTO-WORKER] Progress: processed=" + _stats.processed +
      " done=" + _stats.done + " noPhoto=" + _stats.noPhoto +
      " failed=" + _stats.failed + " workers=" + activeWorkers.size);
  }

  // 2. Mark as downloading
  await supaRest(
    "/rest/v1/wa_photo_queue?id=eq." + item.id,
    "PATCH",
    { status: "downloading", last_attempt_at: new Date().toISOString() },
    "return=minimal"
  ).catch(() => {});

  try {
    // 3. Get CDN URL from WhatsApp
    let cdnUrl;
    try {
      cdnUrl = await sock.profilePictureUrl(item.jid, "image");
    } catch (e) {
      // 404 = no profile picture set
      if (e.message?.includes("404") || e.message?.includes("not-authorized") || e.message?.includes("item-not-found")) {
        await supaRest(
          "/rest/v1/wa_photo_queue?id=eq." + item.id,
          "PATCH",
          { status: "no_photo" },
          "return=minimal"
        );
        _stats.noPhoto++;
        failureStreaks.delete(sessionId);
        return;
      }
      throw e;
    }

    if (!cdnUrl) {
      await supaRest(
        "/rest/v1/wa_photo_queue?id=eq." + item.id,
        "PATCH",
        { status: "no_photo" },
        "return=minimal"
      );
      _stats.noPhoto++;
      return;
    }

    // 4. Download image from WhatsApp CDN
    const imgResp = await fetch(cdnUrl);
    if (!imgResp.ok) throw new Error("CDN download failed: " + imgResp.status);
    const imgBuffer = Buffer.from(await imgResp.arrayBuffer());

    // 5. Upload to Supabase Storage
    const safeName = item.jid.replace(/@/g, "_").replace(/:/g, "_") + ".jpg";
    const storagePath = sessionId + "/" + safeName;
    const publicUrl = await uploadToStorage(storagePath, imgBuffer);

    // 6. Update wa_contacts with permanent URL
    await supaRest(
      "/rest/v1/wa_contacts?session_id=eq." + sessionId + "&contact_jid=eq." + encodeURIComponent(item.jid),
      "PATCH",
      { photo_url: publicUrl, photo_updated_at: new Date().toISOString() },
      "return=minimal"
    ).catch(() => {});

    // 7. Update wa_chats with permanent URL
    await supaRest(
      "/rest/v1/wa_chats?session_id=eq." + sessionId + "&chat_jid=eq." + encodeURIComponent(item.jid),
      "PATCH",
      { photo_url: publicUrl },
      "return=minimal"
    ).catch(() => {});

    // 8. Mark queue item as done
    await supaRest(
      "/rest/v1/wa_photo_queue?id=eq." + item.id,
      "PATCH",
      { status: "done" },
      "return=minimal"
    );

    _stats.done++;
    failureStreaks.delete(sessionId); // reset consecutive-failure counter on success

    // 9. Emit real-time event so UI can update avatar
    if (_io) {
      _io.emit("photo:ready", { sessionId, jid: item.jid, photoUrl: publicUrl });
    }

  } catch (e) {
    // Mark as failed, increment attempts
    const newAttempts = (item.attempts || 0) + 1;
    await supaRest(
      "/rest/v1/wa_photo_queue?id=eq." + item.id,
      "PATCH",
      {
        status: newAttempts >= MAX_ATTEMPTS ? "failed" : "pending",
        attempts: newAttempts,
        error: e.message?.substring(0, 200) || "Unknown error",
      },
      "return=minimal"
    ).catch(() => {});

    if (newAttempts >= MAX_ATTEMPTS) _stats.failed++;

    // Failure streak detection — if WhatsApp silently stops responding to
    // profilePictureUrl (cascade of "Timed Out"), pause this session's worker
    // for 15 min and mark it as rate-limited so create-groups jobs block too.
    const msg = (e?.message || "").toLowerCase();
    const isTimeout = msg.includes("timed out") || msg.includes("timeout");
    if (isTimeout) {
      const streak = (failureStreaks.get(sessionId) || 0) + 1;
      failureStreaks.set(sessionId, streak);
      if (streak >= FAILURE_STREAK_PAUSE_THRESHOLD) {
        console.warn("[PHOTO-WORKER] " + streak + " consecutive timeouts on", sessionId, "— auto-pausing for 15min");
        if (_markRateLimit) {
          try { _markRateLimit(sessionId); } catch (_) {}
        }
        pauseSession(sessionId, sock, {
          reason: "timeout_cascade",
          autoResumeAt: Date.now() + AUTO_PAUSE_MS,
        });
        setTimeout(() => {
          if (pausedWorkers.has(sessionId) && pausedWorkers.get(sessionId).reason === "timeout_cascade") {
            console.log("[PHOTO-WORKER] Auto-resuming", sessionId, "after 15min timeout pause");
            failureStreaks.delete(sessionId);
            resumeSession(sessionId);
          }
        }, AUTO_PAUSE_MS);
      }
    }
  }
}

async function uploadToStorage(path, buffer) {
  const url = SUPA_URL + "/storage/v1/object/profile-photos/" + path;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + SUPA_KEY,
      "Content-Type": "image/jpeg",
      "x-upsert": "true",
    },
    body: buffer,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error("Storage upload failed " + resp.status + ": " + errText);
  }

  return SUPA_URL + "/storage/v1/object/public/profile-photos/" + path;
}

module.exports = { setIO, setRateLimitMarker, startWorker, stopWorker, pauseSession, resumeSession, isPaused, getSessionHealth };
