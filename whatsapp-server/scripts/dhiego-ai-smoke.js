const assert = require("assert");
const { routeIntent } = require("../src/services/dhiego-ai/router");
const {
  ALL_TOOLS,
  TOOL_DISPATCH,
  mapToolNameToLegacyIntent,
  toolInputToLegacyArgs,
} = require("../src/services/dhiego-ai/tool-schemas");
const { buildSystemPrompt, DEFAULT_BASE_PROMPT } = require("../src/services/dhiego-ai/prompt-builder");
const { synthesizeIntentForState } = require("../src/services/dhiego-ai/agent");

// ====== AGENT / SCHEMA / PROMPT STRUCTURAL TESTS (offline — no Claude call) ======

function runStructuralTests() {
  // 1. Every schema has a dispatch handler and vice versa (sanity).
  const schemaNames = ALL_TOOLS.map(t => t.name).sort();
  const dispatchNames = Object.keys(TOOL_DISPATCH).sort();
  assert.deepStrictEqual(
    schemaNames,
    dispatchNames,
    "Schema/dispatch mismatch. schemas=" + JSON.stringify(schemaNames) + " dispatch=" + JSON.stringify(dispatchNames)
  );
  console.log("[ok] tool-schemas: every schema has a dispatch handler (" + schemaNames.length + " tools)");

  // 2. Every schema has input_schema with type=object.
  for (const t of ALL_TOOLS) {
    assert.strictEqual(t.input_schema && t.input_schema.type, "object", "bad input_schema for " + t.name);
    assert.ok(typeof t.description === "string" && t.description.length > 20, "weak description for " + t.name);
  }
  console.log("[ok] tool-schemas: all input schemas well-formed");

  // 3. buildSystemPrompt with empty state still includes literal mode + tools policy.
  const empty = buildSystemPrompt({});
  assert.ok(empty.includes("Modo literal"), "literal mode block missing from empty prompt");
  assert.ok(empty.includes("Como usar as ferramentas"), "tools policy missing from empty prompt");
  assert.ok(empty.includes(DEFAULT_BASE_PROMPT.split("\n")[0]), "base prompt missing");
  assert.ok(!empty.includes("Contexto ativo da conversa"), "state block should not appear when state is null");
  console.log("[ok] prompt-builder: empty state prompt is well-formed");

  // 4. buildSystemPrompt injects state when provided.
  const withState = buildSystemPrompt({
    state: {
      activeTask: "idea-focus",
      focusIdeaId: 7,
      payload: { idea: { id: 7, text: "testar agendamento inteligente", status: "open" } },
    },
  });
  assert.ok(withState.includes("Contexto ativo da conversa"));
  assert.ok(withState.includes("#7"));
  assert.ok(withState.includes("testar agendamento inteligente"));
  console.log("[ok] prompt-builder: state block injects focus idea");

  // 5. buildSystemPrompt with rules groups by topic.
  const withRules = buildSystemPrompt({
    rules: [
      { topic: "faturamento", title: "Impostos", body: "Sempre somar 15% de impostos", priority: 10 },
      { topic: "faturamento", title: "Moeda", body: "Valores em BRL", priority: 20 },
      { topic: "relatorios", title: "PDF", body: "Inclui rodapé com data", priority: 5 },
    ],
  });
  assert.ok(withRules.includes("[faturamento]"), "faturamento topic header missing");
  assert.ok(withRules.includes("[relatorios]"), "relatorios topic header missing");
  assert.ok(withRules.includes("Impostos: Sempre somar 15%"));
  console.log("[ok] prompt-builder: rules grouped by topic");

  // 6. synthesizeIntentForState maps last tool call back to legacy intent.
  const intent1 = synthesizeIntentForState({
    toolCalls: [
      { name: "create_idea", input: { text: "foo" }, result: { ok: true } },
    ],
  });
  assert.deepStrictEqual(intent1, { tool: "ideas-add", args: { text: "foo" } });
  console.log("[ok] agent: create_idea synthesized to ideas-add");

  const intent2 = synthesizeIntentForState({
    toolCalls: [
      { name: "list_ideas", input: { status: "open" }, result: { ok: true } },
      { name: "generate_ideas_pdf", input: { status: "open" }, result: { ok: true } },
    ],
  });
  assert.deepStrictEqual(intent2, { tool: "ideas-pdf", args: { status: "open" } });
  console.log("[ok] agent: multi-call synthesized to last (ideas-pdf)");

  const intent3 = synthesizeIntentForState({ toolCalls: [] });
  assert.deepStrictEqual(intent3, { tool: "llm-freeform", args: {} });
  console.log("[ok] agent: empty toolCalls synthesized to llm-freeform");

  const intent4 = synthesizeIntentForState({
    toolCalls: [
      { name: "update_idea", input: { idea_id: 42, text: "novo", preserve_literal: true }, result: { ok: true } },
    ],
  });
  assert.deepStrictEqual(intent4, { tool: "ideas-update", args: { ideaId: 42, text: "novo" } });
  console.log("[ok] agent: update_idea synthesized with ideaId");

  // 7. toolInputToLegacyArgs covers every schema name (no unknown tools drop through).
  for (const name of schemaNames) {
    const legacy = toolInputToLegacyArgs(name, {});
    assert.ok(typeof legacy === "object", "toolInputToLegacyArgs dropped " + name);
  }
  console.log("[ok] agent: toolInputToLegacyArgs covers all tools");

  // 8. mapToolNameToLegacyIntent returns llm-freeform for unknown names.
  assert.strictEqual(mapToolNameToLegacyIntent("unknown_tool"), "llm-freeform");
  assert.strictEqual(mapToolNameToLegacyIntent("create_idea"), "ideas-add");
  console.log("[ok] agent: legacy intent map has fallback");
}

