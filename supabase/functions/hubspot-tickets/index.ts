// supabase/functions/hubspot-tickets/index.ts
// Webhook receiver + backfill ingest para tickets do HubSpot.
// Autenticacao: header X-Webhook-Secret
// Escreve em: hubspot_tickets (tabela espelho). Trigger Postgres propaga
// pra mentorados automaticamente quando tier estiver setado.
//
// Payload esperado (todos opcionais exceto ticket_id):
//   ticket_id (required, number), hs_pipeline, hs_pipeline_stage,
//   subject, hubspot_owner_id, mentor_responsavel,
//   mentoria_starter/pro/business, mentoria__whatsapp_do_mentorado,
//   mentoria__nome_completo_do_mentorado, mentoria__email_do_mentorado,
//   mentoria__nicho_de_produtos, mentoria__cidade_e_estado_da_operacao,
//   mentoria__situacao_atual_da_conta, mentoria__qual_o_faturamento_...,
//   modelo_de_mentoria, upgrade_de_mentoria, cust_id_unico, nickname,
//   email_da_conta_do_ml, cep, contrato__endereco..., contrato__nome...,
//   contrato__numero_do_cpf_ou_cnpj..., contrato__tipo_de_contratante,
//   contrato__e_mail, contrato__telefone, link_do_contrato,
//   data_assinatura_contrato, dados_de_contrato_obtidos..., data_de_inicio_dos_blocos,
//   data_de_termino_do_1o_bloco, data_da_call_com_dhiego,
//   nm__calls_restantes, nm__total_de_calls_adquiridas..., num_notes,
//   quantidade_de_calls_no_1o_bloco, grupo_whatsapp, hs_tag_ids,
//   mentorado_estagnado___nao_responde_, mentoria_finalizada...,
//   renovacao_nota_do_mentor..., hs_ticket_priority, hs_is_closed,
//   createdate, hs_lastmodifieddate, closed_date, synced_from
//
// Enrichment:
//   - owner_name/email via GET /crm/v3/owners/{id} (cache 24h)
//   - pipeline_name/stage_name via GET /crm/v3/pipelines/tickets (cache 24h)
//   - pre_mentoria_ticket_id via associations pra tickets de mentoria
//
// Normalização:
//   - cep: só dígitos (8). null se inválido.
//   - cpf_cnpj: só dígitos (11 ou 14). tipo_contratante derivado do length.
//   - telefones: E.164 sem + (ex: "5519994388320")
//   - datas: qualquer formato HubSpot -> ISO timestamptz
//   - booleans: "true"/"false" strings -> bool
//   - hs_tag_ids: split ";"

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Pipeline IDs conhecidos pro pipeline_type derivation
const PIPELINE_MENTORIA_IDS = new Set(["0", "829156887"]);
const PIPELINE_PRE_MENTORIA_ID = "698843004";
const PIPELINE_APROVACAO_FINANCEIRO_ID = "707332214";

// Cache in-memory (TTL 24h)
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
interface CacheEntry {
  value: unknown;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();
function cacheGet(key: string): unknown | null {
  const e = cache.get(key);
  if (!e || e.expiresAt < Date.now()) {
    if (e) cache.delete(key);
    return null;
  }
  return e.value;
}
function cacheSet(key: string, value: unknown) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// HubSpot API token (lido do app_settings via service role)
let hubspotTokenCached: string | null = null;
async function getHubspotToken(): Promise<string> {
  if (hubspotTokenCached) return hubspotTokenCached;
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "hubspot_api_key")
    .single();
  if (error || !data || typeof data.value !== "string") {
    throw new Error("hubspot_api_key not found in app_settings");
  }
  hubspotTokenCached = data.value;
  return hubspotTokenCached as string;
}

