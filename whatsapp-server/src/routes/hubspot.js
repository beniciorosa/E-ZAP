// ===== HubSpot ticket resolution routes =====
// Endpoints for the grupos.html "Tickets HubSpot" tab: resolve ticket IDs
// against the local `mentorados` table (populated by the hubspot-tickets
// Edge Function webhook), falling back to the HubSpot REST API for any
// tickets not yet in the table. Fresh API lookups are written back to
// `mentorados` so the next resolve hits the cache.

const express = require("express");
const router = express.Router();
const { supaRest, expandPhonesToJids } = require("../services/supabase");
const {
  fetchTicketFromApi, upsertMentorado,
  searchMeetingsByDateRange, getMeetingContactIds, getContactPhoneDigits,
} = require("../services/hubspot-api");

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

// ===== Group creation history per session =====
// Returns the wa_group_creations rows for a session + member list per group.
router.get("/group-history/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    // 1. Fetch group creation records
    const creations = await supaRest(
      "/rest/v1/wa_group_creations?source_session_id=eq." + encodeURIComponent(sessionId) +
      "&select=id,spec_hash,group_name,group_jid,status,status_message,members_total,members_added,has_description,has_photo,locked,welcome_sent,invite_link,created_at" +
      "&order=created_at.desc&limit=100"
    ).catch(() => []);

    // 2. For groups that have a group_jid, batch-fetch their members
    const jids = (creations || []).map(c => c.group_jid).filter(Boolean);
    let membersByJid = {};
    if (jids.length > 0) {
      const memberRows = await supaRest(
        "/rest/v1/group_members?group_jid=in.(" + jids.map(encodeURIComponent).join(",") +
        ")&left_at=is.null&select=group_jid,member_phone,member_name,role&order=role.desc,first_seen.asc&limit=1000"
      ).catch(() => []);

      // Resolve LID-based member_phones to real phone numbers via lid_phone_map.
      // WhatsApp's LID mode stores internal IDs (e.g. "129936316698644") instead
      // of real phones (e.g. "5521983336299") in the event handler. The mapping
      // table bridges them.
      const lidPhones = (memberRows || [])
        .map(m => m.member_phone)
        .filter(p => p && /^\d{10,18}$/.test(p) && !p.startsWith("55"));
      let lidToPhone = {};
      if (lidPhones.length > 0) {
        const uniqueLids = [...new Set(lidPhones)];
        const lidRows = await supaRest(
          "/rest/v1/lid_phone_map?lid=in.(" +
          uniqueLids.map(l => encodeURIComponent(l + "@lid")).join(",") +
          ")&select=lid,phone"
        ).catch(() => []);
        for (const r of (lidRows || [])) {
          if (r.lid && r.phone) {
            const lidNum = r.lid.replace("@lid", "");
            lidToPhone[lidNum] = r.phone;
          }
        }
      }

      for (const m of (memberRows || [])) {
        if (!membersByJid[m.group_jid]) membersByJid[m.group_jid] = [];
        const resolvedPhone = lidToPhone[m.member_phone] || m.member_phone;
        membersByJid[m.group_jid].push({
          phone: resolvedPhone,
          lid: lidToPhone[m.member_phone] ? m.member_phone : null,
          name: m.member_name || null,
          role: m.role || "member",
        });
      }
    }

    // 3. Enrich each creation row with its member list
    const result = (creations || []).map(c => ({
      ...c,
      members: c.group_jid ? (membersByJid[c.group_jid] || []) : [],
    }));

    res.json({ ok: true, history: result });
  } catch (e) {
    console.error("[HUBSPOT] group-history error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== Ticket lookup (ancora por hubspot_ticket_id) =====
// Retorna TUDO que sabemos sobre um ticket numa única chamada:
//  - mentorado: row da tabela mentorados (fonte HubSpot via webhook)
//  - groups: array de wa_group_creations com esse hubspot_ticket_id (1+ se recriou)
//  - members: membros adicionados em cada grupo (group_members)
//
// Exemplo: GET /api/hubspot/ticket/44391166513
router.get("/ticket/:ticketId", async (req, res) => {
  const ticketId = req.params.ticketId;
  if (!/^\d+$/.test(String(ticketId))) {
    return res.status(400).json({ error: "ticketId inválido" });
  }

  try {
    // 1. Rows de wa_group_creations (pode ter mais de uma se o grupo foi recriado)
    const creations = await supaRest(
      "/rest/v1/wa_group_creations?hubspot_ticket_id=eq." + encodeURIComponent(ticketId) +
      "&select=*&order=created_at.desc"
    );

    // 2. Row do mentorados (dados frescos, incluindo pipeline/stage atualizados)
    const mentoradoRows = await supaRest(
      "/rest/v1/mentorados?ticket_id=eq." + encodeURIComponent(ticketId) + "&select=*&limit=1"
    );
    const mentorado = Array.isArray(mentoradoRows) && mentoradoRows.length > 0 ? mentoradoRows[0] : null;

    // 3. Membros de todos os grupos listados (audit trail)
    const jids = (creations || []).map(c => c.group_jid).filter(Boolean);
    let membersByJid = {};
    if (jids.length > 0) {
      const inList = jids.map(j => '"' + j + '"').join(",");
      const members = await supaRest(
        "/rest/v1/group_members?group_jid=in.(" + encodeURIComponent(inList) +
        ")&select=group_jid,member_phone,member_name,role"
      );
      (members || []).forEach(m => {
        if (!membersByJid[m.group_jid]) membersByJid[m.group_jid] = [];
        membersByJid[m.group_jid].push({
          phone: m.member_phone,
          name: m.member_name || null,
          role: m.role || "member",
        });
      });
    }

    const groups = (creations || []).map(c => ({
      ...c,
      members: c.group_jid ? (membersByJid[c.group_jid] || []) : [],
    }));

    res.json({
      ok: true,
      ticketId: Number(ticketId),
      mentorado: mentorado,
      groups: groups,
    });
  } catch (e) {
    console.error("[HUBSPOT] ticket lookup error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== Per-session message templates =====
// Saves/loads the 3 editable message templates (description, welcome,
// rejectDm) to app_settings keyed by "hubspot_templates_{sessionId}".
// This lets the user save their preferred copy per session and reload
// it next time without retyping.

// POST /api/hubspot/templates/:sessionId
router.post("/templates/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { description, welcome, rejectDm } = req.body || {};
    const key = "hubspot_templates_" + sessionId;
    const value = JSON.stringify({ description: description || "", welcome: welcome || "", rejectDm: rejectDm || "" });
    await supaRest(
      "/rest/v1/app_settings?on_conflict=key",
      "POST",
      [{ key, value }],
      "resolution=merge-duplicates,return=minimal"
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("[HUBSPOT] save templates error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/hubspot/templates/:sessionId
router.get("/templates/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const key = "hubspot_templates_" + sessionId;
    const rows = await supaRest(
      "/rest/v1/app_settings?key=eq." + encodeURIComponent(key) + "&select=value"
    ).catch(() => []);
    if (rows && rows[0] && rows[0].value) {
      try {
        const templates = JSON.parse(rows[0].value);
        return res.json({ ok: true, templates });
      } catch (_) {}
    }
    res.json({ ok: true, templates: null });
  } catch (e) {
    console.error("[HUBSPOT] load templates error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== Espelho hubspot_tickets (fonte: Supabase, não HubSpot direto) =====
// Lê da tabela hubspot_tickets (populada pela Edge Function via webhook/backfill).
// Consumir daqui em vez da API HubSpot evita rate limit e reduz latência.

// GET /api/hubspot/tickets/:ticketId — retorna 1 row da v_ticket_full (merge pré+mentoria)
router.get("/tickets/:ticketId", async (req, res) => {
  const ticketId = req.params.ticketId;
  if (!/^\d+$/.test(String(ticketId))) {
    return res.status(400).json({ error: "ticketId inválido" });
  }
  try {
    const rows = await supaRest(
      "/rest/v1/v_ticket_full?ticket_id=eq." + encodeURIComponent(ticketId) + "&select=*&limit=1"
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({ error: "Ticket não encontrado em hubspot_tickets" });
    }
    res.json({ ok: true, ticket: rows[0] });
  } catch (e) {
    console.error("[HUBSPOT] tickets/:id error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/hubspot/tickets — lista paginada/filtrada
// Query params:
//   owner_id, pipeline_type, pipeline_stage_id, tier, status_ticket, seller_id_meli
//   limit (default 50, max 200), offset (default 0)
router.get("/tickets", async (req, res) => {
  try {
    const filters = [];
    const allowedEq = ["owner_id", "pipeline_type", "pipeline_stage_id", "tier", "status_ticket", "seller_id_meli"];
    for (const key of allowedEq) {
      if (req.query[key]) filters.push(encodeURIComponent(key) + "=eq." + encodeURIComponent(String(req.query[key])));
    }
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;

    const qs = filters.join("&") + (filters.length ? "&" : "")
      + "select=ticket_id,ticket_name,pipeline_type,pipeline_name,pipeline_stage_name,"
      + "owner_name,mentor_responsavel_name,tier,status_ticket,nome_do_mentorado,"
      + "whatsapp_do_mentorado,seller_id_meli,seller_nickname_meli,pre_mentoria_ticket_id,"
      + "ticket_created_at,ticket_updated_at"
      + "&order=ticket_updated_at.desc"
      + "&limit=" + limit + "&offset=" + offset;

    const rows = await supaRest("/rest/v1/hubspot_tickets?" + qs);
    res.json({ ok: true, count: rows.length, limit, offset, tickets: rows || [] });
  } catch (e) {
    console.error("[HUBSPOT] tickets list error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// CALLS DE HOJE — populate admin_aba with today's meeting contacts/groups
// ============================================================================
//
// POST /api/hubspot/calls-today/refresh
//   Busca meetings do HubSpot agendadas para HOJE (00:00 - 23:59 BRT),
//   resolve os contatos associados em phones, expande para JIDs (chats
//   individuais + LIDs + grupos), e atualiza admin_abas.resolved_jids
//   da row WHERE name = 'CALLS DE HOJE'.
//
// Returns:
//   {
//     ok: true,
//     meetings_count, contacts_count, phones_count, jids_count,
//     refreshed_at, range: { start, end }
//   }
router.post("/calls-today/refresh", async (req, res) => {
  try {
    // 1. Range do dia em America/Sao_Paulo (UTC-3)
    // Aceita ?date=YYYY-MM-DD (query ou body) pra testar dias específicos.
    // Sem param, usa hoje BRT.
    let dateStr = (req.query && req.query.date) || (req.body && req.body.date);
    if (!dateStr) {
      const now = new Date();
      const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
      dateStr = brt.toISOString().substring(0, 10);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: "date deve ser no formato YYYY-MM-DD" });
    }
    const startUTC = new Date(`${dateStr}T00:00:00-03:00`);
    const endUTC = new Date(`${dateStr}T23:59:59-03:00`);
    const range = { date: dateStr, start: startUTC.toISOString(), end: endUTC.toISOString() };

    // 2. HubSpot API key
    const settingRows = await supaRest(
      "/rest/v1/app_settings?key=eq.hubspot_api_key&select=value"
    ).catch(() => []);
    const hsKey = settingRows && settingRows[0] && settingRows[0].value;
    if (!hsKey) {
      return res.status(400).json({ error: "hubspot_api_key não configurada em app_settings" });
    }

    // 3. Busca meetings do dia
    console.log(`[CALLS-TODAY] Buscando meetings entre ${range.start} e ${range.end}...`);
    const meetings = await searchMeetingsByDateRange(range.start, range.end, hsKey);
    console.log(`[CALLS-TODAY] ${meetings.length} meetings encontradas`);

    // 4. Para cada meeting, paralelizado em chunks de 8 (rate limit HubSpot)
    const contactIdsSet = new Set();
    const CONCURRENCY = 8;
    for (let i = 0; i < meetings.length; i += CONCURRENCY) {
      const chunk = meetings.slice(i, i + CONCURRENCY);
      const lists = await Promise.all(chunk.map(m =>
        getMeetingContactIds(m.id, hsKey).catch(e => {
          console.warn(`[CALLS-TODAY] meeting ${m.id} associations falhou: ${e.message}`);
          return [];
        })
      ));
      for (const ids of lists) for (const id of ids) contactIdsSet.add(id);
    }
    const contactIds = Array.from(contactIdsSet);
    console.log(`[CALLS-TODAY] ${contactIds.length} contatos únicos associados`);

    // 5. Buscar phones desses contatos
    const phonesSet = new Set();
    for (let i = 0; i < contactIds.length; i += CONCURRENCY) {
      const chunk = contactIds.slice(i, i + CONCURRENCY);
      const phones = await Promise.all(chunk.map(id =>
        getContactPhoneDigits(id, hsKey).catch(() => null)
      ));
      for (const p of phones) if (p) phonesSet.add(p);
    }
    const phones = Array.from(phonesSet);
    console.log(`[CALLS-TODAY] ${phones.length} phones únicos resolvidos`);

    // 6. Expandir phones em JIDs (contatos individuais + LIDs + grupos)
    const allJids = await expandPhonesToJids(phones);
    console.log(`[CALLS-TODAY] ${allJids.length} JIDs totais (incluindo grupos)`);

    // 7. UPDATE admin_abas SET resolved_jids = ... WHERE name = 'CALLS DE HOJE'
    const updateBody = {
      resolved_jids: allJids.length > 0 ? allJids : null,
    };
    await supaRest(
      "/rest/v1/admin_abas?name=eq." + encodeURIComponent("CALLS DE HOJE"),
      "PATCH",
      updateBody,
      "return=minimal"
    );

    const refreshed_at = new Date().toISOString();
    const result = {
      ok: true,
      meetings_count: meetings.length,
      contacts_count: contactIds.length,
      phones_count: phones.length,
      jids_count: allJids.length,
      refreshed_at,
      range,
    };
    console.log("[CALLS-TODAY]", JSON.stringify(result));
    res.json(result);
  } catch (e) {
    console.error("[CALLS-TODAY] error:", e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
