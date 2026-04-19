# DHIEGO.AI Handoff

Data: 2026-04-15
Workspace: `C:\Users\dhiee\OneDrive\Desktop\zap1`
Servidor: Hetzner `root@87.99.141.235`
App PM2: `ezap-whatsapp`
Sessao ativa do DHIEGO.AI: `da47bbe6-c349-49f6-b7cd-50b0283aaabd`
Numero da sessao: `5519997012821`
User do Dhiego: `58db56f3-f84e-43b2-bbb2-17af8f52b9b8`

## Objetivo deste documento

Este arquivo existe para uma proxima sessao entender, sem ambiguidade:

- o que o usuario quer do `DHIEGO.AI`
- o que foi implementado ate agora
- o que foi deployado em producao
- o que ainda esta inadequado
- qual e a recomendacao tecnica correta daqui para frente

Este handoff e mais importante que mensagens isoladas da conversa. Se houver conflito entre intuicao de uma nova sessao e este arquivo, seguir este arquivo primeiro.

## O desejo real do usuario

O usuario deixou claro que NAO quer um bot com cara de bot.

O que ele quer:

- conversar com o `DHIEGO.AI` do mesmo jeito que conversaria com ChatGPT ou Claude
- falar livremente, sem precisar usar comandos fixos
- mandar texto grande, estrutura, markdown, codigo, regras, formatos e o assistente obedecer
- quando ele mandar um bloco pronto, o sistema deve preservar isso literalmente ou quase literalmente
- ele quer poder configurar comportamento no admin
- ele quer colocar regras especificas no admin para certos assuntos
- exemplo citado explicitamente:
  - faturamento
  - regras para uma chamada especifica
  - regras operacionais que ele mesmo defina

O que ele NAO quer:

- parecer menu de comandos
- parecer parser de regex
- o assistente resumir ou reescrever algo que ele queria manter exato
- ter que repetir sempre o numero da ideia ou o verbo exato
- sentir que esta falando com um workflow travado

Resumo honesto do desejo:

> O usuario quer um assistente `LLM-first`, com ferramentas internas, memoria de contexto e regras editaveis no admin, e nao um bot de comandos com fallback em LLM.

## Diagnostico tecnico

O problema principal NAO e falta de modelo. E arquitetura.

Arquitetura atual, antes e durante esta sessao:

- mensagem entra
- `router` tenta classificar intent
- se encaixar em `ideas-*`, executa tool
- so o que sobra cai em `llm-freeform`

Isso gera comportamento de bot porque:

- a decisao principal acontece num classificador
- tudo e empurrado para um conjunto pequeno de intents
- texto do usuario tende a ser simplificado ou reinterpretado cedo demais
- follow-up curto vira ambiguidade
- quando o usuario quer edicao literal, o sistema ainda pensa em "acao de backlog"

Conclusao:

> Enquanto o centro da decisao for `intent router first`, o DHIEGO.AI continuara parecendo bot.

## O que foi feito nesta sessao

### 1. Fix do numero final 21 / allowlist / LID

Problema encontrado:

- o numero final `21` estava conectado
- recebia mensagem
- mas o bot nao respondia
- motivo: o sender chegava como `@lid`, por exemplo `204943038361777@lid`
- a allowlist comparava so telefone normalizado

Implementado localmente e depois deployado:

- [whatsapp-server/src/services/dhiego-ai.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\src\services\dhiego-ai.js)
  - resolve sender na ordem:
    - `participantPn`
    - `wa_contacts.linked_jid`
    - `lid_phone_map.phone`
    - fallback `jid`
  - log explicito para mensagem ignorada por autorizacao
  - reply em chat `@lid` agora usa `telefone@s.whatsapp.net` quando o telefone real foi resolvido

- [whatsapp-server/src/services/baileys.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\src\services\baileys.js)
  - persiste mapeamento LID -> phone
  - persiste `linked_jid`
  - ajuda envio para contatos resolvidos via `lid`

