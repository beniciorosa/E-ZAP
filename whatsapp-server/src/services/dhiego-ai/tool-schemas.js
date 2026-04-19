// ===== DHIEGO.AI — Tool schemas (Anthropic tool-use) =====
// Single source of truth for every internal tool the agent can invoke via
// Claude tool-use. Each tool has:
//   - an Anthropic schema (name, description, input_schema) exported in
//     ALL_TOOLS
//   - a handler exported in TOOL_DISPATCH
// The agent loop in agent.js iterates over tool_use blocks from Claude,
// looks up the handler by name, runs it with the provided ctx, then feeds
// the result back into the conversation as a tool_result block.
//
// Descriptions are in Portuguese so the model picks the right tool from
// PT-BR prompts (descriptions ARE used by the model during selection).

const ideasTool = require("./tools/ideas");
const ideasPdfTool = require("./tools/ideas-pdf");
const { callApi, getAvailableServicesDescription } = require("./tools/call-api");

// ---------- Schemas ----------

const ALL_TOOLS = [
  {
    name: "create_idea",
    description:
      "Cria uma nova ideia no backlog do Dhiego. Use quando o usuário descrever algo que ele quer lembrar depois, anotar, ou adicionar ao backlog — mesmo que ele não use a palavra 'ideia'. Preserve o texto do usuário o mais próximo possível do original.",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Texto completo da ideia, exatamente como o usuário descreveu.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "list_ideas",
    description:
      "Lista as ideias do Dhiego filtradas por status. Use quando o usuário pedir para ver/listar/mostrar ideias. Se ele não especificar, use status='open' (só as abertas).",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "done", "cancelled", "all"],
          description:
            "Filtro de status. 'open'=abertas (padrão), 'done'=concluídas, 'cancelled'=canceladas, 'all'=todas.",
        },
        limit: {
          type: "integer",
          description: "Limite de ideias retornadas (padrão 20).",
        },
      },
    },
  },
  {
    name: "latest_idea",
    description:
      "Retorna a ideia aberta mais recente do Dhiego. Use quando ele disser 'minha última ideia', 'me lembra da última ideia', 'qual foi a última' etc.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "show_idea",
    description:
      "Mostra o conteúdo e status de uma ideia específica pelo ID. Use quando o usuário quiser ver/confirmar uma ideia particular ('qual é a ideia 7', 'como está a ideia 3', 'me lembra da ideia 12').",
    input_schema: {
      type: "object",
      properties: {
        idea_id: {
          type: "integer",
          description: "ID numérico da ideia.",
        },
      },
      required: ["idea_id"],
    },
  },
  {
    name: "update_idea",
    description:
      "Atualiza o texto de uma ideia existente. Se o usuário pedir para preservar um bloco de texto EXATAMENTE como foi enviado ('igual eu mandei', 'assim mesmo', 'do jeito que está', 'sem mudar nada', 'copia e cola'), passe preserve_literal=true e copie o bloco VERBATIM no parâmetro text (todos os espaços, quebras, pontuação, emojis, acentos preservados 1:1). Se idea_id não for fornecido, o sistema usa a ideia em foco do estado atual.",
    input_schema: {
      type: "object",
      properties: {
        idea_id: {
          type: "integer",
          description:
            "ID numérico da ideia. Se não informado, será usado o focusIdeaId do estado atual.",
        },
        text: {
          type: "string",
          description:
            "Novo texto da ideia. Se preserve_literal=true, copie exatamente o bloco enviado pelo usuário, sem reformatar nem resumir.",
        },
        preserve_literal: {
          type: "boolean",
          description:
            "Quando true, o servidor grava o texto sem trim(), preservando byte a byte. Use sempre que o usuário pedir literalidade.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "complete_idea",
    description:
      "Marca uma ideia como concluída. Use quando o usuário disser que terminou/finalizou/completou uma ideia específica.",
    input_schema: {
      type: "object",
      properties: {
        idea_id: {
          type: "integer",
          description: "ID numérico da ideia. Se ausente, usa focusIdeaId do estado.",
        },
      },
    },
  },
  {
    name: "cancel_idea",
    description:
      "Cancela (arquiva sem concluir) uma ideia. Status muda para 'cancelled' mas a linha continua no banco para histórico.",
    input_schema: {
      type: "object",
      properties: {
        idea_id: {
          type: "integer",
          description: "ID numérico da ideia.",
        },
      },
    },
  },
  {
    name: "delete_idea",
    description:
      "DELETA permanentemente uma ideia do banco. Ação destrutiva — só use quando o usuário pedir explicitamente para deletar/remover/apagar/excluir (não confunda com cancelar).",
    input_schema: {
      type: "object",
      properties: {
        idea_id: {
          type: "integer",
          description: "ID numérico da ideia.",
        },
      },
    },
  },
  {
    name: "generate_ideas_pdf",
    description:
      "Gera um PDF com o backlog de ideias e retorna o arquivo para enviar no WhatsApp. Use quando o usuário pedir PDF, relatório, documento ou arquivo das ideias.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "done", "cancelled", "all"],
          description: "Filtro de status do PDF (padrão 'all').",
        },
      },
    },
  },
  {
    name: "call_api",
    description:
      "Faz uma chamada HTTP autenticada a um serviço externo pré-registrado. " +
      "Use quando o Dhiego pedir dados de CRM/faturamento, agenda/reuniões, emails, tabelas do banco, " +
      "ou qualquer informação que venha de uma API externa. Você já conhece essas APIs do seu treinamento — " +
      "monte o path e os parâmetros corretos.\n\nServiços disponíveis:\n" +
      getAvailableServicesDescription() +
      "\n\nExemplos de uso:\n" +
      "- Faturamento de hoje no HubSpot: service='hubspot', method='POST', path='/crm/v3/objects/deals/search', " +
      "body={filterGroups:[{filters:[{propertyName:'closedate',operator:'GTE',value:'<timestamp ms>'}]}], " +
      "properties:['dealname','amount','closedate','pipeline'], limit:20}\n" +
      "- Agenda de HOJE do Dhiego: service='google_calendar', method='GET', " +
      "path='/calendars/primary/events', " +
      "query_params={as_user:'dhiego@grupoescalada.com.br', timeMin:'<ISO hoje 00:00>', " +
      "timeMax:'<ISO hoje 23:59>', singleEvents:true, orderBy:'startTime'}\n" +
      "- Emails não lidos do tools@: service='gmail', method='GET', path='/users/me/messages', " +
      "query_params={as_user:'tools@grupoescalada.com.br', q:'is:unread', maxResults:10}\n" +
      "- Consultar tabela Supabase: service='supabase', method='GET', path='/rest/v1/nome_tabela?select=*&limit=10'\n\n" +
      "IMPORTANTE: Para google_calendar e gmail, SEMPRE inclua query_params.as_user com o email " +
      "(@grupoescalada.com.br) da conta a consultar. Contas autorizadas: dhiego@grupoescalada.com.br, tools@grupoescalada.com.br. " +
      "Se o Dhiego não especificar qual conta, pergunte ou assuma dhiego@ como padrão.",
    input_schema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "Nome do serviço (hubspot, supabase, etc.).",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "Método HTTP (padrão GET).",
        },
        path: {
          type: "string",
          description:
            "Path da API (ex: '/crm/v3/objects/deals' para HubSpot, '/rest/v1/tabela' para Supabase). Não inclua a base URL — só o path.",
        },
        query_params: {
          type: "object",
          description: "Query string params como objeto (ex: {limit: 10, properties: 'amount,dealname'}).",
        },
        body: {
          type: "object",
          description: "Body JSON para POST/PUT/PATCH.",
        },
      },
      required: ["service", "path"],
    },
  },
];

