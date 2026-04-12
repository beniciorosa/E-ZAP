// ===== Photo Download Worker =====
// Background worker that downloads profile pictures from WhatsApp CDN
// and uploads them to Supabase Storage for permanent access.
//
// ARCHITECTURE: One worker per session, each running independently.
// Each session has its own WhatsApp rate limit, so parallel is safe.
// Rate: 1 photo every 8 seconds per session.
// With 17 sessions: ~7000 photos in ~35 minutes.

const { supaRest } = require("./supabase");

const PHOTO_INTERVAL_MS = 8000; // 1 pic every 8 seconds per session
const MAX_ATTEMPTS = 3;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

// Active workers: sessionId -> intervalId
const activeWorkers = new Map();
// Global stats
const _stats = { processed: 0, done: 0, noPhoto: 0, failed: 0 };

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