- [supabase/migration_047_wa_contacts_linked_jid.sql](C:\Users\dhiee\OneDrive\Desktop\zap1\supabase\migration_047_wa_contacts_linked_jid.sql)
  - formaliza `wa_contacts.linked_jid`

Acao operacional em producao:

- foi necessario incluir o LID real na allowlist do `DHIEGO.AI`

Allowlist atual em producao:

- `5511989473088`
- `11989473088`
- `204943038361777`

Resultado:

- o bot voltou a responder no final `21`

### 2. Correcoes de ideias canceladas / deletadas / ultima ideia

Problema observado:

- "me lembra da minha ultima ideia" podia mostrar ideia cancelada
- "deletar/apagar/remover" estava se comportando como cancelamento, nao delete real

Implementado:

- [whatsapp-server/src/services/dhiego-ai/router.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\src\services\dhiego-ai\router.js)
  - `ideas-latest`
  - separacao de `ideas-cancel` vs `ideas-delete`

- [whatsapp-server/src/services/dhiego-ai/tools/ideas.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\src\services\dhiego-ai\tools\ideas.js)
  - `latestIdea()`
  - `deleteIdea()`

- [whatsapp-server/src/services/dhiego-ai.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\src\services\dhiego-ai.js)
  - dispatch atualizado

Resultado:

- ultima ideia prioriza backlog aberto
- deletar agora apaga de verdade

### 3. Camada contextual adicional

Motivacao:

- follow-ups curtos como `manda atualizado`
- filtro como `nao mostre a cancelada`
- referencia a ideia em foco

Implementado:

- [whatsapp-server/src/services/dhiego-ai/history.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\src\services\dhiego-ai\history.js)
  - `loadRecentEntries()` com `intent`

- [whatsapp-server/src/services/dhiego-ai/router.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\src\services\dhiego-ai\router.js)
  - contexto recente
  - follow-up contextual
  - melhor inferencia para PDF/listagem

- [whatsapp-server/src/services/dhiego-ai/tools/llm-freeform.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\src\services\dhiego-ai\tools\llm-freeform.js)
  - usa historico pre-carregado quando existe
  - evita duplicar o turno atual

- [whatsapp-server/src/services/dhiego-ai.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\src\services\dhiego-ai.js)
  - agora roteia antes de salvar

Resultado:

- `manda atualizado`
- `atualize o relatorio`
- `nao mostre a cancelada`

passaram a cair melhor no fluxo de PDF.

### 4. Estado ativo do assistente

Isto foi a maior mudanca arquitetural desta sessao.

Objetivo:

- guardar tarefa ativa
- guardar ideia em foco
- permitir follow-up sem repetir tudo

Implementado:

- [supabase/migration_048_dhiego_ai_state.sql](C:\Users\dhiee\OneDrive\Desktop\zap1\supabase\migration_048_dhiego_ai_state.sql)
  - cria `dhiego_ai_state`

- [whatsapp-server/src/services/dhiego-ai/state.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\src\services\dhiego-ai\state.js)
  - `loadState`
  - `saveState`
  - `clearState`
  - `syncStateAfterTurn`
  - fallback em memoria se o Supabase falhar

- [whatsapp-server/src/routes/dhiego-ai.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\src\routes\dhiego-ai.js)
  - nova rota `GET /api/dhiego-ai/state`
  - limpar conversas tambem limpa o estado

Resultado:

- agora existe infraestrutura para lembrar:
  - tarefa ativa
  - tool ativa
  - ideia em foco
  - payload contextual

### 5. Novas tools e comportamento de edicao

Implementado em [whatsapp-server/src/services/dhiego-ai/tools/ideas.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\src\services\dhiego-ai\tools\ideas.js):

- `showIdea()`
- `updateIdea()`
- helpers `fetchIdeaById()` e `fetchLatestOpenIdea()`

Objetivo:

- permitir:
  - `como esta a ideia 7`
  - `me lembra dela`
  - `atualiza a ideia 3: ...`

