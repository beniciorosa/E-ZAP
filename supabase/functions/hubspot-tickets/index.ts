// supabase/functions/hubspot-tickets/index.ts
// Webhook receiver para tickets do Hubspot (ou similar)
// Autenticacao: header X-Webhook-Secret
// Acao: INSERT na tabela mentorados (idempotente via unique constraint em ticket_id)

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

const normalizeTier = (v: unknown): boolean => v === "true" || v === true;

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // Auth: shared secret no header
  const secret = req.headers.get("x-webhook-secret");
  if (!WEBHOOK_SECRET || !secret || secret !== WEBHOOK_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Parse body
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

  const row = {
    ticket_id: ticketId,
    ticket_name: ticketName.trim(),
    mentor_responsavel:
      typeof payload.mentor_responsavel === "string"
        ? payload.mentor_responsavel
        : null,
    whatsapp_do_mentorado:
      typeof payload.whatsapp_do_mentorado === "string"
        ? payload.whatsapp_do_mentorado
        : null,
    mentoria_starter: normalizeTier(payload["Mentoria Starter"]),
    mentoria_pro: normalizeTier(payload["Mentoria PRO"]),
    mentoria_business: normalizeTier(payload["Mentoria Business"]),
    raw_payload: payload,
  };

  const { data, error } = await supabase
    .from("mentorados")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    // 23505 = unique_violation (ticket_id duplicado) -> idempotencia
    // deno-lint-ignore no-explicit-any
    const code = (error as any).code;
    if (code === "23505") {
      return json({ ok: true, duplicate: true }, 200);
    }
    console.error("Insert error:", error);
    return json({ error: "Database error", details: error.message }, 500);
  }

  return json({ ok: true, id: data.id }, 201);
});
