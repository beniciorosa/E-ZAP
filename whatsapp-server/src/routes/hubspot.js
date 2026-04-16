// ===== HubSpot ticket resolution routes =====
// Endpoints for the grupos.html "Tickets HubSpot" tab: resolve ticket IDs
// against the local `mentorados` table (populated by the hubspot-tickets
// Edge Function webhook), falling back to the HubSpot REST API for any
// tickets not yet in the table. Fresh API lookups are written back to
// `mentorados` so the next resolve hits the cache.

const express = require("express");
const router = express.Router();
const { supaRest } = require("../services/supabase");
const { fetchTicketFromApi, upsertMentorado } = require("../services/hubspot-api");

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

    const byId = {};
    for (const r of (mentoradosRows || [])) {
      if (r && r.ticket_id != null) byId[Number(r.ticket_id)] = r;
    }

    // 2. Fallback: tickets missing from mentorados get fetched from the
    // HubSpot REST API using the hubspot_api_key stored in app_settings.
    // Results are upserted back into mentorados (with on_conflict=ticket_id)
    // so the next resolve hits the cache. This keeps the webhook + API
    // paths converged on the same table.
    const missing = ids.filter((id) => !byId[id]);
    let hsKey = null;
    let hsAuthError = null;
    if (missing.length > 0) {
      try {
        const settingRows = await supaRest(
          "/rest/v1/app_settings?key=eq.hubspot_api_key&select=value"
        );
        if (settingRows && settingRows[0] && settingRows[0].value) {
          hsKey = settingRows[0].value;
        }
      } catch (e) {
        console.error("[HUBSPOT] failed to load hubspot_api_key:", e.message);
      }

      if (hsKey) {
        // Fetch in parallel but cap at 8 concurrent to stay inside HubSpot's
        // 100 req/10s budget when a big batch hits the API at once.
        const CONCURRENCY = 8;
        for (let i = 0; i < missing.length; i += CONCURRENCY) {
          const chunk = missing.slice(i, i + CONCURRENCY);
          const fetched = await Promise.all(chunk.map(async (id) => {
            try {
              const row = await fetchTicketFromApi(id, hsKey);
              return { id, row };
            } catch (e) {
              if (/auth/i.test(e.message)) hsAuthError = e.message;
              console.error("[HUBSPOT] fetchTicketFromApi failed for", id, ":", e.message);
              return { id, row: null };
            }
          }));
          for (const { id, row } of fetched) {
            if (row) {
              byId[id] = row;
              // Fire-and-forget upsert — don't block the resolve on it.
              upsertMentorado(row, supaRest).catch(() => {});
            }
          }
        }
      }
    }

    // 3. Build a label -> { id, phone } map from connected wa_sessions.
    // mentor_responsavel matches wa_sessions.label literally (confirmed in
    // production: "Rodrigo Zangirolimo", "Eduardo Gossi", etc).
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

    // 4. Walk the requested ids in order, resolving each
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
        source: r._source || "mentorados", // "hubspot_api" if fallback hit
      });
    }

    const response = { ok: true, resolved, notFound };
    if (hsAuthError) response.hubspotAuthError = hsAuthError;
    if (missing.length > 0 && !hsKey) response.hubspotKeyMissing = true;
    res.json(response);
  } catch (e) {
    console.error("[HUBSPOT] resolve-tickets error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