// ====== LEGACY ROUTER REGRESSION TESTS (must keep working — rollback path) ======

async function runRouterTests() {
  const cases = [
    {
      name: "latest idea",
      text: "me lembra da minha ultima ideia",
      expected: { tool: "ideas-latest" },
    },
    {
      name: "delete explicit",
      text: "deletar ideia 2",
      expected: { tool: "ideas-delete", args: { ideaId: "2" } },
    },
    {
      name: "update explicit",
      text: "atualiza a ideia 3: trocar o fluxo do calendario",
      expected: { tool: "ideas-update", args: { ideaId: "3", text: "trocar o fluxo do calendario" } },
    },
    {
      name: "pdf follow-up refresh",
      text: "manda atualizado",
      options: {
        history: [
          { role: "user", content: "agora atualize o relatorio e nao mostre a cancelada" },
          { role: "assistant", content: "PDF enviado", intent: "ideas-pdf" },
        ],
        state: {
          activeTask: "ideas-report",
          activeTool: "ideas-pdf",
          focusIdeaId: null,
          payload: { report: { status: "open" } },
        },
      },
      expected: { tool: "ideas-pdf", args: { status: "open" } },
    },
    {
      name: "pdf follow-up filter",
      text: "nao mostre a cancelada",
      options: {
        history: [
          { role: "user", content: "gera o pdf das ideias" },
          { role: "assistant", content: "PDF enviado", intent: "ideas-pdf" },
        ],
        state: {
          activeTask: "ideas-report",
          activeTool: "ideas-pdf",
          focusIdeaId: null,
          payload: { report: { status: "all" } },
        },
      },
      expected: { tool: "ideas-pdf", args: { status: "open" } },
    },
    {
      name: "focused update",
      text: "atualiza para: agendamento com melhor horario automatico",
      options: {
        history: [
          { role: "assistant", content: "Sua ultima ideia aberta e a #1", intent: "ideas-latest" },
        ],
        state: {
          activeTask: "idea-focus",
          activeTool: "ideas-latest",
          focusIdeaId: 1,
          payload: { idea: { id: 1, text: "agendamento antigo", status: "open" } },
        },
      },
      expected: { tool: "ideas-update", args: { ideaId: 1, text: "agendamento com melhor horario automatico" } },
    },
    {
      name: "focused multiline exact update",
      text: "Ok. Atualize ela pra essa aqui:\n\nIdeia #1 — Agendamento Inteligente de Calls no EscaladaHub\n\nAo clicar no botão \"Agendar próxima call\" de um mentorado, o sistema deverá:\n\n1. Consultar disponibilidade",
      options: {
        state: {
          activeTask: "ideas-list",
          activeTool: "ideas-list",
          focusIdeaId: 1,
          payload: { list: { status: "open" } },
        },
      },
      expected: {
        tool: "ideas-update",
        args: {
          ideaId: 1,
          text: "Ideia #1 — Agendamento Inteligente de Calls no EscaladaHub\n\nAo clicar no botão \"Agendar próxima call\" de um mentorado, o sistema deverá:\n\n1. Consultar disponibilidade",
        },
      },
    },
    {
      name: "reuse exact prior block",
      text: "nao, igual eu te mandei aqui acima",
      options: {
        history: [
          {
            role: "user",
            content: "Ok. Atualize ela pra essa aqui:\n\nIdeia #1 — Agendamento Inteligente de Calls no EscaladaHub\n\nAo clicar no botão \"Agendar próxima call\" de um mentorado, o sistema deverá:\n\n1. Consultar disponibilidade",
          },
          {
            role: "assistant",
            content: "Ideia #1 atualizada",
            intent: "ideas-update",
          },
        ],
        state: {
          activeTask: "idea-focus",
          activeTool: "ideas-update",
          focusIdeaId: 1,
          payload: { idea: { id: 1, text: "resumo errado", status: "open" } },
        },
      },
      expected: {
        tool: "ideas-update",
        args: {
          ideaId: 1,
          text: "Ideia #1 — Agendamento Inteligente de Calls no EscaladaHub\n\nAo clicar no botão \"Agendar próxima call\" de um mentorado, o sistema deverá:\n\n1. Consultar disponibilidade",
        },
      },
    },
    {
      name: "focused show",
      text: "me lembra dela",
      options: {
        state: {
          activeTask: "idea-focus",
          activeTool: "ideas-update",
          focusIdeaId: 7,
          payload: { idea: { id: 7, text: "sidebar windows", status: "open" } },
        },
      },
      expected: { tool: "ideas-show", args: { ideaId: 7 } },
    },
    {
      name: "show explicit",
      text: "como esta a ideia 7",
      expected: { tool: "ideas-show", args: { ideaId: "7" } },
    },
  ];

  for (const testCase of cases) {
    const result = await routeIntent(testCase.text, testCase.options || {});
    try {
      assert.strictEqual(result.tool, testCase.expected.tool);
      if (testCase.expected.args) {
        assert.deepStrictEqual(result.args, testCase.expected.args);
      }
      console.log("[ok] router:", testCase.name, "=>", JSON.stringify(result));
    } catch (e) {
      console.error("[fail] router:", testCase.name, "=>", JSON.stringify(result));
      throw e;
    }
  }
}

async function main() {
  console.log("=== DHIEGO.AI smoke — structural (agent + schemas + prompt) ===");
  runStructuralTests();
  console.log("\n=== DHIEGO.AI smoke — legacy router regression ===");
  await runRouterTests();
  console.log("\nAll smoke tests passed.");
}

main().catch(err => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
