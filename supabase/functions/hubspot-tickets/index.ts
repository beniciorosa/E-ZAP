// supabase/functions/hubspot-tickets/index.ts
// Webhook receiver para tickets do HubSpot.
// Autenticacao: header X-Webhook-Secret
// Acao: UPSERT na tabela mentorados (idempotente por ticket_id).
//
// Campos aceitos no payload (todos opcionais exceto ticket_id + ticket_name):
//   - ticket_id (required, number)
//   - ticket_name (required, string)
//   - mentor_responsavel (string)
//   - whatsapp_do_mentorado (string)
//   - Mentoria Starter / Mentoria PRO / Mentoria Business (bool-like)
//   - pipeline_id / pipeline_stage_id (string) — HubSpot hs_pipeline, hs_pipeline_stage
//   - pipeline_name / pipeline_stage_name (string) — nomes legíveis
//
// Comportamento:
//   - Creation: insere a row completa
//   - Update: só sobrescreve os campos que vieram no payload (preserva restante)
//   - Trigger trg_sync_mentorados_to_group_creations cascateia as mudanças
//     para wa_group_creations (qualquer row com mesmo hubspot_ticket_id)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const normalizeTier = (v: unknown): boolean | null => {
  if (v === undefined) return null;
  return v === "true" || v === true;
};

const pickString = (v: unknown): string | null | undefined => {
  if (v === undefined) return undefined;
  if (typeof v === "string") return v.trim() || null;
  return null;
};

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

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

  if (Array.isArray(body) || typeof body !== "object" || body === null) {
    return json({ error: "Expected single object" }, 400);
  }

  const payload = body as Record<string, unknown>;
  const ticketId = Number(payload.ticket_id);
  const ticketName = payload.ticket_name;

  if (!Number.isFinite(ticketId) || ticketId <= 0) {
    return json({ error: "ticket_id must be a positive number" }, 400);
  }
  if (typeof ticketName !== "string" || ticketName.trim() === "") {
    return json({ error: "ticket_name is required" }, 400);
  }

  // Monta row só com os campos presentes no payload.
  // Assim um webhook que só atualiza pipeline_stage_id não zera outros
  // campos já gravados (mentor, tiers, etc).
  // deno-lint-ignore no-explicit-any
  const row: Record<string, any> = {
    ticket_id: ticketId,
    ticket_name: ticketName.trim(),
    raw_payload: payload,
    updated_at: new Date().toISOString(),
  };

  const mentor = pickString(payload.mentor_responsavel);
  if (mentor !== undefined) row.mentor_responsavel = mentor;

  const whatsapp = pickString(payload.whatsapp_do_mentorado);
  if (whatsapp !== undefined) row.whatsapp_do_mentorado = whatsapp;

  const starter = normalizeTier(payload["Mentoria Starter"]);
  if (starter !== null) row.mentoria_starter = starter;
  const pro = normalizeTier(payload["Mentoria PRO"]);
  if (pro !== null) row.mentoria_pro = pro;
  const business = normalizeTier(payload["Mentoria Business"]);
  if (business !== null) row.mentoria_business = business;

  const pipelineId = pickString(payload.pipeline_id);
  if (pipelineId !== undefined) row.pipeline_id = pipelineId;
  const pipelineStageId = pickString(payload.pipeline_stage_id);
  if (pipelineStageId !== undefined) row.pipeline_stage_id = pipelineStageId;
  const pipelineName = pickString(payload.pipeline_name);
  if (pipelineName !== undefined) row.pipeline_name = pipelineName;
  const pipelineStageName = pickString(payload.pipeline_stage_name);
  if (pipelineStageName !== undefined) row.pipeline_stage_name = pipelineStageName;

  const { data, error } = await supabase
    .from("mentorados")
    .upsert(row, { onConflict: "ticket_id" })
    .select("id")
    .single();

  if (error) {
    console.error("Upsert error:", error);
    return json({ error: "Database error", details: error.message }, 500);
  }

  return json({ ok: true, id: data.id }, 200);
});