### 6. Correcoes especificas do LLM

Bug encontrado:

- o historico passado ao Claude estava incluindo `intent`
- a API rejeitava isso com:
  - `messages.0.intent: Extra inputs are not permitted`

Corrigido em:

- [whatsapp-server/src/services/dhiego-ai/tools/llm-freeform.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\src\services\dhiego-ai\tools\llm-freeform.js)

### 7. Caso real da captura: multiline e "igual eu te mandei aqui acima"

Problema real observado pelo usuario:

- ele mandou um bloco longo pronto
- o bot atualizou com uma versao resumida
- ao corrigir com:
  - `Tem que colocar exatamente como eu te mandei`
  - `nao, igual eu te mandei aqui acima`
- o sistema ainda saiu do fluxo e voltou para listagem/interpretacao errada

Implementado:

- [whatsapp-server/src/services/dhiego-ai/router.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\src\services\dhiego-ai\router.js)
  - reconhecimento de update multiline
  - reconhecimento de:
    - `Atualize ela pra essa aqui:`
    - `atualiza para:`
    - `igual eu te mandei aqui acima`
    - `exatamente como eu te mandei`
  - reaproveitamento do ultimo bloco grande de update do historico

Isso melhora bastante o caso de edicao, mas ainda e uma solucao em cima da arquitetura antiga.

## Testes locais adicionados

Foi criado:

- [whatsapp-server/scripts/dhiego-ai-smoke.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\scripts\dhiego-ai-smoke.js)

Foi adicionado em:

- [whatsapp-server/package.json](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\package.json)
  - script `npm run test:dhiego-ai`

Cenarios cobertos:

- `me lembra da minha ultima ideia`
- `deletar ideia 2`
- `atualiza a ideia 3: ...`
- `manda atualizado`
- `nao mostre a cancelada`
- `atualiza para: ...` com ideia em foco
- `me lembra dela`
- `como esta a ideia 7`
- multiline exact update
- reuse exact prior block

## O que foi deployado em producao

### Backups remotos relevantes

- `dhiego-ai.js.bak.20260415_171433`
- `baileys.js.bak.20260415_171433`
- `dhiego-ai.js.bak.20260415_174925`
- `router.js.bak.20260415_174925`
- `ideas.js.bak.20260415_174925`
- `llm-freeform.js.bak.20260415_211444`
- `router.js.bak.20260415_212929`
- backup amplo contextual:
  - timestamp `20260415_184353`

### Migrations aplicadas

- `047` aplicada
- `048` aplicada

Observacao importante:

- a `048` falhou algumas vezes via Management API por transporte/payload
- no fim entrou com payload JSON em arquivo temporario e `curl --data-binary`

### Estado atual de producao ao fim desta sessao

- `pm2` online
- health `ok`
- sessao `da47bbe6-c349-49f6-b7cd-50b0283aaabd` conectada
- `/api/dhiego-ai/state` responde

## O que ainda esta inadequado

Apesar das correcoes, o usuario explicitamente continuou insatisfeito.

Razao:

- o sistema ainda pensa como bot
- ainda tenta converter conversa em intent cedo demais
- ainda existe risco de reescrever o texto do usuario quando ele queria literalidade
- ainda existe uma "sensacao de workflow" em vez de conversa natural

Em outras palavras:

> O sistema esta melhor, mas ainda esta filosoficamente errado para o desejo do usuario.

## Sugestao tecnica correta

### Troca de paradigma

Parar de tratar o `router` como autoridade principal.

Arquitetura recomendada:

1. `LLM-first orchestration`
- toda mensagem entra primeiro no modelo
- o modelo decide:
  - responder diretamente
  - usar uma tool
  - entrar em modo de edicao literal
  - consultar memoria

2. `Tools internas`
- ideias
- PDF
- faturamento
- mensagens
- playbooks
- tudo como ferramenta interna, nao como "comando do usuario"