async function hubspotFetch(path: string): Promise<unknown | null> {
  try {
    const token = await getHubspotToken();
    const res = await fetch("https://api.hubapi.com" + path, {
      headers: { Authorization: "Bearer " + token },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn("hubspotFetch error", path, (e as Error).message);
    return null;
  }
}

// ===== Enrichment =====

async function resolveOwner(id: string | null | undefined): Promise<{ name: string | null; email: string | null }> {
  if (!id) return { name: null, email: null };
  const ck = "owner:" + id;
  const hit = cacheGet(ck) as { name: string | null; email: string | null } | null;
  if (hit) return hit;
  const data = (await hubspotFetch("/crm/v3/owners/" + encodeURIComponent(id))) as
    | { firstName?: string; lastName?: string; email?: string } | null;
  if (!data) {
    const empty = { name: null, email: null };
    cacheSet(ck, empty);
    return empty;
  }
  const name = [data.firstName, data.lastName].filter(Boolean).join(" ") || null;
  const email = data.email || null;
  const result = { name, email };
  cacheSet(ck, result);
  return result;
}

// deno-lint-ignore no-explicit-any
let pipelinesCache: any = null;
let pipelinesCacheAt = 0;
async function getPipelinesIndex(): Promise<Record<string, { name: string; stages: Record<string, string> }>> {
  if (pipelinesCache && Date.now() - pipelinesCacheAt < CACHE_TTL_MS) return pipelinesCache;
  const data = (await hubspotFetch("/crm/v3/pipelines/tickets")) as
    | { results: Array<{ id: string; label: string; stages: Array<{ id: string; label: string }> }> } | null;
  if (!data || !data.results) return {};
  const idx: Record<string, { name: string; stages: Record<string, string> }> = {};
  for (const p of data.results) {
    const stages: Record<string, string> = {};
    for (const s of p.stages || []) stages[s.id] = s.label;
    idx[p.id] = { name: p.label, stages };
  }
  pipelinesCache = idx;
  pipelinesCacheAt = Date.now();
  return idx;
}

async function resolvePipeline(
  pipelineId: string | null | undefined,
  stageId: string | null | undefined,
): Promise<{ name: string | null; stageName: string | null }> {
  if (!pipelineId) return { name: null, stageName: null };
  const idx = await getPipelinesIndex();
  const p = idx[pipelineId];
  if (!p) return { name: null, stageName: null };
  return { name: p.name, stageName: stageId ? (p.stages[stageId] || null) : null };
}

function pipelineTypeFromId(pipelineId: string | null | undefined): string {
  if (!pipelineId) return "outro";
  const id = String(pipelineId);
  if (PIPELINE_MENTORIA_IDS.has(id)) return "mentoria";
  if (id === PIPELINE_PRE_MENTORIA_ID) return "pre_mentoria";
  if (id === PIPELINE_APROVACAO_FINANCEIRO_ID) return "aprovacao_financeiro";
  return "outro";
}

// Procura primeiro contact "real" (não bot) associado ao ticket
// Heurística: contato com menos tickets (< 50) é provavelmente o real.
async function resolvePrimaryContactId(ticketId: string): Promise<string | null> {
  const data = (await hubspotFetch(
    "/crm/v3/objects/tickets/" + encodeURIComponent(ticketId) + "/associations/contacts",
  )) as { results?: Array<{ id: string }> } | null;
  if (!data || !data.results || data.results.length === 0) return null;

  // Se tem 1 contact só, esse é o real
  if (data.results.length === 1) return data.results[0].id;

  // Mais de 1: escolhe o que tem menos tickets associados
  let best: { id: string; count: number } | null = null;
  for (const c of data.results) {
    const tkts = (await hubspotFetch(
      "/crm/v3/objects/contacts/" + encodeURIComponent(c.id) + "/associations/tickets",
    )) as { results?: Array<unknown> } | null;
    const count = tkts?.results?.length ?? 999;
    if (count > 50) continue; // provável bot
    if (!best || count < best.count) best = { id: c.id, count };
  }
  return best?.id ?? null;
}

// Dado um contact_id, encontra o ticket correspondente num pipeline específico
async function findTicketByPipelineForContact(
  contactId: string,
  targetPipelineIds: string[],
): Promise<number | null> {
  const data = (await hubspotFetch(
    "/crm/v3/objects/contacts/" + encodeURIComponent(contactId) + "/associations/tickets",
  )) as { results?: Array<{ id: string }> } | null;
  if (!data || !data.results) return null;

  // Batch fetch pipeline de cada ticket (limitado pra não estourar)
  const candidates: Array<{ id: string; created: string }> = [];
  for (const t of data.results.slice(0, 30)) {
    const info = (await hubspotFetch(
      "/crm/v3/objects/tickets/" + encodeURIComponent(t.id) + "?properties=hs_pipeline,createdate",
    )) as { properties?: { hs_pipeline?: string; createdate?: string } } | null;
    if (!info || !info.properties) continue;
    if (targetPipelineIds.includes(String(info.properties.hs_pipeline))) {
      candidates.push({ id: t.id, created: info.properties.createdate || "" });
    }
  }
  if (candidates.length === 0) return null;
  // Mais recente
  candidates.sort((a, b) => (b.created > a.created ? 1 : -1));
  return Number(candidates[0].id);
}

// ===== Normalização de valores =====

function parseBoolStr(v: unknown): boolean | null {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return null;
}

function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toNumeric(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toTimestamp(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  if (!s) return null;
  // Unix ms em string (ex: "1753315200000")
  if (/^\d{12,14}$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return new Date(n).toISOString();
  }
  // Só data (ex: "2026-01-13")
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00Z").toISOString();
  // ISO já (aceita qualquer parseable)
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  return null;
}

function digitsOnly(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\D/g, "");
  return s || null;
}

function parseCep(v: unknown): string | null {
  const d = digitsOnly(v);
  return d && d.length === 8 ? d : null;
}

function parseCpfCnpj(v: unknown): { value: string | null; tipo: string | null } {
  const d = digitsOnly(v);
  if (!d) return { value: null, tipo: null };
  if (d.length === 11) return { value: d, tipo: "cpf" };
  if (d.length === 14) return { value: d, tipo: "cnpj" };
  return { value: null, tipo: null };
}

function parsePhoneBr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = String(v).replace(/\D/g, "");
  if (!d || d.length < 10) return null;
  // Se já tem DDI 55 na frente (12-13 dígitos), retorna
  if (d.length === 12 || d.length === 13) return d;
  // 10 ou 11 dígitos: adiciona DDI 55
  if (d.length === 10 || d.length === 11) return "55" + d;
  return null;
}

function parseEmail(v: unknown): string | null {
  if (!v || typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

function parseTagIds(v: unknown): string[] | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.split(";").map((x) => x.trim()).filter(Boolean);
}

function parseInviteLink(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  // "Link: " sozinho vira null
  const cleaned = s.replace(/^Link:\s*/i, "").trim();
  if (!cleaned) return null;
  // Só aceita se parece com URL
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  return null;
}

function deriveTier(starter: boolean | null, pro: boolean | null, business: boolean | null): string | null {
  if (business) return "business";
  if (pro) return "pro";
  if (starter) return "starter";
  return null;
}

// ===== HTTP handler =====

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = req.headers.get("x-webhook-secret");
  if (!WEBHOOK_SECRET || !secret || secret !== WEBHOOK_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Expected single object" }, 400);
  }

  const p = body as Record<string, unknown>;
  const ticketId = Number(p.ticket_id ?? p.hs_object_id);
  if (!Number.isFinite(ticketId) || ticketId <= 0) {
    return json({ error: "ticket_id required (positive number)" }, 400);
  }

  const syncedFrom = typeof p.synced_from === "string" ? p.synced_from : "webhook";

  // Enrichment (lookups em paralelo quando possível)
  const ownerId = p.hubspot_owner_id ? String(p.hubspot_owner_id) : null;
  const mentorId = p.mentor_responsavel ? String(p.mentor_responsavel) : null;
  const pipelineId = p.hs_pipeline ? String(p.hs_pipeline) : null;
  const stageId = p.hs_pipeline_stage ? String(p.hs_pipeline_stage) : null;

  const [owner, mentor, pipelineInfo] = await Promise.all([
    resolveOwner(ownerId),
    resolveOwner(mentorId),
    resolvePipeline(pipelineId, stageId),
  ]);

  const pipelineType = pipelineTypeFromId(pipelineId);

  // Cross-ticket lookup (pre <-> mentoria via contact)
  let primaryContactId: string | null = null;
  let preMentoriaTicketId: number | null = null;
  let mentoriaTicketId: number | null = null;

  if (pipelineType === "mentoria" || pipelineType === "pre_mentoria") {
    primaryContactId = await resolvePrimaryContactId(String(ticketId));
    if (primaryContactId) {
      if (pipelineType === "mentoria") {
        preMentoriaTicketId = await findTicketByPipelineForContact(primaryContactId, [PIPELINE_PRE_MENTORIA_ID]);
      } else {
        mentoriaTicketId = await findTicketByPipelineForContact(
          primaryContactId,
          Array.from(PIPELINE_MENTORIA_IDS),
        );
      }
    }
  }

  // Normalizações
  const mentoriaStarter = parseBoolStr(p["Mentoria Starter"] ?? p.mentoria_starter);
  const mentoriaPro = parseBoolStr(p["Mentoria PRO"] ?? p.mentoria_pro);
  const mentoriaBusiness = parseBoolStr(p["Mentoria Business"] ?? p.mentoria_business);
  const tier = deriveTier(mentoriaStarter, mentoriaPro, mentoriaBusiness);

  const hsIsClosed = parseBoolStr(p.hs_is_closed);
  const statusTicket = hsIsClosed === true ? "closed" : hsIsClosed === false ? "open" : null;

  const cpfCnpj = parseCpfCnpj(p.contrato__numero_do_cpf_ou_cnpj__de_acordo_com_o_tipo_de_contratante_);

  // Monta row
  // deno-lint-ignore no-explicit-any
  const row: Record<string, any> = {
    ticket_id: ticketId,
    ticket_name: typeof p.subject === "string" ? p.subject : null,

    owner_id: ownerId,
    owner_name: owner.name,
    owner_email: owner.email,

    pipeline_id: pipelineId,
    pipeline_name: pipelineInfo.name,
    pipeline_stage_id: stageId,
    pipeline_stage_name: pipelineInfo.stageName,
    pipeline_type: pipelineType,

    mentor_responsavel_id: mentorId,
    mentor_responsavel_name: mentor.name,

    tier,
    mentoria_starter: mentoriaStarter,
    mentoria_pro: mentoriaPro,
    mentoria_business: mentoriaBusiness,
    status_ticket: statusTicket,
    priority: typeof p.hs_ticket_priority === "string" ? p.hs_ticket_priority : null,

    ticket_created_at: toTimestamp(p.createdate),
    ticket_updated_at: toTimestamp(p.hs_lastmodifieddate),
    ticket_closed_at: toTimestamp(p.closed_date),

    pre_mentoria_ticket_id: preMentoriaTicketId,
    mentoria_ticket_id: mentoriaTicketId,

    nome_do_mentorado: typeof p.mentoria__nome_completo_do_mentorado === "string" ? p.mentoria__nome_completo_do_mentorado : null,
    whatsapp_do_mentorado: parsePhoneBr(p.mentoria__whatsapp_do_mentorado),
    email_do_mentorado: parseEmail(p.mentoria__email_do_mentorado),
    nicho_produtos: typeof p.mentoria__nicho_de_produtos === "string" ? p.mentoria__nicho_de_produtos : null,
    cidade_estado: typeof p.mentoria__cidade_e_estado_da_operacao === "string" ? p.mentoria__cidade_e_estado_da_operacao : null,
    situacao_atual: typeof p.mentoria__situacao_atual_da_conta === "string" ? p.mentoria__situacao_atual_da_conta : null,
    faturamento_range: typeof p.mentoria__qual_o_faturamento_medio_mensal_atual_ === "string" ? p.mentoria__qual_o_faturamento_medio_mensal_atual_ : null,
    modelo_de_mentoria: typeof p.modelo_de_mentoria === "string" ? p.modelo_de_mentoria : null,
    upgrade_de_mentoria: typeof p.upgrade_de_mentoria === "string" ? p.upgrade_de_mentoria : null,
    seller_id_meli: digitsOnly(p.cust_id_unico),
    seller_nickname_meli: typeof p.nickname === "string" ? p.nickname : null,
    seller_email_meli: parseEmail(p.email_da_conta_do_ml),

    cep: parseCep(p.cep),
    endereco_completo: typeof p.contrato__endereco_completo__incluindo_cep_ === "string" ? p.contrato__endereco_completo__incluindo_cep_ : null,
    razao_social_ou_nome: typeof p.contrato__nome_completo_ou_razao_social__de_acordo_com_o_tipo_de_contratante_ === "string" ? p.contrato__nome_completo_ou_razao_social__de_acordo_com_o_tipo_de_contratante_ : null,
    cpf_cnpj: cpfCnpj.value,
    tipo_contratante: cpfCnpj.tipo,
    email_contrato: parseEmail(p.contrato__e_mail),
    telefone_contrato: parsePhoneBr(p.contrato__telefone),
    link_contrato: typeof p.link_do_contrato === "string" && p.link_do_contrato.trim() ? p.link_do_contrato.trim() : null,
    data_assinatura_contrato: toTimestamp(p.data_assinatura_contrato),
    contrato_obtido: parseBoolStr(p.dados_de_contrato_obtidos_pelo_cx__6_dados_e_tarefa_concluida_),

    data_inicio_blocos: toTimestamp(p.data_de_inicio_dos_blocos),
    data_termino_1o_bloco: toTimestamp(p.data_de_termino_do_1o_bloco),
    data_call_dhiego: toTimestamp(p.data_da_call_com_dhiego),
    calls_restantes: toInt(p.nm__calls_restantes),
    calls_totais: toInt(p.nm__total_de_calls_adquiridas__starter__pro__business_),
    quantidade_calls_1o_bloco: toInt(p.quantidade_de_calls_no_1o_bloco),
    num_notes: toInt(p.num_notes),
    primary_contact_id: primaryContactId,

    grupo_whatsapp_link: parseInviteLink(p.grupo_whatsapp),
    hs_tag_ids: parseTagIds(p.hs_tag_ids),
    mentorado_estagnado: parseBoolStr(p.mentorado_estagnado___nao_responde_),
    mentoria_finalizada: parseBoolStr(p.mentoria_finalizada_ticket_deveria_ter_sido_movido_para_mentoria_finalizada),
    renovacao_nota_satisfacao: toNumeric(p.renovacao_nota_do_mentor_para_a_satisfacao_do_mentorado_com_a_mentoria),

    raw_payload: p,
    synced_from: syncedFrom,
    synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("hubspot_tickets")
    .upsert(row, { onConflict: "ticket_id" })
    .select("id")
    .single();

  if (error) {
    console.error("upsert error:", error);
    return json({ error: "Database error", details: error.message }, 500);
  }

  return json({ ok: true, id: data.id, ticket_id: ticketId, pipeline_type: pipelineType }, 200);
});
