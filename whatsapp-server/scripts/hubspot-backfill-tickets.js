#!/usr/bin/env node
// whatsapp-server/scripts/hubspot-backfill-tickets.js
//
// Backfill inicial: pagina todos os tickets do HubSpot via /crm/v3/objects/tickets
// e manda pra Edge Function hubspot-tickets (que faz enrichment + upsert).
//
// Uso:
//   node whatsapp-server/scripts/hubspot-backfill-tickets.js
//
// Env vars necessárias (via .env ou shell):
//   SUPABASE_URL             - URL do projeto Supabase
//   SUPABASE_SERVICE_KEY     - service role key
//   HUBSPOT_WEBHOOK_SECRET   - mesmo secret do WEBHOOK_SECRET da Edge Function
//   HUBSPOT_API_TOKEN        - (opcional) token HubSpot. Se ausente, lê de app_settings.hubspot_api_key
//
// Estratégia:
//   - Lista todas properties que queremos trazer
//   - Pagina /crm/v3/objects/tickets?limit=100&after=<cursor>&properties=...
//   - Pra cada ticket: POST pra Edge Function com synced_from:"backfill"
//   - Rate limit: 200ms entre calls (5 req/s, bem abaixo do limit de 100/10s do HubSpot)
//   - Log de progresso a cada 50 tickets

const fs = require("fs");
const path = require("path");

// Lê .env se existir
try {
  const envPath = path.resolve(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    const envText = fs.readFileSync(envPath, "utf8");
    for (const line of envText.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
} catch (_) { /* ignora */ }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_SECRET = process.env.HUBSPOT_WEBHOOK_SECRET;
let HUBSPOT_TOKEN = process.env.HUBSPOT_API_TOKEN;

if (!SUPABASE_URL || !SERVICE_KEY || !WEBHOOK_SECRET) {
  console.error("Faltam env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, HUBSPOT_WEBHOOK_SECRET");
  process.exit(1);
}

const EDGE_FUNCTION_URL = SUPABASE_URL.replace(/\/+$/, "") + "/functions/v1/hubspot-tickets";

// Properties a puxar (casam com o que a Edge Function lê)
const PROPERTIES = [
  "hs_object_id", "subject", "content", "createdate", "hs_lastmodifieddate", "closed_date",
  "hubspot_owner_id", "hs_pipeline", "hs_pipeline_stage", "hs_ticket_priority", "hs_ticket_category",
  "hs_is_closed", "hs_resolution", "mentor_responsavel", "mentor_1o_bloco", "mentor_assistente",
  "mentoria_starter", "mentoria_pro", "mentoria_business",
  "mentoria__whatsapp_do_mentorado", "mentoria__nome_completo_do_mentorado", "mentoria__email_do_mentorado",
  "mentoria__nicho_de_produtos", "mentoria__cidade_e_estado_da_operacao", "mentoria__situacao_atual_da_conta",
  "mentoria__qual_o_faturamento_medio_mensal_atual_", "modelo_de_mentoria", "upgrade_de_mentoria",
  "cust_id_unico", "nickname", "email_da_conta_do_ml",
  "cep", "contrato__e_mail", "contrato__endereco_completo__incluindo_cep_",
  "contrato__nome_completo_ou_razao_social__de_acordo_com_o_tipo_de_contratante_",
  "contrato__numero_do_cpf_ou_cnpj__de_acordo_com_o_tipo_de_contratante_",
  "contrato__telefone", "contrato__tipo_de_contratante",
  "data_assinatura_contrato", "link_do_contrato",
  "dados_de_contrato_obtidos_pelo_cx__6_dados_e_tarefa_concluida_",
  "data_de_inicio_dos_blocos", "data_de_termino_do_1o_bloco", "data_da_call_com_dhiego",
  "nm__calls_restantes", "nm__total_de_calls_adquiridas__starter__pro__business_",
  "num_notes", "quantidade_de_calls_no_1o_bloco",
  "grupo_whatsapp", "hs_tag_ids",
  "mentorado_estagnado___nao_responde_",
  "mentoria_finalizada_ticket_deveria_ter_sido_movido_para_mentoria_finalizada",
  "renovacao_nota_do_mentor_para_a_satisfacao_do_mentorado_com_a_mentoria",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getHubspotToken() {
  if (HUBSPOT_TOKEN) return HUBSPOT_TOKEN;
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_settings?key=eq.hubspot_api_key&select=value", {
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY },
  });
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("hubspot_api_key not found");
  HUBSPOT_TOKEN = rows[0].value;
  return HUBSPOT_TOKEN;
}

async function hubspotListTickets(cursor) {
  const token = await getHubspotToken();
  const url = new URL("https://api.hubapi.com/crm/v3/objects/tickets");
  url.searchParams.set("limit", "100");
  url.searchParams.set("archived", "false");
  url.searchParams.set("properties", PROPERTIES.join(","));
  if (cursor) url.searchParams.set("after", cursor);
  const res = await fetch(url.toString(), { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error("HubSpot API " + res.status + ": " + txt);
  }
  return await res.json();
}

async function sendToEdge(ticket) {
  const payload = { ticket_id: Number(ticket.id), ...ticket.properties, synced_from: "backfill" };
  const res = await fetch(EDGE_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Secret": WEBHOOK_SECRET,
      // Edge Function exige anon token pro Supabase roteador mesmo com verify-jwt off
      Authorization: "Bearer " + SERVICE_KEY,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error("Edge " + res.status + ": " + text);
  return JSON.parse(text);
}

async function main() {
  console.log("[backfill] starting");
  console.log("[backfill] edge url:", EDGE_FUNCTION_URL);
  console.log("[backfill] properties:", PROPERTIES.length);

  const stats = { total: 0, ok: 0, errors: 0, byPipelineType: {} };
  let cursor = undefined;
  let page = 0;

  while (true) {
    page++;
    let batch;
    try {
      batch = await hubspotListTickets(cursor);
    } catch (e) {
      console.error("[backfill] page " + page + " list error:", e.message);
      break;
    }

    const tickets = batch.results || [];
    console.log("[backfill] page " + page + ": " + tickets.length + " tickets (cursor=" + (cursor || "start") + ")");

    for (const t of tickets) {
      stats.total++;
      try {
        const r = await sendToEdge(t);
        stats.ok++;
        const pt = r.pipeline_type || "unknown";
        stats.byPipelineType[pt] = (stats.byPipelineType[pt] || 0) + 1;
      } catch (e) {
        stats.errors++;
        console.error("  [err] ticket " + t.id + ": " + e.message);
      }
      if (stats.total % 50 === 0) {
        console.log("[backfill] progress: " + stats.total + " processed (" + stats.ok + " ok, " + stats.errors + " err)");
      }
      await sleep(200); // rate limit: 5 req/s
    }

    cursor = batch.paging && batch.paging.next && batch.paging.next.after;
    if (!cursor) break;
  }

  console.log("\n[backfill] ======================");
  console.log("[backfill] total processed:", stats.total);
  console.log("[backfill] success:", stats.ok);
  console.log("[backfill] errors:", stats.errors);
  console.log("[backfill] by pipeline type:", JSON.stringify(stats.byPipelineType, null, 2));
  console.log("[backfill] done");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