// ---------- Dispatch (tool_name → async handler) ----------
// Every handler returns { ok, reply, data?, document? }. The agent loop
// serializes the result as JSON and sends it back to Claude as a
// tool_result block.

function resolveIdeaId(input, ctx) {
  const raw = input && (input.idea_id ?? input.ideaId);
  const parsed = parseInt(raw, 10);
  if (parsed && parsed > 0) return parsed;
  const focus = ctx && ctx.activeState && ctx.activeState.focusIdeaId;
  return focus || null;
}

const TOOL_DISPATCH = {
  async create_idea(input, ctx) {
    return ideasTool.addIdea({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      text: input && input.text,
      sourceMessageId: ctx.sourceMessageId || null,
    });
  },

  async list_ideas(input, ctx) {
    return ideasTool.listIdeas({
      userId: ctx.userId,
      status: (input && input.status) || "open",
      limit: (input && input.limit) || 20,
    });
  },

  async latest_idea(input, ctx) {
    return ideasTool.latestIdea({ userId: ctx.userId });
  },

  async show_idea(input, ctx) {
    const ideaId = resolveIdeaId(input, ctx);
    if (!ideaId) {
      return { ok: false, reply: "Preciso do número da ideia (ex: 'me lembra da ideia 7')." };
    }
    return ideasTool.showIdea({ userId: ctx.userId, ideaId });
  },

  async update_idea(input, ctx) {
    const ideaId = resolveIdeaId(input, ctx);
    if (!ideaId) {
      return { ok: false, reply: "Preciso saber qual ideia atualizar (não há uma em foco)." };
    }
    return ideasTool.updateIdea({
      userId: ctx.userId,
      ideaId,
      text: input && input.text,
      preserveLiteral: !!(input && input.preserve_literal),
    });
  },

  async complete_idea(input, ctx) {
    const ideaId = resolveIdeaId(input, ctx);
    if (!ideaId) {
      return { ok: false, reply: "Preciso saber qual ideia concluir." };
    }
    return ideasTool.completeIdea({ userId: ctx.userId, ideaId });
  },

  async cancel_idea(input, ctx) {
    const ideaId = resolveIdeaId(input, ctx);
    if (!ideaId) {
      return { ok: false, reply: "Preciso saber qual ideia cancelar." };
    }
    return ideasTool.cancelIdea({ userId: ctx.userId, ideaId });
  },

  async delete_idea(input, ctx) {
    const ideaId = resolveIdeaId(input, ctx);
    if (!ideaId) {
      return { ok: false, reply: "Preciso saber qual ideia deletar." };
    }
    return ideasTool.deleteIdea({ userId: ctx.userId, ideaId });
  },

  async generate_ideas_pdf(input, ctx) {
    const status = (input && input.status) || "all";
    const { buffer, filename } = await ideasPdfTool.generateIdeasPdf({
      userId: ctx.userId,
      status,
    });
    return {
      ok: true,
      reply: "📄 Segue o backlog de ideias.",
      document: { buffer, filename, mimetype: "application/pdf" },
      data: { status, filename },
    };
  },

  async call_api(input, ctx) {
    return callApi({
      service: input && input.service,
      method: input && input.method,
      path: input && input.path,
      query_params: input && input.query_params,
      body: input && input.body,
    });
  },
};

