const assert = require("assert");
const { routeIntent } = require("../src/services/dhiego-ai/router");

async function main() {
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
      console.log("[ok]", testCase.name, "=>", JSON.stringify(result));
    } catch (e) {
      console.error("[fail]", testCase.name, "=>", JSON.stringify(result));
      throw e;
    }
  }
}

main().catch(err => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
