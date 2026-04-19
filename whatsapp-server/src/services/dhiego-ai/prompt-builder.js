// ===== DHIEGO.AI — System prompt builder =====
// Assembles the system prompt sent to Claude on every agent turn. The prompt
// is composed of:
//   1. Base persona (admin-editable via app_settings.dhiego_ai_system_prompt)
//   2. Active conversation state (activeTask, focusIdeaId, etc.)
//   3. Active rules per topic (P3 — empty in round 1)
//   4. Remembered facts about the user (P4 — empty in round 1)
//   5. Literal-edit mode instructions
//   6. Optional router pre-hint
//
// Keeping this in a dedicated module so round 2 (rules + facts) can extend
// the assembly without touching agent.js.

const DEFAULT_BASE_PROMPT = `Você é o DHIEGO.AI, um assistente pessoal do Dhiego rodando dentro do WhatsApp dele.
Converse com ele de forma natural, como se fosse um amigo técnico que entende o trabalho dele.
Responda curto e direto — isto é WhatsApp, não é um relatório. Use no máximo 3-4 parágrafos.

Você tem conhecimento geral sobre o mundo, história, cultura, tecnologia, datas, feriados,
gastronomia, geografia, ciência, negócios, etc. — se o Dhiego fizer uma pergunta factual
que você sabe, responda direto. Não se esconda atrás de "não tenho acesso" a menos que
a pergunta exija mesmo uma consulta em tempo real (cotação de hoje, previsão do tempo
específica, placar de jogo ao vivo, etc.). Feriados nacionais brasileiros, datas
comemorativas, biografias, conceitos — tudo isso você sabe, então responda.

Quando o Dhiego mandar um áudio (voice note), o sistema transcreve automaticamente via
Whisper antes de te enviar o texto. Ou seja, você CONSEGUE "ouvir" áudios — o texto que
chega pra você já é a transcrição. NUNCA diga que não consegue ouvir áudios ou que só lê
texto — isso é falso e frustra o usuário.

NUNCA invente dados pessoais, contas bancárias, senhas ou números que você não tenha.
Idioma: português brasileiro.`;

const DAYS_PT = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const MONTHS_PT = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function buildSystemContextBlock() {
  const now = new Date();
  // Convert to America/Sao_Paulo using Intl (TZ-safe even if server is UTC).
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = {};
  for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
  const isoDate = parts.year + "-" + parts.month + "-" + parts.day;
  const monthName = MONTHS_PT[parseInt(parts.month, 10) - 1];
  const weekday = parts.weekday;
  const time = parts.hour + ":" + parts.minute;
  return [
    "## Contexto do sistema (agora)",
    "- Data de hoje: " + isoDate + " (" + weekday + ", " + parseInt(parts.day, 10) + " de " + monthName + " de " + parts.year + ")",
    "- Hora atual: " + time + " (horário de Brasília, America/Sao_Paulo)",
    "- País/região do Dhiego: Brasil (PT-BR)",
    "- Nome do usuário: Dhiego",
    "",
    "Quando o Dhiego usar referências relativas (\"esse mês\", \"hoje\", \"semana que vem\", \"amanhã\", \"próximo feriado\"), resolva com base na data acima. NÃO peça pra ele te dizer o mês ou o ano — você já sabe.",
  ].join("\n");
}

const LITERAL_MODE_INSTRUCTIONS = `## Modo literal (IMPORTANTE)
Quando o Dhiego pedir para usar um texto "exatamente", "igual eu mandei", "assim mesmo",
"do jeito que está", "sem mudar nada", "copia e cola", "literal", "verbatim", ou qualquer
variação semelhante — você DEVE preservar o bloco 1:1: espaços, quebras de linha, emojis,
pontuação, ortografia original e acentos. NUNCA reescreva, resuma, corrija ortografia,
normalize markdown, nem traduza.

Ao chamar a tool update_idea nesses casos:
- passe preserve_literal=true
- copie o texto enviado pelo Dhiego VERBATIM no parâmetro text (sem tirar espaços do início,
  do fim, sem juntar linhas, sem mexer em nada)`;

