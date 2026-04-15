// ===== Sync status routes =====
const express = require("express");
const router = express.Router();
const { supaCount, supaRpc } = require("../services/supabase");
const photoWorker = require("../services/photo-worker");

// ===== Photo-worker global control =====
// IMPORTANT: literal paths must be registered BEFORE the /:sessionId/status
// wildcard below — otherwise Express routes /photo-worker/status to the
// parametrized handler with sessionId="photo-worker", which swallows the
// response and breaks the UI toggle. Order matters here.

// GET /api/sync/photo-worker/status — { globalPaused: bool }
router.get("/photo-worker/status", (req, res) => {
  res.json({ globalPaused: photoWorker.isGlobalPaused() });
});

// POST /api/sync/photo-worker/pause — toggle on
router.post("/photo-worker/pause", (req, res) => {
  photoWorker.pauseGlobal();
  res.json({ ok: true, globalPaused: true });
});

// POST /api/sync/photo-worker/resume — toggle off
router.post("/photo-worker/resume", (req, res) => {
  photoWorker.resumeGlobal();
  res.json({ ok: true, globalPaused: false });
});

// GET /api/sync/status-all — Batch sync dashboard for ALL sessions in ONE
// Supabase round-trip. Uses the get_sync_status_all() RPC which returns per
// -session counters via indexed FILTER aggregates. Replaces the N * 9 COUNT
// HEAD requests from the previous per-session endpoint (which was seq
// scanning wa_photo_queue every 10s and starving the Supabase pooler).
// Cached in-memory for SYNC_STATUS_CACHE_MS to survive rapid reloads.
let _syncStatusCache = null;
let _syncStatusCachedAt = 0;
const SYNC_STATUS_CACHE_MS = 5000;

router.get("/status-all", async (req, res) => {
  try {
    const now = Date.now();
    if (_syncStatusCache && now - _syncStatusCachedAt < SYNC_STATUS_CACHE_MS) {
      return res.json(_syncStatusCache);
    }
    const rows = await supaRpc("get_sync_status_all", {});
    const bySession = {};
    for (const r of rows || []) {
      bySession[r.session_id] = {
        contacts: {
          total: Number(r.total_contacts) || 0,
          withPhoto: Number(r.contacts_with_photo) || 0,
          pending: (Number(r.q_pending) || 0) + (Number(r.q_downloading) || 0),
        },
        chats: {
          total: Number(r.total_chats) || 0,
          archived: Number(r.archived_chats) || 0,
        },
        photoQueue: {
          pending: Number(r.q_pending) || 0,
          downloading: Number(r.q_downloading) || 0,
          done: Number(r.q_done) || 0,
          failed: Number(r.q_failed) || 0,
          no_photo: Number(r.q_no_photo) || 0,
        },
      };
    }
    const payload = { ok: true, bySession, cachedAt: now };
    _syncStatusCache = payload;
    _syncStatusCachedAt = now;
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sync/:sessionId/status — Sync dashboard with counters
// Uses supaCount (HEAD + count=exact + Content-Range) for accurate counts
// without hitting the PostgREST 1000-row default page cap.
router.get("/:sessionId/status", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const sid = encodeURIComponent(sessionId);

    const [
      totalContacts, contactsWithPhoto, totalChats, archivedChats,
      qPending, qDownloading, qDone, qFailed, qNoPhoto,
    ] = await Promise.all([
      supaCount("/rest/v1/wa_contacts?session_id=eq." + sid).catch(() => 0),
      supaCount("/rest/v1/wa_contacts?session_id=eq." + sid + "&photo_url=not.is.null").catch(() => 0),
      supaCount("/rest/v1/wa_chats?session_id=eq." + sid).catch(() => 0),
      supaCount("/rest/v1/wa_chats?session_id=eq." + sid + "&archived=eq.true").catch(() => 0),
      supaCount("/rest/v1/wa_photo_queue?session_id=eq." + sid + "&status=eq.pending").catch(() => 0),
      supaCount("/rest/v1/wa_photo_queue?session_id=eq." + sid + "&status=eq.downloading").catch(() => 0),
      supaCount("/rest/v1/wa_photo_queue?session_id=eq." + sid + "&status=eq.done").catch(() => 0),
      supaCount("/rest/v1/wa_photo_queue?session_id=eq." + sid + "&status=eq.failed").catch(() => 0),
      supaCount("/rest/v1/wa_photo_queue?session_id=eq." + sid + "&status=eq.no_photo").catch(() => 0),
    ]);

    res.json({
      contacts: {
        total: totalContacts,
        withPhoto: contactsWithPhoto,
        pending: qPending + qDownloading,
      },
      chats: {
        total: totalChats,
        archived: archivedChats,
      },
      photoQueue: {
        pending: qPending,
        downloading: qDownloading,
        done: qDone,
        failed: qFailed,
        no_photo: qNoPhoto,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
