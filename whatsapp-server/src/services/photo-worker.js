// ===== Photo Download Worker =====
// Background worker that downloads profile pictures from WhatsApp CDN
// and uploads them to Supabase Storage for permanent access.
// Rate limited: 1 photo every 5 seconds per session (720/hour).

const { supaRest } = require("./supabase");

const PHOTO_INTERVAL_MS = 5000; // 1 pic every 5 seconds
const MAX_ATTEMPTS = 3;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

// Active workers: sessionId -> intervalId
const activeWorkers = new Map();

// Reference to Socket.io for real-time updates
let _io = null;
function setIO(io) { _io = io; }

function startWorker(sessionId, sock) {
  if (activeWorkers.has(sessionId)) return;
  console.log("[PHOTO-WORKER] Starting for session:", sessionId);

  const intervalId = setInterval(() => {
    processNext(sessionId, sock).catch(e => {
      console.error("[PHOTO-WORKER] Tick error:", e.message);
    });
  }, PHOTO_INTERVAL_MS);

  activeWorkers.set(sessionId, intervalId);
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
  // 1. Dequeue: get next pending item, prioritizing recent chats
  const rows = await supaRest(
    "/rest/v1/wa_photo_queue?session_id=eq." + sessionId +
    "&status=eq.pending&attempts=lt." + MAX_ATTEMPTS +
    "&order=created_at.asc&limit=1" +
    "&select=id,jid"
  ).catch(() => []);

  if (!rows || rows.length === 0) return; // Nothing to process

  const item = rows[0];

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

    // 7. Update wa_chats with permanent URL (for groups and individual chats)
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