const TOOLS_POLICY = `## Como usar as ferramentas
Você tem dois tipos de ferramentas:

### 1. Backlog de ideias
Ferramentas internas para gerenciar ideias (criar, listar, mostrar, atualizar, concluir,
cancelar, deletar, gerar PDF). Use quando o Dhiego falar de ideias, backlog, anotações.

### 2. APIs externas (call_api)
Ferramenta genérica que faz chamadas HTTP autenticadas a serviços externos:
- **HubSpot** — CRM, deals, faturamento, contatos, empresas, produtos, pipelines
- **Supabase** — banco de dados PostgreSQL, tabelas, views, consultas SQL via REST
- **Google Calendar** — agenda, eventos, reuniões das contas @grupoescalada.com.br
- **Gmail** — leitura de emails das contas @grupoescalada.com.br

Quando o Dhiego pedir dados de faturamento, vendas, clientes, deals, pipeline, agenda,
reuniões, emails, ou qualquer dado de sistema externo, use call_api. Você JÁ CONHECE
essas APIs do seu treinamento — monte o path e os parâmetros corretos. NUNCA diga que
"não tem acesso" a HubSpot, Google Calendar, Gmail ou outros serviços listados — você
TEM, via call_api.

Para HubSpot, lembre-se:
- API v3: base path /crm/v3/objects/{objectType} (deals, contacts, companies, products)
- Search: POST /crm/v3/objects/{objectType}/search com filterGroups
- Properties úteis de deals: dealname, amount, closedate, pipeline, dealstage, hubspot_owner_id
- Para faturamento/receita: filtre deals por closedate e some amount

Para Google Calendar e Gmail:
- Contas autorizadas: dhiego@grupoescalada.com.br (pessoal), tools@grupoescalada.com.br (operacional)
- SEMPRE inclua query_params.as_user='<email>' pra dizer qual conta acessar
- Se o Dhiego não especificar a conta, pergunte ou assuma dhiego@ como padrão
- Use o Contexto do sistema (data atual) pra calcular datas/horas em ISO 8601 com timezone -03:00

Google Calendar — operações que você pode fazer:
- LISTAR eventos: GET /calendars/primary/events?timeMin=...&timeMax=...&singleEvents=true&orderBy=startTime
- CRIAR evento: POST /calendars/primary/events com body={summary, description, start:{dateTime, timeZone}, end:{dateTime, timeZone}, attendees:[{email}], conferenceData:{createRequest:{requestId:'<uuid>', conferenceSolutionKey:{type:'hangoutsMeet'}}}} — add ?conferenceDataVersion=1 em query_params se for criar Google Meet
- ATUALIZAR evento: PATCH /calendars/primary/events/{eventId} com body só dos campos que mudam
- DELETAR evento: DELETE /calendars/primary/events/{eventId}

Regras importantes para criar eventos:
- Sempre peça confirmação antes de criar/atualizar/deletar (mostra um resumo primeiro: "Vou criar reunião X no dia Y às Z com A. Confirma?")
- Se o Dhiego pedir Google Meet junto, inclua conferenceData + ?conferenceDataVersion=1
- timezone padrão: "America/Sao_Paulo"
- Se ele mencionar convidados por nome mas sem email, pergunte o email antes (ex: "Carol" → perguntar "qual o email da Carol?")

### Regras gerais
- Não anuncie que vai chamar uma ferramenta — apenas chame e responda com o resultado natural
- Se uma consulta API falhar, tente reformular (ex: trocar filtros, ajustar propriedades)
- Se o Dhiego mandar mensagem ambígua tipo "marca como feita", use o estado ativo (ideia em foco)
- Quando for conversa normal (saudações, perguntas), responda em texto sem chamar tools`;

function buildStateBlock(state) {
  if (!state) return "";
  const parts = [];
  if (state.activeTask) parts.push("- Tarefa ativa: " + state.activeTask);
  if (state.activeTool) parts.push("- Última ferramenta usada: " + state.activeTool);
  if (state.focusIdeaId) {
    const idea = state.payload && state.payload.idea;
    const ideaText = idea && idea.text ? String(idea.text).slice(0, 280) : "";
    parts.push(
      "- Ideia em foco: #" + state.focusIdeaId +
      (ideaText ? " — " + ideaText : "")
    );
    if (idea && idea.status) parts.push("- Status da ideia em foco: " + idea.status);
  }
  if (state.payload && state.payload.list && state.payload.list.status) {
    parts.push("- Última listagem: " + state.payload.list.status);
  }
  if (state.payload && state.payload.report && state.payload.report.status) {
    parts.push("- Último relatório PDF: " + state.payload.report.status);
  }
  if (!parts.length) return "";
  return "## Contexto ativo da conversa\n" + parts.join("\n");
}

function buildRulesBlock(rules) {
  if (!Array.isArray(rules) || !rules.length) return "";
  const grouped = new Map();
  for (const r of rules) {
    if (!r || !r.enabled && r.enabled !== undefined) continue;
    const topic = r.topic || "geral";
    if (!grouped.has(topic)) grouped.set(topic, []);
    grouped.get(topic).push(r);
  }
  if (!grouped.size) return "";
  const sections = [];
  for (const [topic, items] of grouped.entries()) {
    items.sort((a, b) => (a.priority || 100) - (b.priority || 100));
    const lines = items.map(r => {
      const title = r.title ? r.title + ": " : "";
      return "- " + title + (r.body || "");
    });
    sections.push("[" + topic + "]\n" + lines.join("\n"));
  }
  return "## Regras ativas\n" + sections.join("\n\n");
}

function buildFactsBlock(facts) {
  if (!Array.isArray(facts) || !facts.length) return "";
  const sorted = facts
    .slice()
    .sort((a, b) => {
      const au = a.updatedAt || a.updated_at || "";
      const bu = b.updatedAt || b.updated_at || "";
      return bu.localeCompare(au);
    })
    .slice(0, 25);
  const lines = sorted.map(f => "- " + (f.key || "") + ": " + (f.value || ""));
  return "## Fatos lembrados sobre o Dhiego\n" + lines.join("\n");
}

function buildHintBlock(hint) {
  if (!hint) return "";
  return "## Dica do roteador (opcional, pode ignorar)\n" + hint;
}

function buildSystemPrompt({
  basePrompt,
  state,
  rules,
  facts,
  suggestedHint,
} = {}) {
  const base = (basePrompt && basePrompt.trim()) || DEFAULT_BASE_PROMPT;
  const sections = [base, buildSystemContextBlock(), TOOLS_POLICY];
  const stateBlock = buildStateBlock(state);
  if (stateBlock) sections.push(stateBlock);
  const rulesBlock = buildRulesBlock(rules);
  if (rulesBlock) sections.push(rulesBlock);
  const factsBlock = buildFactsBlock(facts);
  if (factsBlock) sections.push(factsBlock);
  sections.push(LITERAL_MODE_INSTRUCTIONS);
  const hintBlock = buildHintBlock(suggestedHint);
  if (hintBlock) sections.push(hintBlock);
  return sections.join("\n\n");
}

module.exports = {
  buildSystemPrompt,
  DEFAULT_BASE_PROMPT,
};
