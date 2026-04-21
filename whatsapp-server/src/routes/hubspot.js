// ===== HubSpot ticket resolution routes =====
// Endpoints for the grupos.html "Tickets HubSpot" tab: resolve ticket IDs
// against the local `mentorados` table (populated by the hubspot-tickets
// Edge Function webhook), falling back to the HubSpot REST API for any
// tickets not yet in the table. Fresh API lookups are written back to
// `mentorados` so the next resolve hits the cache.

const express = require("express");
const router = express.Router();
const {
  supaRest, expandPhonesToJids, pickPrimaryJid, fetchChatNamesBatch, classifyJid,
} = require("../services/supabase");
const {
  fetchTicketFromApi, upsertMentorado, upsertHubspotTicket,
  searchMeetingsByDateRange, getMeetingContactIds, getContactPhoneDigits,
} = require("../services/hubspot-api");
// Carregado lazy no handler /resolve-tickets pra evitar ciclo de require
// (baileys.js também depende de services/supabase e rotas). Ver: baileys.getSession.
let baileysRef = null;
function _getBaileys() {
  if (!baileysRef) baileysRef = require("../services/baileys");
  return baileysRef;
}

const { logEvent } = require("../services/activity-log");

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
//         ticket_owner, ticket_owner_email,
//         pipeline_stage_name, status_ticket,
//         warning: null | "mentor_sem_sessao_conectada" | "sem_tier_definido"
//       },
//       ...
//     ],
//     notFound: number[]
//   }
// Cache in-memory de validações onWhatsApp — por fone. Evita IQ repetido pro
// mesmo número em chamadas consecutivas (user clica Resolver 2x). Chave = raw
// phone (digits only). Valor = { jid, exists, adjusted, validatedAt }. Sem TTL
// (limpa no pm2 restart).
const _phoneValidationCache = new Map();

// Escolhe uma sessão "doadora" pra validar phones via onWhatsApp. Prioridade:
// CX2 > Escalada > primeira conectada. Retorna o sock ou null se nenhuma.
// A sessão criadora do lote (se passada) é explicitamente excluída pra não
// adicionar IQ extra nela.
function pickValidatorSession(baileys, excludeSessionId) {
  const CX2_PHONE = "5519971505209";
  const ESCALADA_PHONE = "5519993473149";
  const active = baileys.getActiveSessions();
  if (!Array.isArray(active) || active.length === 0) return null;
  const rank = (phone) => {
    const p = String(phone || "").replace(/\D/g, "");
    if (p === CX2_PHONE) return 0;       // CX2 primeiro
    if (p === ESCALADA_PHONE) return 1;  // Escalada depois
    return 2;                            // qualquer outra
  };
  const sorted = active.slice().sort((a, b) => rank(a.phone) - rank(b.phone));
  for (const entry of sorted) {
    if (entry.sessionId === excludeSessionId) continue;
    const s = baileys.getSession(entry.sessionId);
    if (s && s.status === "connected" && s.sock) {
      return { sessionId: entry.sessionId, sock: s.sock, phone: entry.phone };
    }
  }
  return null;
}

// Batch-valida uma lista de phones via sock.onWhatsApp (1 IQ pra N phones).
// Pra cada phone não-existente, tenta a variante do "9" BR (com/sem o 9).
// Popula _phoneValidationCache. Retorna Map<rawPhone, {jid, exists, adjusted}>.
async function validateClientPhones(sock, phones) {
  const out = new Map();
  const toQuery = [];
  // Descarta phones já no cache (não re-pergunta)
  for (const p of phones) {
    const raw = String(p || "").replace(/\D/g, "");
    if (!raw) continue;
    if (_phoneValidationCache.has(raw)) {
      out.set(raw, _phoneValidationCache.get(raw));
    } else if (!out.has(raw)) {
      toQuery.push(raw);
    }
  }
  if (toQuery.length === 0) return out;

  let firstBatch = [];
  try {
    firstBatch = await sock.onWhatsApp(...toQuery);
  } catch (e) {
    console.warn("[HUBSPOT] validateClientPhones batch error:", e.message);
    firstBatch = [];
  }
  // Map response back. Baileys retorna { jid, exists } — jid pode ser canônico
  // diferente do input (ex: 13 dígitos → 12 sem o 9). Quando exists=true, usa esse jid.
  const resultByPhone = {};
  for (let i = 0; i < toQuery.length; i++) {
    const raw = toQuery[i];
    const r = Array.isArray(firstBatch) ? firstBatch.find(x => x && x.jid && normalizeJidDigits(x.jid) === raw) : null;
    if (r && r.exists && r.jid && !r.jid.endsWith("@lid")) {
      resultByPhone[raw] = { jid: r.jid, exists: true, adjusted: false };
    } else {
      resultByPhone[raw] = { jid: null, exists: false, adjusted: false };
    }
  }

  // Segunda tentativa: pros que ficaram exists=false, tenta a variante do 9 BR
  const retryMap = {}; // rawOriginal → variant
  const retryVariants = [];
  for (const raw of toQuery) {
    if (resultByPhone[raw].exists) continue;
    let variant = null;
    if (raw.length === 13 && raw.startsWith("55")) {
      variant = raw.slice(0, 4) + raw.slice(5);       // remove o "9"
    } else if (raw.length === 12 && raw.startsWith("55")) {
      variant = raw.slice(0, 4) + "9" + raw.slice(4); // adiciona o "9"
    }
    if (variant) {
      retryMap[raw] = variant;
      retryVariants.push(variant);
    }
  }
  if (retryVariants.length > 0) {
    let secondBatch = [];
    try {
      secondBatch = await sock.onWhatsApp(...retryVariants);
    } catch (e) {
      console.warn("[HUBSPOT] validateClientPhones retry error:", e.message);
    }
    for (const raw of Object.keys(retryMap)) {
      const variant = retryMap[raw];
      const r = Array.isArray(secondBatch) ? secondBatch.find(x => x && x.jid && normalizeJidDigits(x.jid) === variant) : null;
      if (r && r.exists && r.jid && !r.jid.endsWith("@lid")) {
        resultByPhone[raw] = { jid: r.jid, exists: true, adjusted: true };
      }
    }
  }

  // Grava no cache + preenche out
  for (const raw of toQuery) {
    const entry = Object.assign({ validatedAt: Date.now() }, resultByPhone[raw]);
    _phoneValidationCache.set(raw, entry);
    out.set(raw, entry);
  }
  return out;
}

