// ===== Sync status routes =====
const express = require("express");
const router = express.Router();
const { supaCount } = require("../services/supabase");

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