// Legacy intent names used by state.syncStateAfterTurn (state.js:174).
// After the agent runs, we pick the last tool call and map it back so the
// existing derived-state logic keeps working without changes.
const TOOL_TO_LEGACY_INTENT = {
  create_idea: "ideas-add",
  list_ideas: "ideas-list",
  latest_idea: "ideas-latest",
  show_idea: "ideas-show",
  update_idea: "ideas-update",
  complete_idea: "ideas-complete",
  cancel_idea: "ideas-cancel",
  delete_idea: "ideas-delete",
  generate_ideas_pdf: "ideas-pdf",
};

function mapToolNameToLegacyIntent(toolName) {
  return TOOL_TO_LEGACY_INTENT[toolName] || "llm-freeform";
}

// Translates a Claude tool_use input back into the args shape that
// state.deriveStateUpdate expects (state.js:174 reads args.ideaId, args.text,
// args.status). Keeps the existing state-sync logic untouched.
function toolInputToLegacyArgs(toolName, input) {
  if (!input || typeof input !== "object") return {};
  switch (toolName) {
    case "create_idea":
      return { text: input.text || "" };
    case "list_ideas":
      return { status: input.status || "open" };
    case "show_idea":
    case "complete_idea":
    case "cancel_idea":
    case "delete_idea":
      return { ideaId: input.idea_id };
    case "update_idea":
      return { ideaId: input.idea_id, text: input.text || "" };
    case "generate_ideas_pdf":
      return { status: input.status || "all" };
    default:
      return {};
  }
}

module.exports = {
  ALL_TOOLS,
  TOOL_DISPATCH,
  mapToolNameToLegacyIntent,
  toolInputToLegacyArgs,
};
