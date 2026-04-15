// ===== HubSpot ticket resolution routes =====
// Endpoints for the grupos.html "Tickets HubSpot" tab: resolve ticket IDs
// against the local `mentorados` table (populated by the hubspot-tickets
// Edge Function webhook) and bridge mentor_responsavel to a connected
// wa_sessions label so the frontend can build group creation specs with
// zero HubSpot API calls.

const express = require("express");
const router = express.Router();
const { supaRest } = require("../services/supabase");

// POST /api/hubspot/resolve-tickets
// Body: { ticketIds: number[] }
// Returns:
//   {
//     ok: true,
//     resolved: [
//       {
//         ticket_id, ticket_name, mentor, whatsapp,
//         tier: "pro" | "business" | "starter" | null,
//         mentorSessionId, mentorSessionPhone,
//         warning: null | "mentor_sem_sessao_conectada" | "sem_tier_definido"
//       },
//       ...
//     ],
//     notFound: number[]
//   }
router.post("/resolve-tickets", async (req, res) => {
  try {
    const raw = Array.isArray(req.body && req.body.ticketIds) ? req.body.ticketIds : [];
    const ids = Array.from(new Set(raw.map(Number).filter(n => Number.isFinite(n) && n > 0)));
    if (ids.length === 0) {
      return res.status(400).json({ error: "ticketIds (array de inteiros positivos) é obrigatório" });
    }
    if (ids.length > 200) {
      return res.status(400).json({ error: "Máximo de 200 tickets por chamada" });
    }

    // 1. Batch fetch from mentorados — the Hubspot webhook populates this
    // table with ticket_name, mentor_responsavel, whatsapp_do_mentorado and
    // the 3 tier booleans derived from the line item associated with the
    // ticket (see supabase/functions/hubspot-tickets/index.ts).
    const mentoradosRows = await supaRest(
      "/rest/v1/mentorados?ticket_id=in.(" + ids.join(",") +
      ")&select=ticket_id,ticket_name,mentor_responsavel,whatsapp_do_mentorado,mentoria_starter,mentoria_pro,mentoria_business"
    ).catch((e) => {
      console.error("[HUBSPOT] mentorados fetch error:", e.message);
      return [];
    });

    // 2. Build a label -> { id, phone } map from connected wa_sessions.
    // mentor_responsavel in mentorados matches wa_sessions.label literally
    // (confirmed in production: "Rodrigo Zangirolimo", "Eduardo Gossi", etc).
    const sessionRows = await supaRest(
      "/rest/v1/wa_sessions?status=eq.connected&select=id,label,phone"
    ).catch((e) => {
      console.error("[HUBSPOT] wa_sessions fetch error:", e.message);
      return [];
    });
    const labelToSession = {};
    for (const s of (sessionRows || [])) {
      if (s && s.label) {
        labelToSession[String(s.label).trim().toLowerCase()] = { id: s.id, phone: s.phone };
      }
    }

    // 3. Build lookup by ticket_id and walk the requested ids in order
    const byId = {};
    for (const r of (mentoradosRows || [])) {
      if (r && r.ticket_id != null) byId[Number(r.ticket_id)] = r;
    }

    const resolved = [];
    const notFound = [];

    for (const id of ids) {
      const r = byId[id];
      if (!r) { notFound.push(id); continue; }

      const tier = r.mentoria_pro ? "pro"
                 : r.mentoria_business ? "business"
                 : r.mentoria_starter ? "starter"
                 : null;

      const mentorKey = String(r.mentor_responsavel || "").trim().toLowerCase();
      const mentorSession = mentorKey ? labelToSession[mentorKey] : null;

      let warning = null;
      if (!mentorSession) warning = "mentor_sem_sessao_conectada";
      else if (!tier) warning = "sem_tier_definido";

      resolved.push({
        ticket_id: r.ticket_id,
        ticket_name: r.ticket_name,
        mentor: r.mentor_responsavel,
        whatsapp: r.whatsapp_do_mentorado,
        tier,
        mentorSessionId: mentorSession ? mentorSession.id : null,
        mentorSessionPhone: mentorSession ? mentorSession.phone : null,
        warning,
      });
    }

    res.json({ ok: true, resolved, notFound });
  } catch (e) {
    console.error("[HUBSPOT] resolve-tickets error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
