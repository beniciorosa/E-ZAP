// ===== Sync status routes =====
const express = require("express");
const router = express.Router();
const { supaRest } = require("../services/supabase");

// GET /api/sync/:sessionId/status — Sync dashboard with counters
router.get("/:sessionId/status", async (req, res) => {
  try {
    const { sessionId } = req.params;

    // Parallel queries for all counters
    const [contacts, contactsWithPhoto, chats, chatsArchived, queuePending, queueDone, queueFailed, queueNoPhoto] = await Promise.all([
      supaRest("/rest/v1/wa_contacts?session_id=eq." + sessionId + "&select=id&limit=1", "GET", null, "count=exact").catch(() => []),
      supaRest("/rest/v1/wa_contacts?session_id=eq." + sessionId + "&photo_url=not.is.null&select=id&limit=1", "GET", null, "count=exact").catch(() => []),
      supaRest("/rest/v1/wa_chats?session_id=eq." + sessionId + "&select=id&limit=1", "GET", null, "count=exact").catch(() => []),
      supaRest("/rest/v1/wa_chats?session_id=eq." + sessionId + "&archived=eq.true&select=id&limit=1", "GET", null, "count=exact").catch(() => []),
      supaRest("/rest/v1/wa_photo_queue?session_id=eq." + sessionId + "&status=eq.pending&select=id&limit=1", "GET", null, "count=exact").catch(() => []),
      supaRest("/rest/v1/wa_photo_queue?session_id=eq." + sessionId + "&status=eq.done&select=id&limit=1", "GET", null, "count=exact").catch(() => []),
      supaRest("/rest/v1/wa_photo_queue?session_id=eq." + sessionId + "&status=eq.failed&select=id&limit=1", "GET", null, "count=exact").catch(() => []),
      supaRest("/rest/v1/wa_photo_queue?session_id=eq." + sessionId + "&status=eq.no_photo&select=id&limit=1", "GET", null, "count=exact").catch(() => []),
    ]);

    // Note: supaRest with count=exact returns arrays; the count comes from headers
    // which our simple REST client doesn't parse. Use array length as fallback,
    // or do a count query approach.

    // Alternative: use simple count queries
    const countQuery = async (table, filter = "") => {
      const rows = await supaRest(
        "/rest/v1/" + table + "?session_id=eq." + sessionId + filter + "&select=id"
      ).catch(() => []);
      return (rows || []).length;
    };

    // For accurate counts, we'll do count-based approach
    const [totalContacts, totalWithPhoto, totalChats, archivedChats] = await Promise.all([
      supaRest("/rest/v1/rpc/count_wa_contacts", "POST", { sid: sessionId }).catch(() => 0),
      supaRest("/rest/v1/rpc/count_wa_contacts_with_photo", "POST", { sid: sessionId }).catch(() => 0),
      supaRest("/rest/v1/rpc/count_wa_chats", "POST", { sid: sessionId }).catch(() => 0),
      supaRest("/rest/v1/rpc/count_wa_chats_archived", "POST", { sid: sessionId }).catch(() => 0),
    ]).catch(() => [0, 0, 0, 0]);

    // For photo queue, count by status (small table, OK to fetch IDs)
    const allQueue = await supaRest(
      "/rest/v1/wa_photo_queue?session_id=eq." + sessionId + "&select=status"
    ).catch(() => []);

    const qCounts = { pending: 0, downloading: 0, done: 0, failed: 0, no_photo: 0 };
    for (const q of (allQueue || [])) {
      qCounts[q.status] = (qCounts[q.status] || 0) + 1;
    }

    // Fallback for contacts/chats if RPC not available
    let cTotal = totalContacts, cPhoto = totalWithPhoto, chTotal = totalChats, chArchived = archivedChats;
    if (typeof cTotal !== "number") {
      // RPC doesn't exist — use array counts (limited to first page)
      const c1 = await supaRest("/rest/v1/wa_contacts?session_id=eq." + sessionId + "&select=id&limit=10000").catch(() => []);
      const c2 = await supaRest("/rest/v1/wa_contacts?session_id=eq." + sessionId + "&photo_url=not.is.null&select=id&limit=10000").catch(() => []);
      const ch1 = await supaRest("/rest/v1/wa_chats?session_id=eq." + sessionId + "&select=id&limit=10000").catch(() => []);
      const ch2 = await supaRest("/rest/v1/wa_chats?session_id=eq." + sessionId + "&archived=eq.true&select=id&limit=10000").catch(() => []);
      cTotal = (c1 || []).length;
      cPhoto = (c2 || []).length;
      chTotal = (ch1 || []).length;
      chArchived = (ch2 || []).length;
    }

    res.json({
      contacts: {
        total: cTotal,
        withPhoto: cPhoto,
        pending: qCounts.pending + qCounts.downloading,
      },
      chats: {
        total: chTotal,
        archived: chArchived,
      },
      photoQueue: qCounts,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