3. `Policies / rules no admin`

O admin deve permitir:

- prompt base do assistente
- regras globais
- regras por categoria
- regras por rotina
- regras por gatilho
- exemplos de resposta
- modo literal por contexto

Exemplos de regras que o usuario quer poder cadastrar:

- faturamento
- formato de relatorio especifico
- forma de responder em uma chamada especifica
- obrigacoes operacionais
- "se eu mandar um bloco pronto, nao resuma"

4. `Modo literal`

Quando o usuario manda texto pronto:

- o sistema nao deve "melhorar" o texto automaticamente
- deve preservar o bloco quase 1:1
- qualquer resumo ou reformatacao so se o usuario pedir

5. `Estado de conversa mais rico`

Nao so:

- `activeTask`
- `focusIdeaId`

Mas tambem:

- `mode`: `chat`, `literal_edit`, `tool_execution`, `reporting`
- `topic`: `ideias`, `faturamento`, `mensagem_cliente`, `agenda`
- `policySet`: quais regras estao ativas
- `preserveLiteral`: boolean

## Recomendacao objetiva para a proxima sessao

Nao gastar tempo apenas aumentando regex.

Isso ja entrou na zona de retorno decrescente.

Fazer a migracao em etapas:

### Etapa 1. LLM-first

Objetivo:

- remover o `intent router` como gatekeeper principal
- deixar o LLM decidir se precisa chamar tool

### Etapa 2. Rule engine no admin

Criar estrutura em `app_settings` ou tabela propria para:

- regras globais
- regras por contexto
- regras por assunto
- exemplos
- prioridade de regras

### Etapa 3. Literal editing mode

Quando detectar bloco longo + linguagem tipo:

- `coloca exatamente assim`
- `igual eu mandei`
- `usa esse texto`

ativar modo literal.

### Etapa 4. Tool use invisivel

O usuario continua falando livremente.
As tools continuam existindo, mas o modelo as invoca internamente.

### Etapa 5. Suite de avaliacao com frases reais do usuario

Montar dataset com frases do proprio Dhiego.
Medir:

- intencao correta
- preservacao literal
- uso ou nao uso de tool
- satisfacao do formato

## Frase-resumo para a proxima sessao

Se for preciso resumir tudo em uma frase:

> O usuario nao quer "melhorar o bot"; ele quer substituir a experiencia de bot por um assistente LLM-first, livre, com tools invisiveis e regras configuraveis no admin.

## Arquivos mais importantes para ler primeiro

1. [DHIEGO_AI_HANDOFF.md](C:\Users\dhiee\OneDrive\Desktop\zap1\DHIEGO_AI_HANDOFF.md)
2. [whatsapp-server/src/services/dhiego-ai.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\src\services\dhiego-ai.js)
3. [whatsapp-server/src/services/dhiego-ai/router.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\src\services\dhiego-ai\router.js)
4. [whatsapp-server/src/services/dhiego-ai/state.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\src\services\dhiego-ai\state.js)
5. [whatsapp-server/src/services/dhiego-ai/tools/ideas.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\src\services\dhiego-ai\tools\ideas.js)
6. [whatsapp-server/src/services/dhiego-ai/tools/llm-freeform.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\src\services\dhiego-ai\tools\llm-freeform.js)
7. [whatsapp-server/scripts/dhiego-ai-smoke.js](C:\Users\dhiee\OneDrive\Desktop\zap1\whatsapp-server\scripts\dhiego-ai-smoke.js)
8. [SUMMARY.md](C:\Users\dhiee\OneDrive\Desktop\zap1\SUMMARY.md)

## Ultima conclusao

Foi feito bastante trabalho util:

- conectividade
- LID
- allowlist
- ideias
- estado ativo
- follow-up contextual
- multiline update

Mas a recomendacao tecnica final nao mudou:

> O caminho certo agora e migrar do modelo `bot de intents com fallback LLM` para `assistente LLM-first com policies e tools`.