// Helper: extrai só os dígitos do user-part de um JID (5519...@s.whatsapp.net → "5519...")
function normalizeJidDigits(jid) {
  if (!jid) return "";
  const userPart = String(jid).split("@")[0] || "";
  return userPart.split(":")[0].replace(/\D/g, "");
}

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

    // 1. Batch fetch from hubspot_tickets — the canonical mirror populated
    // by the HubSpot webhook Edge Function. Includes owner_*, tier (already
    // as string), pipeline_*, and status_ticket. Replaces the legacy
    // `mentorados` lookup which was 1 step downstream in the trigger chain.
    const ticketRows = await supaRest(
      "/rest/v1/hubspot_tickets?ticket_id=in.(" + ids.join(",") +
      ")&select=ticket_id,ticket_name,mentor_responsavel_name,whatsapp_do_mentorado,tier,owner_id,owner_name,owner_email,pipeline_stage_name,pipeline_type,status_ticket"
    ).catch((e) => {
      console.error("[HUBSPOT] hubspot_tickets fetch error:", e.message);
      return [];
    });

    const byId = {};
    for (const r of (ticketRows || [])) {
      if (r && r.ticket_id != null) byId[Number(r.ticket_id)] = r;
    }

    // 2. Fallback: tickets missing from hubspot_tickets get fetched from the
    // HubSpot REST API using the hubspot_api_key stored in app_settings.
    // Results are upserted back into hubspot_tickets AND mentorados (for
    // legacy consumers) so the next resolve hits the cache.
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
              // Normalize the fallback row to match the hubspot_tickets shape
              // used downstream (so the resolved loop doesn't need two paths).
              byId[id] = {
                ticket_id: row.ticket_id,
                ticket_name: row.ticket_name,
                mentor_responsavel_name: row.mentor_responsavel_name || row.mentor_responsavel,
                whatsapp_do_mentorado: row.whatsapp_do_mentorado,
                tier: row.tier || null,
                owner_id: row.owner_id || null,
                owner_name: row.owner_name || null,
                owner_email: row.owner_email || null,
                pipeline_stage_name: null,
                pipeline_type: null,
                status_ticket: null,
                _source: "hubspot_api",
              };
              // Fire-and-forget upserts — don't block the resolve.
              upsertHubspotTicket(row, supaRest).catch(() => {});
              upsertMentorado(row, supaRest).catch(() => {});
            }
          }
        }
      }
    }

    // 3. Build a label -> { id, phone } map from connected wa_sessions.
    // mentor_responsavel_name matches wa_sessions.label literally (confirmed
    // in production: "Rodrigo Zangirolimo", "Eduardo Gossi", etc).
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

      const tier = r.tier || null;
      const mentorName = r.mentor_responsavel_name || r.mentor_responsavel || null;

      const mentorKey = String(mentorName || "").trim().toLowerCase();
      const mentorSession = mentorKey ? labelToSession[mentorKey] : null;

      let warning = null;
      if (!mentorSession) warning = "mentor_sem_sessao_conectada";
      else if (!tier) warning = "sem_tier_definido";

      resolved.push({
        ticket_id: r.ticket_id,
        ticket_name: r.ticket_name,
        mentor: mentorName,
        whatsapp: r.whatsapp_do_mentorado,
        tier,
        mentorSessionId: mentorSession ? mentorSession.id : null,
        mentorSessionPhone: mentorSession ? mentorSession.phone : null,
        ticket_owner: r.owner_name || null,
        ticket_owner_email: r.owner_email || null,
        pipeline_stage_name: r.pipeline_stage_name || null,
        pipeline_type: r.pipeline_type || null,
        status_ticket: r.status_ticket || null,
        warning,
        // Campos preenchidos pela validação abaixo (onWhatsApp batch).
        resolvedClientJid: null,
        clientValidation: "pending",
        source: r._source || "hubspot_tickets",
      });
    }

    // 4.5. Enriquece cada resolved com flag `vcardAlreadySent` — se mentor
    // já recebeu vCard desse cliente no self-chat dele, marca. Frontend mostra
    // badge 💾 no preview pra UI saber que não precisa re-enviar.
    try {
      const mentorIds = Array.from(new Set(resolved.map(r => r.mentorSessionId).filter(Boolean)));
      const allPhones = Array.from(new Set(resolved.map(r => String(r.whatsapp || "").replace(/\D/g, "")).filter(p => p.length >= 10)));
      if (mentorIds.length > 0 && allPhones.length > 0) {
        const vRows = await supaRest(
          "/rest/v1/vcard_sent_registry" +
          "?mentor_session_id=in.(" + mentorIds.join(",") + ")" +
          "&client_phone=in.(" + allPhones.map(p => '"' + p + '"').join(",") + ")" +
          "&select=mentor_session_id,client_phone,sent_at"
        ).catch(() => []);
        const sentMap = new Map();
        for (const v of (Array.isArray(vRows) ? vRows : [])) {
          sentMap.set(v.mentor_session_id + "|" + v.client_phone, v.sent_at);
        }
        for (const r of resolved) {
          if (!r.mentorSessionId || !r.whatsapp) continue;
          const p = String(r.whatsapp).replace(/\D/g, "");
          const key = r.mentorSessionId + "|" + p;
          if (sentMap.has(key)) {
            r.vcardAlreadySent = true;
            r.vcardSentAt = sentMap.get(key);
          } else {
            r.vcardAlreadySent = false;
          }
        }
      }
    } catch (vErr) {
      console.warn("[HUBSPOT] vcard registry lookup failed:", vErr.message);
    }

    // 5. Validação onWhatsApp em batch (1 IQ total + opcional 1 IQ retry com
    // variante do "9" BR). Sessão doadora: CX2 > Escalada > outra conectada.
    // Cliente não encontrado em nenhuma variante → clientValidation="not_on_whatsapp",
    // o frontend força includeClient=false automaticamente só pra esse row.
    const phonesToValidate = [];
    for (const r of resolved) {
      const raw = String(r.whatsapp || "").replace(/\D/g, "");
      if (raw && !phonesToValidate.includes(raw)) phonesToValidate.push(raw);
    }
    let validatorSessionUsed = null;
    let validationMap = new Map();
    if (phonesToValidate.length > 0) {
      const baileys = _getBaileys();
      const validator = pickValidatorSession(baileys, null);
      if (validator) {
        validatorSessionUsed = validator.phone;
        try {
          validationMap = await validateClientPhones(validator.sock, phonesToValidate);
        } catch (e) {
          console.warn("[HUBSPOT] client phone validation failed:", e.message);
        }
      }
    }
    for (const r of resolved) {
      const raw = String(r.whatsapp || "").replace(/\D/g, "");
      if (!raw) { r.clientValidation = "no_phone"; continue; }
      const v = validationMap.get(raw);
      if (!v) {
        // Sem validador disponível ou erro na query — mantém comportamento legado
        r.clientValidation = validatorSessionUsed ? "not_validated" : "no_validator";
        continue;
      }
      if (v.exists && v.jid) {
        r.resolvedClientJid = v.jid;
        r.clientValidation = v.adjusted ? "adjusted_no_9" : "ok";
      } else {
        r.resolvedClientJid = null;
        r.clientValidation = "not_on_whatsapp";
      }
    }

    // Activity log: registra o resolve + breakdown da validação.
    const vOk = resolved.filter(r => r.clientValidation === "ok").length;
    const vAdjusted = resolved.filter(r => r.clientValidation === "adjusted_no_9").length;
    const vInvalid = resolved.filter(r => r.clientValidation === "not_on_whatsapp").length;
    const vNoVal = resolved.filter(r => r.clientValidation === "no_validator").length;
    logEvent({
      type: "resolve_tickets",
      level: vInvalid > 0 ? "warn" : "info",
      message: "Resolve-tickets: " + ids.length + " ticket(s), " + resolved.length + " resolvido(s), " + notFound.length + " não encontrado(s)",
      metadata: {
        ticketCount: ids.length,
        resolvedCount: resolved.length,
        notFoundCount: notFound.length,
        validationOk: vOk, validationAdjusted: vAdjusted,
        validationInvalid: vInvalid, validationNoValidator: vNoVal,
        validatorPhone: validatorSessionUsed || null,
      },
    });
    // Log individual pra cada cliente ajustado ou inválido (útil pra auditar HubSpot)
    for (const r of resolved) {
      if (r.clientValidation === "adjusted_no_9") {
        logEvent({
          type: "phone_validation:adjusted_9_br",
          level: "info",
          message: "Número BR ajustado automaticamente (cliente " + (r.ticket_name || r.ticket_id) + ")",
          metadata: { ticketId: r.ticket_id, originalPhone: r.whatsapp, canonicalJid: r.resolvedClientJid, validatorPhone: validatorSessionUsed },
        });
      } else if (r.clientValidation === "not_on_whatsapp") {
        logEvent({
          type: "phone_validation:not_on_whatsapp",
          level: "warn",
          message: "Número NÃO existe no WhatsApp — cliente " + (r.ticket_name || r.ticket_id) + " (" + (r.whatsapp || "?") + ")",
          metadata: { ticketId: r.ticket_id, originalPhone: r.whatsapp, validatorPhone: validatorSessionUsed },
        });
      }
    }

    const response = { ok: true, resolved, notFound, validatorSession: validatorSessionUsed };
    if (hsAuthError) response.hubspotAuthError = hsAuthError;
    if (missing.length > 0 && !hsKey) response.hubspotKeyMissing = true;
    res.json(response);
  } catch (e) {
    console.error("[HUBSPOT] resolve-tickets error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== Pending groups (Auto-create modal) =====
// GET /api/hubspot/pending-groups[?tier=&pipeline_type=&owner_id=]
// Returns tickets in hubspot_tickets that still need a WhatsApp group created,
// grouped by the ticket owner (mentor). A ticket is "pending" if:
//   - tier is filled (otherwise we can't pick a group photo), AND
//   - no row in wa_group_creations with status='created' references its ticket_id.
// Tickets whose previous attempt failed/rate-limited/cancelled are included
// (the user may want to retry).
router.get("/pending-groups", async (req, res) => {
  try {
    const { tier, pipeline_type, owner_id } = req.query || {};
    // 1. Fetch tickets with tier set (required — photo depends on tier)
    const ticketFilters = [
      "select=ticket_id,ticket_name,mentor_responsavel_name,whatsapp_do_mentorado,tier,owner_id,owner_name,pipeline_stage_name,pipeline_type,status_ticket,ticket_created_at",
      "tier=not.is.null",
      "order=ticket_created_at.desc",
      "limit=500",
    ];
    if (tier) ticketFilters.push("tier=eq." + encodeURIComponent(tier));
    if (pipeline_type) ticketFilters.push("pipeline_type=eq." + encodeURIComponent(pipeline_type));
    if (owner_id) ticketFilters.push("owner_id=eq." + encodeURIComponent(owner_id));
    const tickets = await supaRest(
      "/rest/v1/hubspot_tickets?" + ticketFilters.join("&")
    ).catch((e) => {
      console.error("[HUBSPOT] pending-groups tickets fetch error:", e.message);
      return [];
    });

    // 2. Identify ticket_ids that already have a created group
    const ticketIds = tickets.map((t) => t.ticket_id).filter((id) => id != null);
    let createdTicketIds = new Set();
    if (ticketIds.length > 0) {
      const createdRows = await supaRest(
        "/rest/v1/wa_group_creations?hubspot_ticket_id=in.(" + ticketIds.join(",") +
        ")&status=eq.created&select=hubspot_ticket_id"
      ).catch((e) => {
        console.error("[HUBSPOT] pending-groups created fetch error:", e.message);
        return [];
      });
      createdTicketIds = new Set((createdRows || []).map((r) => Number(r.hubspot_ticket_id)));
    }

    // 3. Filter pending (= not yet successfully created)
    const pending = tickets.filter((t) => !createdTicketIds.has(Number(t.ticket_id)));

    // 4. Map owner_name → connected wa_session
    const sessions = await supaRest(
      "/rest/v1/wa_sessions?status=eq.connected&select=id,label,phone"
    ).catch(() => []);
    const labelToSession = {};
    for (const s of (sessions || [])) {
      if (s && s.label) {
        labelToSession[String(s.label).trim().toLowerCase()] = { id: s.id, phone: s.phone };
      }
    }

    // 5. Group by owner_name (falling back to mentor_responsavel_name when owner is blank)
    const byOwner = {};
    for (const t of pending) {
      const owner = (t.owner_name || t.mentor_responsavel_name || "(sem dono)").trim();
      if (!byOwner[owner]) {
        const key = owner.toLowerCase();
        const session = labelToSession[key] || null;
        byOwner[owner] = {
          owner_name: owner,
          owner_id: t.owner_id || null,
          session_id: session ? session.id : null,
          session_phone: session ? session.phone : null,
          session_label: session ? owner : null,
          session_warning: session ? null : "sem_sessao_conectada",
          tickets: [],
        };
      }
      byOwner[owner].tickets.push(t);
    }

    const groups = Object.values(byOwner).sort((a, b) => b.tickets.length - a.tickets.length);
    res.json({
      ok: true,
      groups,
      counters: { total_tickets: tickets.length, pending: pending.length, owners: groups.length },
    });
  } catch (e) {
    console.error("[HUBSPOT] pending-groups error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== Retry / Delete individual group creation row =====
// Used by the Dashboard "↻ Retry" / "🗑️ Deletar" buttons. Retry reconstructs
// the spec from the persisted row (group_name, client_phone, tier, mentor_session)
// and fires-and-forgets createGroupsFromList with just that spec — keeping the
// same spec_hash so the upsert overwrites the failed row instead of creating
// a duplicate. Delete just removes the row from wa_group_creations (does NOT
// touch the group on WhatsApp — useful when a duplicate group exists and the
// user wants the ticket to appear as "pending" again in Auto-criar).
const baileys = require("../services/baileys");

router.post("/group-creation/:id/retry", async (req, res) => {
  try {
    const rowId = req.params.id;
    const rows = await supaRest(
      "/rest/v1/wa_group_creations?id=eq." + encodeURIComponent(rowId) +
      "&select=id,source_session_id,spec_hash,group_name,status,hubspot_ticket_id,hubspot_ticket_name,hubspot_mentor,hubspot_tier,client_phone,mentor_session_id,mentor_session_phone"
    );
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "Registro não encontrado" });
    }
    const row = rows[0];
    if (row.status === "created") {
      return res.status(400).json({ error: "Grupo já foi criado. Se quer recriar, delete o registro primeiro." });
    }
    if (!row.source_session_id) return res.status(400).json({ error: "Registro sem source_session_id" });
    if (!row.client_phone) return res.status(400).json({ error: "Registro sem client_phone — não dá pra reconstruir o spec" });
    if (!row.spec_hash) return res.status(400).json({ error: "Registro sem spec_hash" });

    const rl = baileys.getRateLimitStatus(row.source_session_id);
    if (rl) {
      return res.status(429).json({ error: "Sessão em cooldown (~" + Math.ceil(rl.remainingMs / 60000) + "min)" });
    }

    // Photo pela tier
    const tierMap = { pro: "Pro", business: "business", starter: "starter" };
    const tierPhoto = tierMap[row.hubspot_tier] || null;
    const photoUrl = tierPhoto ? ("/static/fotos/" + tierPhoto + ".png") : null;

    // Reconstruct members: só cliente + mentor (helpers do lote original não
    // ficam persistidos; se o user quiser helpers, tem que usar o fluxo normal).
    const members = [String(row.client_phone).replace(/\D/g, "")];
    if (row.mentor_session_phone) {
      const mp = String(row.mentor_session_phone).replace(/\D/g, "");
      if (mp && mp !== members[0]) members.push(mp);
    }

    // Templates default (user pode ter customizado no fluxo original — não
    // preservamos. Usa default do servidor).
    const WELCOME_DEFAULT = "Opa, tudo bem? seja muito bem-vindo a nossa Mentoria Escalada. Em breve o mentor de vocês fará uma apresentação e iniciaremos a nossa jornada juntos! #aMETAéoTOPO";
    const REJECT_DEFAULT = 'Olá {primeiro_nome}! Seu grupo de mentoria "{nome_grupo}" foi criado, mas suas configurações de privacidade não permitem que a gente te adicione diretamente. Entra por este link: {link}';

    // Interpola {primeiro_nome} e {mentor} — usa o primeiro token do client name
    // (extraído do group_name antes do `|`) e o mentor da row.
    const clientName = String(row.group_name || "").split("|")[0].trim();
    const firstName = clientName.split(/\s+/)[0] || "";
    const mentorName = row.hubspot_mentor || "";
    const welcome = WELCOME_DEFAULT
      .replace(/\{primeiro_nome\}/g, firstName)
      .replace(/\{mentor\}/g, mentorName);
    const rejectDm = REJECT_DEFAULT
      .replace(/\{primeiro_nome\}/g, firstName)
      .replace(/\{mentor\}/g, mentorName);

    const spec = {
      name: row.group_name || "",
      description: "[" + (row.hubspot_ticket_id || "") + "]",
      photoUrl,
      members,
      lockInfo: true,
      welcomeMessage: welcome,
      rejectDmTemplate: rejectDm,
      adminJids: ["5519993473149@s.whatsapp.net"],
      clientPhone: String(row.client_phone).replace(/\D/g, ""),
      specHash: row.spec_hash, // mantém o hash pra upsert ATUALIZAR a row existente
      hubspotTicketId: row.hubspot_ticket_id,
      hubspotTicketName: row.hubspot_ticket_name || null,
      hubspotMentor: row.hubspot_mentor || null,
      hubspotTier: row.hubspot_tier || null,
      mentorSessionId: row.mentor_session_id,
      mentorSessionPhone: row.mentor_session_phone,
    };

    // Fire-and-forget: respondemos 202 e o createGroupsFromList roda em background.
    // O upsert em wa_group_creations atualiza a mesma row (on_conflict=source_session_id,spec_hash).
    (async () => {
      try {
        await baileys.createGroupsFromList(row.source_session_id, [spec], {
          delaySec: 180,
          _leadingDelayMs: 30000, // 30s leading (apenas 1 grupo)
          shouldCancel: () => false,
        });
      } catch (e) {
        console.error("[HUBSPOT] retry history row error:", e && e.message);
      }
    })();

    res.status(202).json({ ok: true, message: "Retry iniciado — aguarde 1-2 min e atualize o histórico" });
  } catch (e) {
    console.error("[HUBSPOT] retry endpoint error:", e && e.message);
    res.status(500).json({ error: e.message || String(e) });
  }
});

router.delete("/group-creation/:id", async (req, res) => {
  try {
    const rowId = req.params.id;
    await supaRest(
      "/rest/v1/wa_group_creations?id=eq." + encodeURIComponent(rowId),
      "DELETE",
      null,
      "return=minimal"
    );
    res.json({ ok: true, deleted_id: rowId });
  } catch (e) {
    console.error("[HUBSPOT] delete history row error:", e && e.message);
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ===== Group creation history (cross-session, Dashboard) =====
// GET /api/hubspot/group-history[?from=&to=&mentor=&tier=&status=&session_id=&limit=&offset=]
// Returns wa_group_creations rows across all sessions with HubSpot-enriched
// fields (via trigger trg_sync_mentorados_to_group_creations) + owner_name
// joined on-the-fly from hubspot_tickets. Used by the Dashboard view.
router.get("/group-history", async (req, res) => {
  try {
    const { from, to, mentor, tier, status, session_id } = req.query || {};
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const filters = [
      "select=id,source_session_id,spec_hash,group_name,group_jid,status,status_message,members_total,members_added,has_description,has_photo,locked,welcome_sent,invite_link,created_at,hubspot_ticket_id,hubspot_ticket_name,hubspot_mentor,hubspot_tier,hubspot_pipeline_stage_name,hubspot_last_synced_at,client_phone,mentor_session_phone",
      "order=created_at.desc",
      "limit=" + limit,
      "offset=" + offset,
    ];
    if (from) filters.push("created_at=gte." + encodeURIComponent(from));
    if (to) filters.push("created_at=lte." + encodeURIComponent(to));
    if (mentor) filters.push("hubspot_mentor=ilike.*" + encodeURIComponent(mentor) + "*");
    if (tier) filters.push("hubspot_tier=eq." + encodeURIComponent(tier));
    if (status) filters.push("status=eq." + encodeURIComponent(status));
    if (session_id) filters.push("source_session_id=eq." + encodeURIComponent(session_id));

    const rows = await supaRest(
      "/rest/v1/wa_group_creations?" + filters.join("&")
    ).catch((e) => {
      console.error("[HUBSPOT] group-history fetch error:", e.message);
      return [];
    });

    // JOIN on-the-fly com hubspot_tickets pra trazer owner_name (dono do ticket)
    const ticketIds = [...new Set((rows || []).map(r => r.hubspot_ticket_id).filter(Boolean))];
    const ownerByTicketId = {};
    if (ticketIds.length > 0) {
      const owners = await supaRest(
        "/rest/v1/hubspot_tickets?ticket_id=in.(" + ticketIds.join(",") +
        ")&select=ticket_id,owner_name,pipeline_stage_name,status_ticket"
      ).catch(() => []);
      (owners || []).forEach((o) => {
        if (o && o.ticket_id != null) ownerByTicketId[Number(o.ticket_id)] = o;
      });
    }

    // JOIN com wa_sessions pra trazer label da sessão criadora
    const sessionIds = [...new Set((rows || []).map(r => r.source_session_id).filter(Boolean))];
    const sessionLabelById = {};
    if (sessionIds.length > 0) {
      const sessions = await supaRest(
        "/rest/v1/wa_sessions?id=in.(" + sessionIds.map(encodeURIComponent).join(",") +
        ")&select=id,label,phone"
      ).catch(() => []);
      (sessions || []).forEach((s) => {
        if (s && s.id) sessionLabelById[s.id] = { label: s.label, phone: s.phone };
      });
    }

    const enriched = (rows || []).map((r) => {
      const ownerInfo = ownerByTicketId[Number(r.hubspot_ticket_id)] || null;
      const sessionInfo = sessionLabelById[r.source_session_id] || null;
      return {
        ...r,
        ticket_owner_name: ownerInfo ? ownerInfo.owner_name : null,
        current_pipeline_stage: ownerInfo ? ownerInfo.pipeline_stage_name : r.hubspot_pipeline_stage_name,
        current_status_ticket: ownerInfo ? ownerInfo.status_ticket : null,
        session_label: sessionInfo ? sessionInfo.label : null,
        session_phone: sessionInfo ? sessionInfo.phone : null,
      };
    });

    res.json({ ok: true, rows: enriched, count: enriched.length, limit, offset });
  } catch (e) {
    console.error("[HUBSPOT] group-history cross-session error:", e.message);
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
// Normaliza o payload salvo em app_settings pro novo formato multi-template.
// Aceita:
//  - Novo: {templates: [{id, name, isDefault, description, welcome, rejectDm, helperDm}]}
//  - Legado (pré-22/04): {description, welcome, rejectDm, helperDm} → envolve como
//    1 template nomeado "Padrão" default.
// Retorna sempre o shape novo (ou null se entrada vazia).
function normalizeTemplatesPayload(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (Array.isArray(parsed.templates)) {
    const list = parsed.templates
      .filter(t => t && typeof t === "object" && t.name)
      .map(t => ({
        id: String(t.id || ("tmpl_" + Math.random().toString(36).slice(2, 10))),
        name: String(t.name).trim().slice(0, 80),
        isDefault: !!t.isDefault,
        description: String(t.description || ""),
        welcome: String(t.welcome || ""),
        rejectDm: String(t.rejectDm || ""),
        helperDm: String(t.helperDm || ""),
      }));
    // Garante exatamente 1 default. Se nenhum → primeiro vira default.
    // Se múltiplos → só o primeiro fica default.
    let defaultSet = false;
    for (const t of list) {
      if (t.isDefault && !defaultSet) { defaultSet = true; }
      else { t.isDefault = false; }
    }
    if (!defaultSet && list.length > 0) list[0].isDefault = true;
    return { templates: list };
  }
  // Shape legado — envolve como 1 template default
  if (parsed.description != null || parsed.welcome != null || parsed.rejectDm != null || parsed.helperDm != null) {
    return {
      templates: [{
        id: "tmpl_legacy",
        name: "Padrão",
        isDefault: true,
        description: String(parsed.description || ""),
        welcome: String(parsed.welcome || ""),
        rejectDm: String(parsed.rejectDm || ""),
        helperDm: String(parsed.helperDm || ""),
      }],
    };
  }
  return null;
}

// POST /api/hubspot/templates/:sessionId
// Body pode vir em 2 shapes:
//  1. Novo (preferido): { templates: [{id, name, isDefault, description, welcome, rejectDm, helperDm}] }
//     Substitui a lista completa. Frontend controla add/remove/default.
//  2. Legado: { description, welcome, rejectDm, helperDm } — migra automaticamente.
router.post("/templates/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const normalized = normalizeTemplatesPayload(req.body);
    if (!normalized || normalized.templates.length === 0) {
      return res.status(400).json({ error: "payload inválido ou vazio" });
    }
    const key = "hubspot_templates_" + sessionId;
    const value = JSON.stringify(normalized);
    await supaRest(
      "/rest/v1/app_settings?on_conflict=key",
      "POST",
      [{ key, value }],
      "resolution=merge-duplicates,return=minimal"
    );
    res.json({ ok: true, templates: normalized.templates });
  } catch (e) {
    console.error("[HUBSPOT] save templates error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/hubspot/templates/:sessionId
// Retorna SEMPRE no formato novo: { ok, templates: [{id, name, isDefault, ...}] }.
// Se o registro tá em formato legado, migra transparentemente.
router.get("/templates/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const key = "hubspot_templates_" + sessionId;
    const rows = await supaRest(
      "/rest/v1/app_settings?key=eq." + encodeURIComponent(key) + "&select=value"
    ).catch(() => []);
    if (rows && rows[0] && rows[0].value) {
      try {
        const parsed = JSON.parse(rows[0].value);
        const normalized = normalizeTemplatesPayload(parsed);
        if (normalized) return res.json({ ok: true, templates: normalized.templates });
      } catch (_) {}
    }
    res.json({ ok: true, templates: [] });
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

    // 6. Expandir phones em JIDs com mapa por phone (pra dedup por pessoa)
    const expanded = await expandPhonesToJids(phones, { groupByPhone: true });
    const allJids = expanded.jids;
    const phoneMap = expanded.phoneMap;
    console.log(`[CALLS-TODAY] ${allJids.length} JIDs totais (incluindo grupos)`);

    // 7. UPDATE admin_abas — popula resolved_jids (achatado) + resolved_phones
    //    + resolved_phone_jids (mapa pra dedup por pessoa no contador da extensão)
    const updateBody = {
      resolved_jids: allJids.length > 0 ? allJids : null,
      resolved_phones: phones.length > 0 ? phones : null,
      resolved_phone_jids: phones.length > 0 ? phoneMap : null,
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

// ============================================================================
// CALLS DA SEMANA — popula calls_events com meetings dos próximos N dias
// ============================================================================
//
// POST /api/hubspot/calls-week/refresh?days=N
//   Busca meetings do HubSpot entre hoje 00:00 BRT e hoje+N-1 23:59 BRT
//   (default N=7), resolve contatos → phones → primary_jid, UPSERT em
//   calls_events e remove stale (meetings canceladas/movidas pra fora do range).
//
//   Query params (opcionais):
//     ?days=7 (default)  — quantos dias a partir de hoje
//     ?date=YYYY-MM-DD   — data base alternativa (default: hoje BRT)
//
//   Response:
//   {
//     ok: true,
//     meetings_count, events_count, deleted_count,
//     refreshed_at, range: { start, end, days }
//   }
router.post("/calls-week/refresh", async (req, res) => {
  try {
    // 1. Range
    const daysRaw = Number((req.query && req.query.days) || (req.body && req.body.days) || 7);
    const days = Math.max(1, Math.min(31, Math.floor(daysRaw) || 7));
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
    const endDateObj = new Date(startUTC.getTime() + days * 24 * 60 * 60 * 1000 - 1000);
    const endUTC = endDateObj;
    const range = { start: startUTC.toISOString(), end: endUTC.toISOString(), days };

    // 2. HubSpot API key
    const settingRows = await supaRest(
      "/rest/v1/app_settings?key=eq.hubspot_api_key&select=value"
    ).catch(() => []);
    const hsKey = settingRows && settingRows[0] && settingRows[0].value;
    if (!hsKey) {
      return res.status(400).json({ error: "hubspot_api_key não configurada em app_settings" });
    }

    // 3. Busca meetings do range
    console.log(`[CALLS-WEEK] Buscando meetings entre ${range.start} e ${range.end} (${days}d)...`);
    const meetings = await searchMeetingsByDateRange(range.start, range.end, hsKey);
    console.log(`[CALLS-WEEK] ${meetings.length} meetings encontradas`);

    // 4. Pra cada meeting: resolve contactIds -> phones. Monta (meeting, phone) pairs
    //    preservando metadado (start/end/title/owner).
    const CONCURRENCY = 8;
    const pairs = []; // { meeting_id, start_time, end_time, title, owner_id, phone, contact_id }

    for (let i = 0; i < meetings.length; i += CONCURRENCY) {
      const chunk = meetings.slice(i, i + CONCURRENCY);
      const lists = await Promise.all(chunk.map(m =>
        getMeetingContactIds(m.id, hsKey).catch(e => {
          console.warn(`[CALLS-WEEK] meeting ${m.id} associations falhou: ${e.message}`);
          return [];
        })
      ));
      chunk.forEach((m, idx) => {
        const props = m.properties || {};
        const contactIds = lists[idx] || [];
        for (const cid of contactIds) {
          pairs.push({
            meeting_id: String(m.id),
            start_time: props.hs_meeting_start_time || null,
            end_time: props.hs_meeting_end_time || null,
            title: props.hs_meeting_title || null,
            owner_id: props.hubspot_owner_id || null,
            contact_id: cid,
          });
        }
      });
    }
    console.log(`[CALLS-WEEK] ${pairs.length} (meeting, contact) pares`);

    // 5. Resolve phone de cada contact_id. Cacheia pra evitar lookup duplicado.
    const phoneByContact = {};
    const uniqueContactIds = Array.from(new Set(pairs.map(p => p.contact_id)));
    for (let i = 0; i < uniqueContactIds.length; i += CONCURRENCY) {
      const chunk = uniqueContactIds.slice(i, i + CONCURRENCY);
      const phones = await Promise.all(chunk.map(id =>
        getContactPhoneDigits(id, hsKey).catch(() => null)
      ));
      chunk.forEach((id, idx) => { if (phones[idx]) phoneByContact[id] = phones[idx]; });
    }
    // Atribui phone a cada pair (descarta pares sem phone)
    const validPairs = [];
    for (const p of pairs) {
      const phone = phoneByContact[p.contact_id];
      if (phone) validPairs.push({ ...p, phone });
    }
    console.log(`[CALLS-WEEK] ${validPairs.length} pares com phone válido`);

    // 6. Expande phones únicos -> JIDs (reusa lógica com variações 9-extra)
    const uniquePhones = Array.from(new Set(validPairs.map(p => p.phone)));
    const expanded = await expandPhonesToJids(uniquePhones, { groupByPhone: true });
    const phoneMap = expanded.phoneMap || {};

    // 7. Pra cada pair, escolhe primary_jid e classifica
    const eventsToUpsert = validPairs.map(p => {
      const jidsForPhone = phoneMap[p.phone] || [];
      const primary = pickPrimaryJid(jidsForPhone);
      return {
        meeting_id: p.meeting_id,
        start_time: p.start_time,
        end_time: p.end_time,
        title: p.title,
        phone: p.phone,
        primary_jid: primary ? primary.jid : null,
        jid_type: primary ? primary.type : null,
        owner_id: p.owner_id,
      };
    });

    // 8. Busca nomes dos chats em batch
    const primaryJids = eventsToUpsert.map(e => e.primary_jid).filter(Boolean);
    const namesByJid = await fetchChatNamesBatch(primaryJids);
    for (const e of eventsToUpsert) {
      if (e.primary_jid) e.contact_name = namesByJid[e.primary_jid] || null;
    }

    // 9. UPSERT em calls_events. Usa Prefer: resolution=merge-duplicates.
    //    on_conflict precisa ser a nossa UNIQUE constraint (meeting_id, phone).
    let upserted = 0;
    if (eventsToUpsert.length > 0) {
      const CHUNK_UP = 100;
      for (let i = 0; i < eventsToUpsert.length; i += CHUNK_UP) {
        const chunk = eventsToUpsert.slice(i, i + CHUNK_UP).map(e => ({
          ...e,
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }));
        await supaRest(
          "/rest/v1/calls_events?on_conflict=meeting_id,phone",
          "POST",
          chunk,
          "resolution=merge-duplicates,return=minimal"
        );
        upserted += chunk.length;
      }
    }

    // 10. Delete stale: remove rows no range cujo meeting_id não veio no refresh
    const currentIds = Array.from(new Set(meetings.map(m => String(m.id))));
    let deleted = 0;
    if (currentIds.length > 0) {
      const idListIn = currentIds.map(id => `"${id}"`).join(",");
      const stale = await supaRest(
        `/rest/v1/calls_events?start_time=gte.${encodeURIComponent(range.start)}&start_time=lte.${encodeURIComponent(range.end)}&meeting_id=not.in.(${idListIn})&select=id`
      ).catch(() => []);
      if (Array.isArray(stale) && stale.length > 0) {
        const staleIds = stale.map(r => r.id).filter(Boolean);
        if (staleIds.length > 0) {
          const sidIn = staleIds.map(i => `"${i}"`).join(",");
          await supaRest(
            `/rest/v1/calls_events?id=in.(${sidIn})`,
            "DELETE",
            null,
            "return=minimal"
          );
          deleted = staleIds.length;
        }
      }
    } else {
      // Sem meetings no range → apaga tudo dentro do range
      await supaRest(
        `/rest/v1/calls_events?start_time=gte.${encodeURIComponent(range.start)}&start_time=lte.${encodeURIComponent(range.end)}`,
        "DELETE",
        null,
        "return=minimal"
      );
    }

    const refreshed_at = new Date().toISOString();
    const result = {
      ok: true,
      meetings_count: meetings.length,
      events_count: upserted,
      deleted_count: deleted,
      refreshed_at,
      range,
    };
    console.log("[CALLS-WEEK]", JSON.stringify(result));
    res.json(result);
  } catch (e) {
    console.error("[CALLS-WEEK] error:", e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// GET /api/hubspot/calls?from=YYYY-MM-DD&to=YYYY-MM-DD
//   Lê calls_events ordenado por start_time. Default: hoje 00:00 → hoje+7 23:59 BRT.
//   Retorna array de calls (já agrupável por dia no client).
// ============================================================================
router.get("/calls", async (req, res) => {
  try {
    const fromStr = (req.query && req.query.from) || null;
    const toStr = (req.query && req.query.to) || null;

    const now = new Date();
    const brtToday = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString().substring(0, 10);
    const from = fromStr && /^\d{4}-\d{2}-\d{2}$/.test(fromStr) ? fromStr : brtToday;
    const toBase = toStr && /^\d{4}-\d{2}-\d{2}$/.test(toStr) ? toStr : null;

    const startUTC = new Date(`${from}T00:00:00-03:00`);
    let endUTC;
    if (toBase) {
      endUTC = new Date(`${toBase}T23:59:59-03:00`);
    } else {
      endUTC = new Date(startUTC.getTime() + 7 * 24 * 60 * 60 * 1000 - 1000);
    }

    const rows = await supaRest(
      `/rest/v1/calls_events?start_time=gte.${encodeURIComponent(startUTC.toISOString())}&start_time=lte.${encodeURIComponent(endUTC.toISOString())}&select=meeting_id,start_time,end_time,title,phone,primary_jid,jid_type,contact_name,owner_id&order=start_time.asc`
    ).catch(() => []);

    res.json({
      ok: true,
      range: { start: startUTC.toISOString(), end: endUTC.toISOString() },
      events: rows || [],
    });
  } catch (e) {
    console.error("[GET /calls] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
