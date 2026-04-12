// ===== Photo Download Worker =====
// Background worker that downloads profile pictures from WhatsApp CDN
// and uploads them to Supabase Storage for permanent access.
//
// ARCHITECTURE: Single global loop processes ONE photo at a time,
// rotating between sessions. This avoids rate limiting from
// 17 sessions making simultaneous profilePictureUrl() calls.
//
// Rate: 1 photo every 5 seconds globally (~720/hour total).
// With 7000 photos, takes ~10 hours to process all.

const { supaRest } = require("./supabase");

const PHOTO_INTERVAL_MS = 5000; // 1 pic every 5 seconds (global)
const MAX_ATTEMPTS = 3;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

// Registered sessions: sessionId -> sock
const registeredSessions = new Map();

// Global loop state
let _loopRunning = false;
let _loopInterval = null;
let _currentSessionIndex = 0;
let _stats = { processed: 0, done: 0, noPhoto: 0, failed: 0, errors: 0 };

// Reference to Socket.io for real-time updates
let _io = null;
function setIO(io) { _io = io; }

function startWorker(sessionId, sock) {
  registeredSessions.set(sessionId, sock);
  console.log("[PHOTO-WORKER] Registered session:", sessionId, "(" + registeredSessions.size + " total)");

  // Start global loop if not running
  if (!_loopRunning) {
    _loopRunning = true;
    _loopInterval = setInterval(() => {
      processNextGlobal().catch(e => {
        _stats.errors++;
        if (_stats.errors % 50 === 1) {
          console.error("[PHOTO-WORKER] Loop error:", e.message);
        }
      });
    }, PHOTO_INTERVAL_MS);
    console.log("[PHOTO-WORKER] Global loop started (interval: " + PHOTO_INTERVAL_MS + "ms)");
  }
}

function stopWorker(sessionId) {
  registeredSessions.delete(sessionId);
  console.log("[PHOTO-WORKER] Unregistered session:", sessionId, "(" + registeredSessions.size + " remaining)");

  // Stop global loop if no sessions left
  if (registeredSessions.size === 0 && _loopInterval) {
    clearInterval(_loopInterval);
    _loopInterval = null;
    _loopRunning = false;
    console.log("[PHOTO-WORKER] Global loop stopped (no sessions)");
  }
}

async function processNextGlobal() {
  if (registeredSessions.size === 0) return;

  // Round-robin: pick next session
  const sessionIds = Array.from(registeredSessions.keys());
  _currentSessionIndex = _currentSessionIndex % sessionIds.length;
  const sessionId = sessionIds[_currentSessionIndex];
  const sock = registeredSessions.get(sessionId);
  _currentSessionIndex++;

  if (!sock) return;

  // Check if sock is still connected
  if (!sock.user) {
    // Socket disconnected, skip this session
    return;
  }

  await processNext(sessionId, sock);
}

async function processNext(sessionId, sock) {
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

  // Log progress every 50 items
  if (_stats.processed % 50 === 0) {
    console.log("[PHOTO-WORKER] Progress: processed=" + _stats.processed +
      " done=" + _stats.done + " noPhoto=" + _stats.noPhoto +
      " failed=" + _stats.failed + " errors=" + _stats.errors);
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
    else _stats.errors++;
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

module.exports = { setIO, startWorker, stopWorker };
