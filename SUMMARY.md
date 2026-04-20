# E-ZAP — Sessão de trabalho 2026-04-14/20

> 📌 **Próxima sessão**: para qualquer trabalho na ferramenta de grupos (grupos.html, criação em massa, Auto-criar, Dashboard, wa_group_*), LER TAMBÉM [GRUPOS.md](GRUPOS.md) na raiz — é o handoff vivo e canônico dessa área (arquitetura, tabelas, endpoints, funções, deploy pattern, changelog). Este SUMMARY tem só o cronológico; GRUPOS.md tem o estado atual consolidado.

> **Update 2026-04-20 (commit `deb412c`) — Auto-criar grupos por mentor + Dashboard histórico + fix título HubSpot — DEPLOYED**
>
> Plano: [C:\Users\dhiee\.claude\plans\leia-o-summary-md-entenda-linear-curry.md](C:\Users\dhiee\.claude\plans\leia-o-summary-md-entenda-linear-curry.md)
>
> Quatro mudanças na ferramenta de grupos (grupos.html + backend Hetzner). Nenhuma migração SQL — todos os campos já existem em `hubspot_tickets` (054) e `wa_group_creations` (041+053).
>
> ### 1) `/api/hubspot/resolve-tickets` passa a ler de `hubspot_tickets` (fonte canônica)
> Antes: query em `mentorados` (tabela legacy populada por trigger de `hubspot_tickets`). Agora: query direta em `hubspot_tickets`, trazendo `owner_name`/`owner_email`/`pipeline_stage_name`/`pipeline_type`/`status_ticket` de graça. Fallback HubSpot API (linhas 62-106) agora também persiste em `hubspot_tickets` via novo helper `upsertHubspotTicket` (mantém `upsertMentorado` por compat). Arquivos: [whatsapp-server/src/routes/hubspot.js:34-186](whatsapp-server/src/routes/hubspot.js:34), [whatsapp-server/src/services/hubspot-api.js](whatsapp-server/src/services/hubspot-api.js).
>
> Resposta do `/resolve-tickets` ganhou os campos: `ticket_owner`, `ticket_owner_email`, `pipeline_stage_name`, `pipeline_type`, `status_ticket`. Smoke-test em produção com ticket 44167704933: `{ticket_owner: "Suporte CX", tier: "pro" (string), source: "hubspot_tickets"}`.
>
> ### 2) Fix duplicação do mentor no preview + edição inline do título
> Bug: [grupos.html:2375](grupos.html:2375) fazia `groupName = ticket_name + " | " + mentor`, mas `ticket_name` no HubSpot já vem formatado `"{cliente} | {mentor}"`, resultando em `"Luiz Afonso | Thiago Rocha | Rodrigo Zangirolimo"`. Fix: extrai só o cliente (split no primeiro `|`) e concatena com `r.ticket_owner` (fallback `r.mentor` se backfill incompleto). Resultado: `"Luiz Afonso | Suporte CX"` (2 partes).
>
> Título editável inline: `<div contenteditable="true">` no row expandido do preview. `onblur`/Enter salva; Escape cancela. Atualiza `_hubspotResolved[i].finalGroupName` + `_createSpecs[i].name` + recalcula `specHash` via `sha1Hex`. Flag `_editedName` preserva edição entre re-renders (toggle helpers, etc). CSS em `.editable-title` com borda tracejada no hover/focus.
>
> ### 3) Novo modal "🤖 Auto-criar grupos" (mentorados pendentes)
> Botão novo na toolbar. Abre modal que:
> - Chama `GET /api/hubspot/pending-groups[?tier=&pipeline_type=]` — retorna tickets com `tier` preenchido que NÃO têm row em `wa_group_creations` com `status='created'`, agrupados por `owner_name` (proprietário do ticket) com auto-map da sessão conectada via label → `wa_sessions`.
> - Renderiza accordion `<details>` por mentor: header com badge contagem + indicador de sessão (✓/✗); corpo com tabela de tickets (checkbox por ticket, cliente, tier, telefone, pipeline stage, data), welcome e rejectDm editáveis POR mentor (template default = `HUBSPOT_WELCOME_TEMPLATE`/`HUBSPOT_REJECT_DM_TEMPLATE`), botão "▶ Iniciar só {mentor}".
> - Footer: contador de seleção + "▶ Iniciar todos selecionados" que dispara N POSTs paralelos ao `/api/jobs/create-groups/start` (um por mentor, via `Promise.all`). Cada mentor vira 1 job independente — jobs rodam em paralelo porque cada um usa uma sessão distinta.
>
> Critério de "pendente": ticket tem `tier` + não tem row `status='created'` em `wa_group_creations`. Tickets com `failed`/`rate_limited`/`cancelled` voltam como pendentes (permite retry).
>
> Smoke-test em produção: `?tier=pro` retornou 484 pendentes em 15 owners (500 com tier, 16 já criados). Mentores com sessão conectada (Diego Giudice, Vinicius Holanda, Thomaz Stancioli) ficam ativáveis; "Financeiro Escalada" e "Suporte CX" aparecem mas desabilitados (sem sessão).
>
> ### 4) Nova aba "📊 Histórico" (Dashboard cross-session)
> Botão na toolbar alterna a view. Novo endpoint `GET /api/hubspot/group-history` (cross-session, mantém `/group-history/:sessionId` legado) com filtros: `from`, `to`, `mentor` (ilike), `tier`, `status`, `session_id`, `limit`, `offset`. Faz JOIN on-the-fly com `hubspot_tickets` pra trazer `owner_name` e `pipeline_stage_name` fresh; JOIN com `wa_sessions` pra label/phone da sessão criadora.
>
> Frontend: tabela cross-session com 11 colunas (Data, Grupo, Owner, Mentor, Tier, Pipeline, Sessão, Status, Membros, Link, Sincronizado). A coluna "Sincronizado" formata `hubspot_last_synced_at` como "há Xh / há N dias" via helper `formatRelativeTime`. Exportação CSV com BOM UTF-8 (Excel-friendly). Paginação por `offset` + "Carregar mais".
>
> Smoke-test: `limit=3` retornou rows com `ticket_owner_name`, `current_pipeline_stage` e `session_label` preenchidos. Grupos antigos (pré-deploy) mostram o nome duplicado histórico ("Guilherme... | Gustavo Netto | Gustavo Netto") — apenas grupos criados dalhi pra frente saem com nome limpo.
>
> ### Deploy (cuidadoso — 2ª tentativa resolveu conflito)
>
> 1ª tentativa falhou: `git pull` abortou porque 3 PNGs em `whatsapp-server/public/fotos/` eram untracked no Hetzner (viraram tracked no commit `5748550 chore(fotos): track tier avatars`). O `set -e` não pegou porque `git pull 2>&1 | tail -10` mascarou o exit code via pipe. PM2 reiniciou sobre código antigo. Sintoma: uptime voltou pra 3s mas nenhuma feature nova entrou.
>
> 2ª tentativa (sucesso): `set -eo pipefail` + backup em `/tmp/fotos-backup-<ts>/` + `rm public/fotos/{Pro,business,starter}.png` + pull limpo + restore package.json + sed CORS + `node --check` nos 3 arquivos + pm2 restart. Health 200, sessions reconectando.
>
> ### Arquivos críticos (próxima sessão retomar)
>
> - [whatsapp-server/src/routes/hubspot.js](whatsapp-server/src/routes/hubspot.js) — `/resolve-tickets` (34), `/pending-groups` (188), `/group-history` cross-session (278)
> - [whatsapp-server/src/services/hubspot-api.js](whatsapp-server/src/services/hubspot-api.js) — `fetchTicketFromApi` agora expõe owner_*; novo `upsertHubspotTicket`
> - [grupos.html](grupos.html) — toolbar (214-220), Auto-criar modal (~450), aba Histórico (~241), `buildSpecsFromHubspotResolved` fix do título (~2385), `onTitleEdit`/`onTitleKeydown` (~2495), `openAutoCreateModal`/`renderAutoCreateResults`/`startAutoCreateForMentor`/`startAutoCreateAllSelected` + helpers (~2770), `toggleHistoryView`/`loadHistoryRows`/`renderHistoryTableRows`/`exportHistoryCsv` (~2940)
>
> ### Rollback
>
> - Frontend: `git revert deb412c` + push → Vercel reverte em ~1min.
> - Backend: ssh + `git revert deb412c` + `pm2 restart ezap-whatsapp`.
> - Zero SQL pra reverter. A rota `/group-history/:sessionId` antiga continua intacta pro mini-panel, então rollback parcial (só do dashboard) também é seguro.
>
> ### Pontos em aberto / próximos naturais
>
> - Nome duplicado em grupos HISTÓRICOS (pré-deploy) fica visível no Dashboard. Se incomodar, script SQL `UPDATE wa_group_creations SET group_name = regexp_replace(group_name, ' \| (.+) \| \1$', ' | \1') WHERE ...` pode limpar.
> - Grupos já criados não têm `owner_name` denormalizado em `wa_group_creations` — o Dashboard faz JOIN on-the-fly toda vez. Se performance apertar, considerar coluna `hubspot_owner_name` + expandir o trigger `trg_sync_mentorados_to_group_creations` (hoje só lê de `mentorados`, não propaga owner).
> - Modal Auto-criar não tem preview visual (foto) por ticket — só número de membros. Se Dhiego quiser conferir foto antes de criar, adicionar thumb `/static/fotos/{tier}.png` na primeira coluna da tabela.
> - Sem smoke-test em fluxo completo de criação real pelo novo modal Auto-criar — o Dhiego pode rodar 1 lote de teste (ex: 1 mentor com 1 ticket selecionado) pra validar end-to-end antes de usar em escala.
>
> ---

> **Update 2026-04-20 noite — Fix 4 bugs pós-widget CALLS — DEPLOYED v2.0.39**
>
> Plano: [C:\Users\dhiee\.claude\plans\acredito-que-podemos-manter-gentle-tiger.md](C:\Users\dhiee\.claude\plans\acredito-que-podemos-manter-gentle-tiger.md)
>
> Correção de 4 regressões introduzidas no deploy do widget CALLS + guardas sistêmicos pra não repetir:
>
> 1. **CALLS sem feature flag** — widget aparecia pra todo usuário. Fix: gate `__ezapHasFeature("calls")` no `calls.js` (pattern igual ao `content.js:2031`), entrada em `__ezapDefaultButtonConfig` e em `admin.html > ALL_FEATURES`.
> 2. **Sidebar persistia após token revogado** — policy em `silentRevalidate` só deslogava em `blocked=true`. Agora detecta também `token_inactive=true` (flag adicionada em `background.js:90` quando RPC retorna array vazio com HTTP 200 — determinístico, não transiente). Mostra overlay + esconde rail de botões + fecha sidebars abertas.
> 3. **Botão "Sair" não funcionava na tela BLOQUEADO** — root cause: `onclick="window.__wcrmLogout()"` inline é parseado no *main world* da página WhatsApp, que NÃO enxerga funções do content_script (*isolated world*). Fix: DOM construído programaticamente com `addEventListener` no botão.
> 4. **Admin perdeu "Reset" por token** — a RPC antiga `reset_user_device` limpa `users.*` mas a migração pra `user_tokens` deixou a RPC órfã. Fix: nova RPC `reset_token_device(p_token_id)` + update em `reset_user_device` pra também limpar `user_tokens`. Botão "Resetar" agora aparece em cada card de token no admin (só se `token_redeemed=true`).
>
> ### Guardas sistêmicos pra não repetir
>
> - Comentário **CHECKLIST** no topo de `sidebar-manager.js` listando os 5 pontos que precisam ser atualizados ao adicionar feature nova (arquivo da feature + `__ezapDefaultButtonConfig` + `_tabIcons`/`_tabLabels`/etc + `manifest.json` + `ALL_FEATURES` no admin).
> - Comentário de aviso em `admin.html > ALL_FEATURES` apontando pros 3 pontos correlatos.
> - Comentário acima de `showPhoneBlockOverlay` em `auth.js` proibindo `onclick=` inline em content_script (causa do Bug 3).
>
> ### Mudanças técnicas
>
> - **Migration 060** (`supabase/migration_060_reset_token_device.sql`): RPC `reset_token_device(p_token_id)` + update `reset_user_device` pra incluir `user_tokens`. Aplicada via Management API.
> - **chrome-extension/background.js:90**: adicionado `token_inactive: true` quando `validate_token` retorna empty.
> - **chrome-extension/auth.js**: `silentRevalidate` detecta `token_inactive`; `showPhoneBlockOverlay` usa `addEventListener` + esconde `ezap-float-container`; `__ezapDefaultButtonConfig` +calls; CHECKLIST acima.
> - **chrome-extension/calls.js**: gate `__ezapHasFeature("calls")` no init.
> - **chrome-extension/sidebar-manager.js**: CHECKLIST no header (sem mudança funcional).
> - **admin.html**: `ALL_FEATURES` +`calls`; `loadUserTokens` render +`resetBtn` (só se `token_redeemed`); `resetTokenDevice(tokenId, userId)` handler chama RPC e re-renderiza.
>
> ### Verificação pós-deploy
>
> 1. Admin painel → ABA "Usuários" → expandir user → desativar token ativo → **esperar ≤2min** → user deve ver overlay "Acesso Bloqueado — Token desativado".
> 2. No overlay: clicar "Sair" → `chrome.storage` limpa → tela de login aparece (antes não rodava).
> 3. Admin re-ativa token + clica "Resetar" (ícone circular warning ao lado de "Desativar") → token volta pra "Não resgatado" → user pode logar em qualquer máquina com mesmo código.
> 4. Pra user comum sem "calls" em `features`: botão CALLS não aparece no rail direito. Admin ativa checkbox CALLS → próxima revalidação (2min) ou F5 → botão aparece.
>
> ### Extensão atualizada
> - ZIP `ezap-v2.0.39.zip` no Supabase Storage `releases/`
> - `release.json` com notes + `notify:false`
> - Usuários recebem via `ezap-update` (Windows PowerShell ou Mac .command)

---

> **Update 2026-04-20 tarde — Widget CALLS no sidebar direito (HOJE/AMANHÃ/SEMANA) — DEPLOYED v2.0.38**
>
> Plano: [C:\Users\dhiee\.claude\plans\acredito-que-podemos-manter-gentle-tiger.md](C:\Users\dhiee\.claude\plans\acredito-que-podemos-manter-gentle-tiger.md)
>
> Continuação da feature CALLS DE HOJE. Agora o mentor tem visibilidade futura: novo ícone CALLS no sidebar direito abre widget com 3 seções accordion (HOJE expandido, AMANHÃ e SEMANA colapsados). Cada linha mostra horário + nome do grupo/contato + título da meeting. Click abre o chat via `ezapOpenChat`. Ícone 🎥 continua aparecendo **apenas** nas calls de hoje (inalterado).
>
> ### Mudanças técnicas
> - **Migration 059** — nova tabela `calls_events` (meeting_id, phone, start_time, end_time, title, primary_jid, jid_type, contact_name, owner_id). UNIQUE (meeting_id, phone). Índices em start_time/phone/primary_jid.
> - **whatsapp-server (Hetzner)**:
>   - `hubspot-api.js`: `searchMeetingsByDateRange` agora também busca `hs_meeting_end_time`
>   - `supabase.js`: +3 helpers — `classifyJid` (sufixo→tipo), `pickPrimaryJid` (prioridade group>dm>lid), `fetchChatNamesBatch` (wa_chats→group_members→wa_contacts em fallback)
>   - `routes/hubspot.js`: +`POST /api/hubspot/calls-week/refresh?days=N&date=YYYY-MM-DD` (upsert + delete stale) e +`GET /api/hubspot/calls?from=&to=` (lê calls_events ordenado)
>   - `index.js`: cron `'1 0 * * *'` agora chama sequencialmente calls-today/refresh + calls-week/refresh
> - **chrome-extension**:
>   - `calls.js` (NOVO, ~280 linhas) — widget CALLS: button com SVG videocam, sidebar com accordion, lê `calls_events` via `window.ezapSupaRest` direto (sem proxy), cache 30s, click chama `window.ezapOpenChat`
>   - `sidebar-manager.js`: registrou `calls` em _tabIcons / _tabLabels / _tabFeatures / tabOrder / sidebarIds / _buttonMap
>   - `manifest.json`: +`calls.js` em content_scripts, versão 2.0.38
>   - `sidebar.css`: +bloco com `.calls-section`, `.calls-item`, `.calls-week-day-label` com suporte a dark/light
> - **admin.html**: +botão "📅 Atualizar CALLS DA SEMANA" ao lado do de HOJE, chama `/calls-week/refresh` via waFetch
>
> ### Smoke test pós-deploy (20/04 tarde)
> - `POST /calls-week/refresh` retornou `{meetings_count: 367, events_count: 56, deleted_count: 0}` — 56 pairs (meeting,phone) com telefone válido dos próximos 7 dias
> - `GET /calls` (Bearer) retorna array ordenado por start_time, com contact_name resolvido em wa_chats/wa_contacts/group_members
> - `pm2 restart ezap-whatsapp` ok, health 200
>
> ### Arquitetura decidida
> - Widget lê direto do Supabase via REST (não precisa proxy pelo whatsapp-server). Bearer só pro refresh manual do admin.
> - Mudança de horário/cancelamento no HubSpot → reflete no próximo cron 00:01 ou botão manual no admin. Não implementado cron mid-day ainda (pra não estourar HS rate limit).
> - Prioridade de chat ao clicar: grupo > DM > LID (faz sentido pro modelo de mentoria com grupos).
>
> ### Próximos passos naturais (com calls_events em produção)
> - Tooltip no ícone 🎥 mostrando "14:00 — João" (hover lê calls_events por jid)
> - Badge countdown "call em 23min" no header do chat
> - "CALLS DE ONTEM" (follow-up) usando last_seen_at preservado

---

> **Update 2026-04-20 — ABA Admin "CALLS DE HOJE" auto-populada via cron HubSpot — DEPLOYED v2.0.37**
>
> Sessão grande (~17/04 a 20/04). Estado atual em produção:
>
> ### Estado da extensão
> - **Versão**: `2.0.37` (deploy v2.0.36 → v2.0.37 hoje)
> - **Distribuição**: `C:\ezap-ext` via `scripts/install-ezap.ps1` ou `scripts/E-ZAP-Instalar.bat` (duplo clique). Comando global `ezap-update` no PowerShell.
>
> ### Features grandes deployadas (cronológico)
>
> **17-18/04 — Admin ABAS + Templates Compartilhados** (v2.0.5 → v2.0.20)
> - Migration 051: tabelas `shared_templates`, `admin_abas`, `admin_aba_contacts`
> - Migration 052: `admin_abas.visible_to TEXT[]` (filtro por usuário)
> - Migration 053: `admin_abas.icon TEXT` (emoji por aba — 20 opções)
> - Templates compartilhados: admin cria multi-mensagem + arquivos no admin → todos veem em "Templates Compartilhados" no MSG sidebar
> - ABAS Admin com seção dedicada "ABAS Compartilhadas" no sidebar, ícone no lugar do dot quando definido
> - **Root-cause fix**: `supa()` em admin.html aceita 2 assinaturas (era chamado com 4 args mas definido com 2 → tudo falhava silenciosamente)
>
> **18-19/04 — Critérios de vínculo automático nas ABAS Admin** (v2.0.26 → v2.0.32)
> - Migration 054: `admin_abas.criteria TEXT[]` (admin cola JID/telefone/wa.me/HubSpot link)
> - Migration 055: `admin_abas.resolved_phones TEXT[]` (telefones resolvidos do HubSpot)
> - Migration 056: `admin_abas.resolved_jids TEXT[]` (JIDs completos: pessoal + LID + grupos)
> - Pipeline ao salvar aba: HubSpot ticket ID → telefone (via `/api/hubspot/resolve-tickets` que popula `mentorados`) → expande em todos JIDs (chats individuais + LIDs + grupos onde a pessoa é membro)
> - Tratamento "9 extra" BR (5511XXXXXXXXX vs 551XXXXXXXX) em `expandPhonesToJids`
> - Matcher na extensão usa `resolved_jids` (match direto JID-por-JID)
> - Filtro do overlay e contador deduplicado por nome do chat
>
> **19-20/04 — Distribuição da extensão** (v2.0.32 → v2.0.36)
> - `scripts/install-ezap.ps1` — baixa última release, extrai em `C:\ezap-ext`, abre Chrome direto no perfil correto (lê `Local State.profile.last_used`), usa `--new-window` pra forçar `chrome://extensions`
> - `scripts/E-ZAP-Instalar.bat` — duplo clique pros usuários (chama PowerShell com `-ExecutionPolicy Bypass`)
> - WebClient.DownloadFile() para download 3-5x mais rápido que Invoke-WebRequest
> - Comando global `ezap-update` configurado via PowerShell `$PROFILE` (snippet no scripts/README.md)
>
> **20/04 — ABA "CALLS DE HOJE" via cron HubSpot** (v2.0.37 + whatsapp-server) ⭐ FEATURE NOVA
> - Migration 057: `INSERT INTO admin_abas` da row "CALLS DE HOJE" (icon 🎥, color #ef4444, position 0)
> - Migration 058: `admin_abas.resolved_phone_jids JSONB` (mapa `{phone: [jids]}` pra dedup por pessoa)
> - **whatsapp-server (Hetzner)**:
>   - Novo: `searchMeetingsByDateRange/getMeetingContactIds/getContactPhoneDigits` em `src/services/hubspot-api.js`
>   - Novo: `expandPhonesToJids(phones, {groupByPhone:true})` em `src/services/supabase.js` (port do `_expandPhonesToJids` do admin.html, retorna mapa por phone)
>   - Nova rota: `POST /api/hubspot/calls-today/refresh?date=YYYY-MM-DD` em `src/routes/hubspot.js` — busca meetings do dia, resolve contacts→phones→JIDs, popula `resolved_jids` + `resolved_phones` + `resolved_phone_jids`
>   - Cron `node-cron` em `src/index.js`: `'1 0 * * *'` America/Sao_Paulo → chama o endpoint via `fetch http://localhost:PORT` com Bearer ADMIN_TOKEN
>   - `package.json`: +`node-cron@^3.0.3`
> - **admin.html**: botão "🎥 Atualizar CALLS DE HOJE" na tab ABAS Admin (chama waFetch POST e mostra contagens via alert)
> - **chrome-extension/slice.js `_ezapCountAbaChats`**: dedup por PESSOA quando `resolved_phone_jids` existe — itera phones, conta 1 se algum JID dessa pessoa está visível em `chatIndex.byJid`. Fallback para dedup por nome quando sem mapa.
> - **chrome-extension/abas.js**: passa `resolved_phone_jids` para `_renderSingleAbaItem`
>
> ### Bug encontrado e corrigido durante dev
> - hsFetch já faz `JSON.stringify(opts.body)` internamente. O endpoint estava passando body já stringify-ado → HubSpot HTTP 400 "Cannot construct PublicObjectSearchRequest from String". Fix: passar body como objeto puro.
>
> ### Como testar a feature CALLS DE HOJE
> 1. Estado atual no banco: aba populada com 10 pessoas (24 JIDs) das reuniões de 20/04
> 2. Atualizar extensão: `ezap-update -OpenChrome` (vai pra v2.0.37)
> 3. Recarregar WhatsApp Web (F5)
> 4. Pill "🎥 CALLS DE HOJE" deve mostrar quantas pessoas únicas o mentor tem (ex: 2 = Isaac + Mateus, mesmo Mateus aparecendo em DM + grupo)
> 5. Clicar na pill filtra os chats com call do dia
> 6. Cron diário 00:01 BRT atualiza sozinho
> 7. Botão "🎥 Atualizar CALLS DE HOJE" no admin pra forçar mid-day
>
> ### Pendência conhecida
> - Aviso de segurança Windows SmartScreen ao baixar `.bat` (normal, requer "Mais informações" → "Executar mesmo assim"). Code-signing custaria ~$200/ano — não priorizado.
>
> ### Documentação criada
> - `scripts/README.md` — guia de uso dos installers
> - `EZAP_PLANO_MELHORIAS.md` (raiz) — plano completo das fases 1-8
> - Vault Obsidian em `C:\Users\dhiee\OneDrive\Documentos\DHIEGO.AI VAULT\DHIEGO.AI\Projetos\E-ZAP EXT Update\` com 5 docs (sobre, instalação, credenciais, mudanças, deploy) + anexos (.bat, .ps1, plano)
>
> ---

> **Update 2026-04-16 — DHIEGO.AI vira assistente LLM-first com tools externas (HubSpot + Google Calendar + Gmail + Supabase) — DEPLOYED**
>
> Duas rodadas de trabalho em cima do bot DHIEGO.AI, partindo do estado documentado em [DHIEGO_AI_HANDOFF.md](DHIEGO_AI_HANDOFF.md) — onde o bot era "intent-router-first" (regex classificava antes de qualquer coisa) e só sabia gerenciar ideias. Pedido do Dhiego: experiência de conversar com o Claude.ai, natural, com áudio e texto, podendo consultar qualquer sistema dele.
>
> ### Round 1 — Arquitetura LLM-first agentic (P0+P1+P2+P5 do plano)
>
> Plano completo em [C:\Users\dhiee\.claude\plans\scalable-orbiting-moler.md](C:\Users\dhiee\.claude\plans\scalable-orbiting-moler.md).
>
> **Novo fluxo em produção**:
> ```
> mensagem WA → baileys → dhiego-ai.maybeHandle
>   ├─ extractTextOrTranscribe (áudio Whisper já funcionava)
>   ├─ loadRecentEntries(12) + loadState
>   ├─ if cfg.mode === "agent":
>   │    router.routeIntent só como pre-hint (não gatekeeper)
>   │    runAgent(...) — loop Claude tool_use até 6 iterações
>   │      Claude decide: end_turn (texto) ou tool_use (ferramenta)
>   │    synthesizeIntentForState (mantém compat com state.syncStateAfterTurn)
>   └─ else: dispatch legado (rollback path)
> ```
>
> Criados:
> - [whatsapp-server/src/services/dhiego-ai/tool-schemas.js](whatsapp-server/src/services/dhiego-ai/tool-schemas.js) — 9 tools Anthropic (create/list/show/latest/update/complete/cancel/delete_idea + generate_ideas_pdf) + TOOL_DISPATCH + mapToolNameToLegacyIntent
> - [whatsapp-server/src/services/dhiego-ai/prompt-builder.js](whatsapp-server/src/services/dhiego-ai/prompt-builder.js) — monta system prompt dinâmico por turno: base + contexto do sistema (data/hora, timezone, nome) + tools policy + contexto ativo + modo literal
> - [whatsapp-server/src/services/dhiego-ai/agent.js](whatsapp-server/src/services/dhiego-ai/agent.js) — loop agentic (MAX_ITERATIONS=6, maxTokens=2048), serializer capado em 4KB/tool_result, salvaguarda de modo literal (restaura texto original se Claude truncou com `preserve_literal=true`)
>
> Modificados:
> - [whatsapp-server/src/services/dhiego-ai/llm.js](whatsapp-server/src/services/dhiego-ai/llm.js) — `complete()` aceita `tools`/`toolChoice`, retorna `content`+`stopReason` (backwards compat: `text` preservado)
> - [whatsapp-server/src/services/dhiego-ai.js:246](whatsapp-server/src/services/dhiego-ai.js:246) — ramifica por `cfg.mode`, ctx ganha `lastUserText`. **Fix do áudio**: `extractTextOrTranscribe` agora faz `unwrapMessage()` antes de checar `audioMessage`, e também checa `pttMessage`. Antes alguns voice notes wrappeds em `deviceSentMessage` eram ignorados.
> - [whatsapp-server/src/services/dhiego-ai/config.js](whatsapp-server/src/services/dhiego-ai/config.js) — nova key `dhiego_ai_mode` em app_settings (default `agent`, `router` força legado)
> - [whatsapp-server/src/services/dhiego-ai/tools/ideas.js:212](whatsapp-server/src/services/dhiego-ai/tools/ideas.js:212) — `updateIdea` aceita `preserveLiteral`, grava sem `.trim()` quando true
>
> Melhorias no system prompt (várias iterações durante testes reais):
> - Bloco "Contexto do sistema (agora)" com data/hora atual em America/Sao_Paulo via `Intl.DateTimeFormat`, país, nome do Dhiego — Claude antes dizia "não sei qual mês você fala" em "esse mês tem feriado?"
> - Instrução explícita de que áudios SÃO transcritos pelo Whisper — Claude antes dizia "não consigo ouvir áudios"
> - Instrução de conhecimento geral: "Você sabe feriados, datas, cultura, etc. Não se esconda atrás de 'não tenho acesso' a menos que precise de dado em tempo real"
>
> ### Round 2 — Tools externas via `call_api`
>
> Mesma sessão. Quando testou "qual meu faturamento hoje no HubSpot?" o bot respondeu "só consigo gerenciar ideias". A LLM é capaz, o kit de tools é que era limitado.
>
> Arquitetura: uma tool genérica `call_api` com SERVICE_REGISTRY. Claude já conhece as APIs de treino — monta o path certo. Adicionar serviço = 1 entrada no registry.
>
> Criados:
> - [whatsapp-server/src/services/dhiego-ai/tools/call-api.js](whatsapp-server/src/services/dhiego-ai/tools/call-api.js) — tool genérica com SERVICE_REGISTRY: **hubspot** (bearer token de app_settings.hubspot_api_key), **supabase** (service_key do env), **google_calendar** + **gmail** (ambos com `requiresImpersonation: true`). Timeout 15s, response truncado 6000 chars. Strip de `as_user` antes de forwardar pra Google (query param custom do bot).
> - [whatsapp-server/src/services/dhiego-ai/tools/google-auth.js](whatsapp-server/src/services/dhiego-ai/tools/google-auth.js) — gerencia OAuth2: lê refresh_token de app_settings, troca por access_token no `oauth2.googleapis.com/token`, cacheia 50min in-process. `getAccessToken(email)`, `listAuthorizedEmails()`, `clearAccessCache()`.
> - [whatsapp-server/src/routes/google-oauth.js](whatsapp-server/src/routes/google-oauth.js) — rotas PÚBLICAS (sem `requireAuth` — OAuth callback do Google precisa ser acessível): `GET /api/google/auth?email=...` → redirect pro consent; `GET /api/google/callback` → troca code por tokens, persiste `google_refresh_token_<email>`; `GET /api/google/status` → lista contas autorizadas.
>
> Modificados:
> - [whatsapp-server/src/services/dhiego-ai/tool-schemas.js](whatsapp-server/src/services/dhiego-ai/tool-schemas.js) — +schema `call_api` (10 tools total) com exemplos em PT de HubSpot/Calendar/Gmail/Supabase
> - [whatsapp-server/src/services/dhiego-ai/prompt-builder.js](whatsapp-server/src/services/dhiego-ai/prompt-builder.js) — TOOLS_POLICY expandida listando os 4 serviços, com seção dedicada ao Google Calendar incluindo CRUD completo (list/create/update/delete com bodies corretos), regra de pedir confirmação antes de criar/editar/deletar eventos
> - [whatsapp-server/src/services/dhiego-ai/tools/ideas-pdf.js](whatsapp-server/src/services/dhiego-ai/tools/ideas-pdf.js) — `pdfkit` lazy-required (permite smoke offline)
> - [whatsapp-server/src/index.js](whatsapp-server/src/index.js) — monta `/api/google` sem middleware auth
> - `package.json` — `googleapis` adicionado
>
> **Setup Google Cloud Console + Workspace** (feito via Chrome MCP):
> 1. Projeto `DHIEGO-AI` (id `dhiego-ai-493518`) na org `grupoescalada.com.br` — conta de faturamento "Minha conta de faturamento"
> 2. APIs ativadas: Google Calendar API + Gmail API
> 3. Service Account `dhiego-ai-bot@dhiego-ai-493518.iam.gserviceaccount.com` criada (unique ID `100607864051075425188`) — **descartada** porque a org policy `iam.disableServiceAccountKeyCreation` bloqueia criação de chaves JSON e o Dhiego não tem role `orgpolicy.policyAdmin` pra desbloquear
> 4. Pivot pra **OAuth2 user-based**: criado OAuth Client "Aplicativo da Web" `DHIEGO-AI-Bot`:
>    - Client ID: `529816900261-7a2itqdcguta6g60eblpf1c32i3iph2k.apps.googleusercontent.com`
>    - Client Secret: em `app_settings.google_oauth_client_secret`
>    - Tela de consentimento: tipo "Interno" (só contas @grupoescalada.com.br, sem verificação Google)
>    - Redirect URI: `http://localhost:3100/api/google/callback` — Google rejeita HTTP em IP público; usamos SSH tunnel `ssh -L 3100:localhost:3100` pra conectar via localhost durante autorização
>    - Escopos: `calendar`, `calendar.events`, `gmail.readonly`
> 5. Dhiego autorizou `dhiego@grupoescalada.com.br` e `tools@grupoescalada.com.br` via fluxo OAuth
> 6. refresh_tokens salvos em `app_settings.google_refresh_token_<email>`
>
> **Novas keys em `app_settings`**:
> - `dhiego_ai_mode` = `agent` (feature flag do Round 1)
> - `google_oauth_client_id`, `google_oauth_client_secret`
> - `google_refresh_token_dhiego@grupoescalada.com.br`, `google_refresh_token_tools@grupoescalada.com.br`
> - `google_access_token_*` (cache temporário, TTL 60min)
>
> **Evidência de produção — testes end-to-end**:
>
> ```
> Teste 1: "oi, tudo bem? me diz em uma frase o que você faz"
> → stopReason=end_turn, tools=[], 2.5s, 2289/60 tokens
> → "Oi! Tudo bem 😊 Sou seu assistente pessoal de ideias..."
>
> Teste 2: "Anota aqui pra mim: revisar fluxo de onboarding EscaladaHub antes de sexta"
> → tools=[create_idea], 3.2s, 4940/115 tokens
> → Ideia #3 salva no banco + reply "Anotado! ✅ Ideia #3 salva..."
>
> Teste 3: "esse mês aqui tem feriado?" (após fix de contexto do sistema)
> → tools=[], 2.1s, 2460/54 tokens
> → "Em abril de 2026, tem sim: 21 de abril (terça) — Tiradentes 🇧🇷. Feriado nacional."
>
> Teste 4: "quais reuniões eu tenho hoje?"
> → tools=[call_api(google_calendar)], 5.6s, 9134/313 tokens
> → Google API 200 OK → "Hoje você tem 1 reunião: 📅 Mercado Livre & Escalada Mentoria 14-14:45..."
>
> Teste 5 (WhatsApp real, Dhiego): "quais reuniões eu tenho essa semana?"
> → tools=[call_api, call_api], 18295/453 tokens
> → Lista completa da semana entregue no celular dele
> ```
>
> **Capacidades novas em produção**:
> - Conversa natural via texto + áudio (Whisper PT)
> - Backlog de ideias: criar, listar, atualizar, concluir, cancelar, deletar, PDF
> - Modo literal (atualiza bloco de texto byte-a-byte quando pedido)
> - HubSpot: faturamento, deals, contatos, pipelines
> - Google Calendar: listar/criar/editar/deletar eventos (com Meet), em dhiego@ e tools@
> - Gmail: ler emails, buscar por query em dhiego@ e tools@
> - Supabase: qualquer tabela via REST
> - Combinação de tools na mesma turn
>
> **Rollback**:
> - Agent global: flipar `app_settings.dhiego_ai_mode` pra `router` (caminho legado intacto no código)
> - Serviços externos: remover do SERVICE_REGISTRY em [call-api.js](whatsapp-server/src/services/dhiego-ai/tools/call-api.js) e redeploy
> - OAuth Google: `DELETE FROM app_settings WHERE key LIKE 'google_%'`, e revogar em https://myaccount.google.com/permissions → "DHIEGO.AI" pra cada conta
>
> **Como autorizar NOVAS contas Google no futuro**:
> 1. Abrir túnel SSH: `ssh -i ~/.ssh/ezap_hetzner -L 3100:localhost:3100 -fN root@87.99.141.235`
> 2. Navegar em Chrome logado na conta: `http://localhost:3100/api/google/auth?email=<novo>@grupoescalada.com.br`
> 3. Aceitar consent — refresh_token salvo automaticamente, bot já pode usar na próxima msg
>
> **Limitações / decisões**:
> - Service Account descartada por org policy; OAuth2 user-based exige fluxo de consent por conta
> - Google exige HTTPS ou localhost → SSH tunnel no momento da autorização
> - Prompt com schemas + exemplos = 9k-18k input tokens/turn. Sonnet 4.6 lida bem mas poderia baixar pra Haiku 4.5 se apertar o custo (flip em `app_settings.dhiego_ai_llm_model`)
> - Áudio precisou de 2 fixes: unwrap de `deviceSentMessage` + prompt explicando que Whisper transcreve (Claude antes dizia "não ouço áudios")
>
> **Arquivos críticos pra próxima sessão**:
> 1. [whatsapp-server/src/services/dhiego-ai/agent.js](whatsapp-server/src/services/dhiego-ai/agent.js) — coração do LLM-first
> 2. [whatsapp-server/src/services/dhiego-ai/tool-schemas.js](whatsapp-server/src/services/dhiego-ai/tool-schemas.js) — onde adicionar tools novas
> 3. [whatsapp-server/src/services/dhiego-ai/tools/call-api.js](whatsapp-server/src/services/dhiego-ai/tools/call-api.js) — SERVICE_REGISTRY pra novos serviços externos
> 4. [whatsapp-server/src/services/dhiego-ai/prompt-builder.js](whatsapp-server/src/services/dhiego-ai/prompt-builder.js) — onde Round 3 (rules/facts admin) vai plugar
> 5. [C:\Users\dhiee\.claude\plans\scalable-orbiting-moler.md](C:\Users\dhiee\.claude\plans\scalable-orbiting-moler.md) — P3/P4/P7 documentados como roadmap
>
> **Pendente para Round 3** (não implementado):
> - P3: tabela `dhiego_ai_rules` + admin UI pra editar regras por tópico (faturamento, relatórios, estilo)
> - P4: tabela `dhiego_ai_facts` + tool `remember_fact`/`recall_fact` — memória persistente que o LLM escreve e o Dhiego edita
> - P7: coluna `dhiego_conversations.trace` JSONB + viewer no admin.html pra ver quais tools foram chamadas por turno
>
> **Pendência de commit**: todos os arquivos estão deployados no VPS mas ainda não comitados no git local. Próximo passo = `git add` + commit + `git push origin main`. Dhiego não pediu o commit ainda.

---

> **Update 2026-04-15 madrugada-2 — Criar grupos via links de ticket HubSpot — DEPLOYED**
>
> Commit: `4af06c5` — `feat(hubspot): create groups from ticket links resolving against mentorados table` (3 files, +416/−9). PID 119201 no Hetzner, health ok, endpoint `/api/hubspot/resolve-tickets` validado em produção com 4 tickets reais (Lucas/Daniel/Paulo resolvidos + fake caiu em notFound).
>
> **Contexto**: o fluxo de criação em massa dependia de uma planilha XLSX preenchida manualmente com dados que já vivem na HubSpot. O Dhiego cansou disso e pediu pra colar só os URLs dos tickets e deixar o sistema montar os grupos automaticamente.
>
> **Descoberta que desbloqueou tudo**: já existe uma Edge Function `supabase/functions/hubspot-tickets/index.ts` que recebe webhooks HubSpot e popula a tabela `mentorados` com `ticket_id`, `ticket_name`, `mentor_responsavel`, `whatsapp_do_mentorado`, e 3 booleans (`mentoria_starter/pro/business`) derivados do line item "Mentoria Meli PRO/Business/Starter" associado ao ticket. Ou seja, **zero chamadas à HubSpot API** — é só ler do Supabase local. Confirmei em produção: a tabela está populada, ticket 44167704933 do Lucas tá lá com mentor Rodrigo Zangirolimo.
>
> **Descoberta que simplificou a bridge**: os labels de `wa_sessions` batem **exatamente** com `mentor_responsavel` ("Rodrigo Zangirolimo", "Eduardo Gossi", "Nicollas Portela", etc). Match por label lowercased direto, sem nova coluna, sem nova tabela de mapping.
>
> **Entregue**:
>
> Backend — [whatsapp-server/src/routes/hubspot.js](whatsapp-server/src/routes/hubspot.js) **(NOVO)**:
> - `POST /api/hubspot/resolve-tickets { ticketIds: number[] }` → retorna `{ resolved: [...], notFound: [...] }`. Cada resolved tem: `ticket_id`, `ticket_name`, `mentor`, `whatsapp`, `tier: "pro"|"business"|"starter"|null`, `mentorSessionId`, `mentorSessionPhone`, `warning: null|"mentor_sem_sessao_conectada"|"sem_tier_definido"`.
> - Lê `mentorados` com `ticket_id=in.(...)` + `wa_sessions?status=eq.connected` em paralelo. Label → session map em memória. Zero IQ no socket Baileys.
> - Cap de 200 tickets por chamada; dedup automático dos inputs.
> - Mounted em [index.js linha 51](whatsapp-server/src/index.js:51) junto com os outros routes protegidos.
>
> Frontend — [grupos.html](grupos.html):
> - Novo radio **"🎫 Tickets HubSpot"** na seção "Fonte dos dados" do modal Criar Grupos, **default** (XLSX/CSV/Sheets ficaram como tabs alternativas).
> - `#createHubspotBox`: textarea pra colar URLs ou IDs misturados + botão "🔍 Resolver tickets" + span `#hubspotResolveStatus` que mostra "X OK · Y com aviso · Z não encontrados".
> - `#helperSessionsBox`: checklist de sessões conectadas que entram como membros em TODOS os grupos do lote (ex: CX2). Toggle de checkbox recalcula o preview live via `onHelperChecklistChange`.
> - Novo preview `renderHubspotPreview` com colunas: `#` (ticket_id) | Cliente | Mentor | Tier (badge Pro/Business/Starter) | Foto (thumbnail dos PNGs do `/static/fotos/`) | Membros | Status (🟢 OK / 🟡 warning / 🔴 bloqueado). Linhas bloqueadas ficam `opacity:0.55` e não entram no `_createSpecs`.
> - Normalização de telefones BR em `normalizePhoneBr`: aceita `"+5519991947021"`, `"(11) 99740-2370"`, `"5519 99002-4413"`. Prefixa DDI 55 quando ausente, rejeita qualquer coisa fora de 12-13 dígitos finais.
> - `parseHubspotTicketInput` extrai `ticket_id` via regex `/\/record\/0-5\/(\d+)/` ou aceita número puro.
> - `buildSpecsFromHubspotResolved` monta cada spec: `name: "{ticket_name} | {mentor}"`, `description: "[{ticket_id}]"`, `photoUrl: "/static/fotos/{Pro|business|starter}.png"`, `members: [client, mentor, ...helpers]` deduplicados, `lockInfo: true`, `welcomeMessage:` template fixo da Escalada. Usa o mesmo `sha1Hex` do fluxo xlsx pro `specHash`, o mesmo pipeline `_createSpecs` e `submitCreateGroupsJob` sem modificação.
> - `toggleCreateSourceMode` agora limpa `_createSpecs`, `_hubspotResolved`, preview, e status ao trocar de tab — evita preview stale do fluxo anterior.
>
> **Zero mudanças** em: `createGroupsFromList`, `applyCriticalSessionOverrides`, quarentena, `waitForGroupCreateBudget`, `runCreateGroupsWorker`. O spec gerado pelo fluxo HubSpot tem o mesmo shape do gerado pelo xlsx, então toda a proteção de rate-limit continua valendo (overrides da Escalada, quarentena, hourly cap, etc).
>
> **Smoke test em produção** (curl real, não mock):
> ```
> POST /api/hubspot/resolve-tickets { "ticketIds":[44167704933,44391166513,44384218675,99999999999] }
> → resolved:
>   · Lucas Gabriel da Silva Pacheco | Rodrigo Zangirolimo → session 4b856129... phone 5519990024413, tier=pro ✓
>   · Daniel Antunes Correia | Eduardo Gossi → session 5eab18d2... phone 5519992642608, tier=pro ✓
>   · Paulo | Rodrigo Zangirolimo → session 4b856129... phone 5519990024413, tier=starter ✓
> → notFound: [99999999999] ✓
> ```
>
> **Fluxo que o Dhiego usa agora**:
> 1. Abre "+ Criar grupos" → modal já abre na tab HubSpot (default)
> 2. Cola N URLs de ticket (1 por linha), clica "🔍 Resolver tickets"
> 3. Preview popula com cliente/mentor/tier/foto/status pra conferência
> 4. Marca no checklist quais sessões "helper" entram em todos (ex: CX2)
> 5. Escolhe a sessão criadora no dropdown (qualquer conectada)
> 6. Clica "Iniciar criação" → job roda o fluxo normal, protegido por quarentena + overrides críticos
>
> **Pontos deixados pra depois (fora do escopo deste round)**:
> - Distribuição automática entre mentores (1 job por mentor em paralelo) — Dhiego preferiu manter 1 sessão criadora por lote no modelo atual
> - Template editável de welcome message — hardcoded por enquanto
> - Edição inline das linhas do preview — view-only, pra editar ajusta no HubSpot e re-resolve
> - Fallback direto pra HubSpot API quando um ticket não está em `mentorados` — warning só, user dispara manualmente
>
> **Deploy cuidadoso** (preservou overlays do DHIEGO.AI Round 1 Agentic que estavam pendentes no Hetzner de outra sessão):
> - Backup manual dos 9 arquivos DHIEGO.AI em `/tmp/hetzner-backup-<ts>/` antes do pull
> - `git checkout --` nos arquivos dirty, `git pull`, restore dos backups por cima
> - Re-aplicação do `sed CORS` (o pull resetou pra `app.use(cors())` sem argumento)
> - Syntax check em `src/routes/hubspot.js` e `src/index.js` antes do `pm2 restart`
> - Os arquivos untracked do Round 1 (`agent.js`, `prompt-builder.js`, `tool-schemas.js`) não foram tocados, `data/` e `public/` preservados
>
> **Rollback**: o commit `4af06c5` toca só 3 arquivos (2 modificados, 1 novo). `git revert 4af06c5` desfaz tudo sem afetar o Round 1 Agentic. Ou no runtime: desmount `/api/hubspot` no `src/index.js` + remover a tab do `grupos.html` — o XLSX fallback continua funcional.
>
> **Arquivos críticos** (para próxima sessão retomar):
> - [whatsapp-server/src/routes/hubspot.js](whatsapp-server/src/routes/hubspot.js) — rota de resolve
> - [grupos.html](grupos.html) — modal (306-380), `buildSpecsFromHubspotResolved` (~1880-2000), `renderHubspotPreview` (~2010-2070), `renderHelperSessionsChecklist` (~1710), `toggleCreateSourceMode` (~1720), `openCreateGroupsModal` (~1690)
> - [supabase/migration_035_mentorados.sql](supabase/migration_035_mentorados.sql) — schema da tabela bridge
> - [supabase/functions/hubspot-tickets/index.ts](supabase/functions/hubspot-tickets/index.ts) — Edge Function que popula `mentorados` via webhook
>
> **Roadmap natural de evolução** (quando for relevante):
> 1. Tentar direto HubSpot API quando um ticket não está em `mentorados` (usando `hubspot_api_key` já salva em `app_settings`)
> 2. 1 job por mentor em paralelo (distribuição automática — reduziria ainda mais risco de rate-limit na Escalada)
> 3. Configuração de welcome message no admin.html
> 4. Dedupe automático na UI: pre-avisar "este ticket já foi usado em um lote anterior" lendo `wa_group_creations` pelo `spec_hash`

---

> **Update 2026-04-15 noite — DHIEGO.AI LLM-first Agentic (Round 1 MVP) — DEPLOYED**
>
> O handoff [DHIEGO_AI_HANDOFF.md](DHIEGO_AI_HANDOFF.md) do fim da manhã documentou que o bot ainda "parecia bot" porque o `router.js` decidia intent via regex antes do LLM. O usuário pediu um plano LLM-first completo e o aprovou — escopo Round 1 = Fases 0+1+2+5 (sem rules/facts/trace ainda, que ficam pro Round 2). Plano em [C:\Users\dhiee\.claude\plans\scalable-orbiting-moler.md](C:\Users\dhiee\.claude\plans\scalable-orbiting-moler.md).
>
> **Arquitetura nova em produção**:
> ```
> mensagem WA → baileys → dhiego-ai.maybeHandle
>   ├─ extractTextOrTranscribe (áudio/Whisper já funcionava)
>   ├─ loadRecentEntries(12) + loadState
>   ├─ if cfg.mode === "agent":
>   │    router.routeIntent só como pre-hint (não gatekeeper)
>   │    runAgent(...) — loop Claude tool_use até 6 iterações
>   │      Claude decide: end_turn (texto) ou tool_use (ferramenta)
>   │      tool executa → tool_result volta pro Claude → repete
>   │    synthesizeIntentForState (compat com state.syncStateAfterTurn)
>   └─ else: dispatch legado (router+switch — rollback path)
> ```
>
> **Arquivos criados**:
> - [whatsapp-server/src/services/dhiego-ai/tool-schemas.js](whatsapp-server/src/services/dhiego-ai/tool-schemas.js) — 9 tools no formato Anthropic (create_idea, list_ideas, latest_idea, show_idea, update_idea com preserve_literal, complete_idea, cancel_idea, delete_idea, generate_ideas_pdf) + `TOOL_DISPATCH` + `mapToolNameToLegacyIntent` + `toolInputToLegacyArgs` pra state sync
> - [whatsapp-server/src/services/dhiego-ai/prompt-builder.js](whatsapp-server/src/services/dhiego-ai/prompt-builder.js) — `buildSystemPrompt({basePrompt, state, rules, facts, suggestedHint})` monta o prompt por turno; seções: base, tools policy, contexto ativo, regras ativas (P3 — vazio no MVP), fatos lembrados (P4 — vazio no MVP), **modo literal** (instruções fortes pra preservar blocos 1:1), dica do roteador
> - [whatsapp-server/src/services/dhiego-ai/agent.js](whatsapp-server/src/services/dhiego-ai/agent.js) — `runAgent({ctx, userText, history, state, ...})` com loop agentic (MAX_ITERATIONS=6, maxTokens=2048 por call), serialize dos tool_results capado em 4KB, `applyLiteralSafeguard` que restaura o texto original do usuário quando o modelo trunca um update_idea com preserve_literal=true, `synthesizeIntentForState` que devolve um `{tool, args}` no formato legado pro state.syncStateAfterTurn continuar funcionando sem mudanças
>
> **Arquivos modificados**:
> - [whatsapp-server/src/services/dhiego-ai/llm.js](whatsapp-server/src/services/dhiego-ai/llm.js) — `complete()` agora aceita `tools` e `toolChoice`, retorna `content` bruto e `stopReason` além de `text` (backwards-compat: chamadas antigas que só leem `.text` continuam funcionando)
> - [whatsapp-server/src/services/dhiego-ai.js](whatsapp-server/src/services/dhiego-ai.js:246) — L246+ ramifica por `cfg.mode`: `agent` chama `runAgent`, `router` mantém o dispatch legado. `ctx.lastUserText` é novo (usado pelo literal safeguard). Pre-hint via routeIntent é opcional e tolerante a erro
> - [whatsapp-server/src/services/dhiego-ai/config.js](whatsapp-server/src/services/dhiego-ai/config.js) — nova key `dhiego_ai_mode` lida do `app_settings`, default `agent`, valor `router` força o caminho legado
> - [whatsapp-server/src/services/dhiego-ai/tools/ideas.js:212](whatsapp-server/src/services/dhiego-ai/tools/ideas.js:212) — `updateIdea` aceita `preserveLiteral: boolean`; quando true, grava `text` sem `.trim()` (byte-a-byte)
> - [whatsapp-server/src/services/dhiego-ai/tools/ideas-pdf.js](whatsapp-server/src/services/dhiego-ai/tools/ideas-pdf.js) — `pdfkit` agora é lazy-required (permite que smoke tests estruturais carreguem tool-schemas sem ter pdfkit instalado)
> - [whatsapp-server/scripts/dhiego-ai-smoke.js](whatsapp-server/scripts/dhiego-ai-smoke.js) — +11 novos cenários estruturais (schema/dispatch sanity, prompt-builder, synthesizeIntentForState) + mantém os 10 casos de regressão do router legado
>
> **Seed de config** (via Management API):
> ```sql
> INSERT INTO app_settings (key, value) VALUES ('dhiego_ai_mode', 'agent')
>   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
> ```
>
> **Evidência de produção (live tests pós-deploy)**:
>
> Teste 1 — conversa sem tool:
> ```
> userText: "oi, tudo bem? me diz em uma frase curta o que voce consegue fazer pra mim."
> → stopReason=end_turn, tools=[], usage={input:2289, output:60}, 2.5s
> → reply: "Oi! Tudo bem sim 😊\n\nSou seu assistente pessoal de ideias: anoto, organizo, atualizo e arquivo tudo que você quiser lembrar ou desenvolver depois — é só mandar."
> ```
>
> Teste 2 — tool_use natural:
> ```
> userText: "Anota aqui pra mim: preciso revisar o fluxo de onboarding do EscaladaHub antes de sexta"
> → stopReason=end_turn, tools=[create_idea], usage={input:4940, output:115}, 3.2s
> → toolCall: create_idea({text: "preciso revisar o fluxo de onboarding do EscaladaHub antes de sexta"})
> → result: ideia #3 salva em dhiego_ideas
> → reply: "Anotado! ✅ Ideia #3 salva — revisar o onboarding do EscaladaHub antes de sexta."
> ```
>
> Smoke test local + VPS: 11 estruturais + 10 router legado, **todos verdes**.
>
> **Modelo em uso**: `claude-sonnet-4-6` (lido de `app_settings.dhiego_ai_llm_model`, já estava assim antes do round). Sonnet é overkill pros casos triviais mas fala português nativamente e lida bem com tool_use — manter por enquanto, considerar Haiku 4.5 depois se o custo apertar.
>
> **Rollback**:
> - **Runtime (sem redeploy)**: flipar `app_settings.dhiego_ai_mode` pra `router` via admin ou SQL — o caminho legado (`routeIntent → dispatch`) continua intacto no código. Config cache é 30s, então a mudança propaga na próxima leitura.
> - **Código**: os arquivos `.bak.20260415_204146` estão preservados em `/opt/ezap/whatsapp-server/src/services/dhiego-ai/`.
>
> **Arquivos críticos** (para próxima sessão do Claude retomar):
> 1. [whatsapp-server/src/services/dhiego-ai/agent.js](whatsapp-server/src/services/dhiego-ai/agent.js) — coração do Round 1
> 2. [whatsapp-server/src/services/dhiego-ai/tool-schemas.js](whatsapp-server/src/services/dhiego-ai/tool-schemas.js) — ponto de extensão para adicionar tools novas
> 3. [whatsapp-server/src/services/dhiego-ai/prompt-builder.js](whatsapp-server/src/services/dhiego-ai/prompt-builder.js) — onde Round 2 (rules/facts) vai plugar
> 4. [whatsapp-server/src/services/dhiego-ai.js:246](whatsapp-server/src/services/dhiego-ai.js:246) — ramificação `agent` vs `router`
> 5. [C:\Users\dhiee\.claude\plans\scalable-orbiting-moler.md](C:\Users\dhiee\.claude\plans\scalable-orbiting-moler.md) — plano completo com P3/P4/P6/P7 documentados como roadmap
>
> **Roadmap Round 2** (pendente): P3 = regras editáveis por tópico no admin (`dhiego_ai_rules`), P4 = memória persistente de fatos (`dhiego_ai_facts`, LLM escreve + admin edita), P7 = observabilidade de trace no conversation viewer (`dhiego_conversations.trace` JSONB). P6 (sumário rolante) só quando context ficar problemático.
>
> **Pendência de commit**: os arquivos estão deployados no VPS mas ainda não comitados no git local. Próximo passo natural = `git add` dos 9 arquivos + commit com mensagem descritiva + `git push origin main`. O Dhiego não pediu o commit ainda — posso fazer quando ele confirmar.

---

> **Update 2026-04-15 final — Session Quarantine Mode + fix definitivo do rate-limit de grupos (Escalada Ltda) — DEPLOYED**
>
> Commit: `4320fe8` — `feat(baileys): session quarantine mode — airplane mode against rate-limit leaks` (17 files, +1520/−196). PID 116023 no Hetzner, health ok, 6+ sessões conectadas e reconectando.
>
> **Cenário**: o Dhiego tentou criar 10 grupos na Escalada Ltda (5519993473149) com delay conservador de 300s (5min) entre cada. Bateu rate-limit depois de apenas 3/10 grupos. Como Escalada é a conta mais crítica da empresa (10-15 grupos/dia, insubstituível), fizemos um diagnóstico completo do pipeline e implementamos uma camada de defesa permanente.
>
> **Diagnóstico — 5 vazamentos críticos de IQs** (mapeados no [baileys.js](whatsapp-server/src/services/baileys.js) + rotas):
> 1. `handleIncomingMessage` chamava `sock.groupMetadata(jid)` em TODA mensagem de grupo recebida pra pegar `chat_name`. Escalada é conta empresarial ativa: ~dezenas de msgs/min × ~15min de job = 100-300 IQs escondidos. **Maior leak, não estava no radar.**
> 2. Handler `group-participants.update` chamava `sock.groupMetadata` em toda mudança de participante — disparado pelos próprios `groupCreate` da sessão. 30-40 IQs.
> 3. `createGroupsFromList` tinha `sock.groupMetadata` force-sync após cada groupCreate (redundante, baileys emite o evento sozinho). 10 IQs.
> 4. Welcome message retry loop (até 3×) com `groupMetadata` refresh em cada retry. 10-20 IQs.
> 5. Rotas HTTP expostas ao ezapweb/extension: `/profile-pic`, `/group-info`, `/list-admin-groups`, `/groups`, `/add-to-groups`, `/messages/send` — cada click vira 1 IQ.
>
> Total: **250-480 IQs por job de 10 grupos**, onde o custo intrínseco é ~60. Mesmo com delay de 5min o rate-limit enche.
>
> **Solução entregue — Session Quarantine Mode**:
>
> 1. Novo `sessionQuarantine` Map + helpers (`quarantineSession`, `releaseSession`, `isQuarantined`, `getQuarantineStatus`) em [services/baileys.js](whatsapp-server/src/services/baileys.js) linhas 36-75. "Modo avião" por sessão: photo-worker pausado, handlers pulam `sock.groupMetadata` (persistência Supabase continua via cache), rotas HTTP retornam 409.
> 2. Gate em [baileys.js:541](whatsapp-server/src/services/baileys.js:541) (`group-participants.update` handler) envolvendo o `sock.groupMetadata(groupJid)` com `if (!isQuarantined(sessionId))`.
> 3. [baileys.js:~859](whatsapp-server/src/services/baileys.js:859) `handleIncomingMessage` agora lê `chat_name` cache-first do `wa_chats` — o handler `groups.update` já mantém essa coluna fresh. Fallback pra `sock.groupMetadata` só quando cache miss **AND** sessão não quarantined. **Elimina o leak #1, o maior.**
> 4. Novo helper `applyCriticalSessionOverrides` em [baileys.js:~1944](whatsapp-server/src/services/baileys.js:1944): força `delaySec≥600`, `hourlyCap=3`, `leadingDelayMs=120000` quando `phone ∈ CRITICAL_PHONES = {"5519993473149"}` OU `failureStreak≥5` OU `timedOut≥50`. Escalada sempre pega a trilha conservadora.
> 5. `createGroupsFromList` agora chama `quarantineSession(sessionId, "create_groups_job")` no início (substitui `photoWorker.pauseSession`). Remove `sock.groupMetadata` forçado em [baileys.js:2092](whatsapp-server/src/services/baileys.js:2092). Colapsa welcome retry loop para 1 tentativa fail-fast em [baileys.js:~2131](whatsapp-server/src/services/baileys.js:2131). Leading delay usa `options._leadingDelayMs` se presente.
> 6. `finally` block reescrito: **se rate-limited, mantém quarentena ativa até liberação manual**. Previne photo-worker + ezapweb de re-tocarem conta flagged.
> 7. Gates HTTP 409 em:
>    - [routes/contacts.js](whatsapp-server/src/routes/contacts.js) — `GET /profile-pic`, `GET /group-info`, `POST /read`
>    - [routes/sessions.js](whatsapp-server/src/routes/sessions.js) — `POST /list-admin-groups`, `POST /list-admin-groups-with-membership`, `POST /add-to-groups`, `POST /groups`
>    - [routes/messages.js](whatsapp-server/src/routes/messages.js) — `POST /send`
> 8. 3 novos endpoints em routes/sessions.js:
>    - `POST /api/sessions/:id/quarantine { reason }` — entra em quarentena
>    - `POST /api/sessions/:id/quarantine/release` — libera
>    - `GET /api/sessions/:id/quarantine` — status atual (ou null)
> 9. [grupos.html](grupos.html): `classifySession` tem branch quarentena como prioridade máxima (🔴 "Quarentena"); render do card de temperatura tem badge 🚨 + botão por sessão ("🚨 Quarentena" ou "▶️ Liberar"); modal `openCreateGroupsModal` tem Priority 0 que bloqueia submit com aviso vermelho "⛔ Sessão em quarentena"; `loadSessions` enriquece cada sessão com `quarantine` via `/api/sessions/:id/quarantine`; helpers `enterQuarantine(sessionId)` e `releaseQuarantine(sessionId)`.
>
> **Impacto projetado**: IQs por job de 10 grupos **250-480 → ~60** (~80% redução). Escalada volta a comportar 10-15 grupos/dia com margem folgada.
>
> **Smoke test feito em produção** (sessão aleatória, não-Escalada):
> ```
> GET  /api/sessions/{sid}/quarantine → {"ok":true,"status":null}
> POST /api/sessions/{sid}/quarantine {"reason":"smoke_test"}
>      → {"ok":true,"status":{"enteredAt":"2026-04-15T22:40:10.707Z","reason":"smoke_test","durationMs":0}}
> GET  /api/sessions/{sid}/quarantine → durationMs=6ms (timer funcionando)
> POST /api/sessions/{sid}/quarantine/release → {"ok":true,"status":null}
> ```
> Sequência completa funcional.
>
> **Como o Dhiego usa agora para criar grupos na Escalada com segurança**:
> 1. Aguardar **no mínimo 2h** desde o último rate-limit (agora é suficiente — o pre-flight check em `createGroupsFromList` já bloqueia naturalmente via `getQueueFailureStats≥100 timedOut/2h`).
> 2. No grupos.html, no card de temperatura da Escalada, clicar **🚨 Quarentena** com reason="prep" — silencia a sessão totalmente (photo-worker, handlers, ezapweb).
> 3. Aguardar ~30min pra `rateLimitRegistry` drenar.
> 4. Clicar **▶️ Liberar** (ou deixar como está — o `createGroupsFromList` vai re-entrar em quarentena ao iniciar, o release é só necessário se `isQuarantined` bloqueia o modal).
> 5. Abrir o modal de criar grupos, selecionar Escalada. O helper `applyCriticalSessionOverrides` **força automaticamente**: delay mínimo 600s (10min), leading delay 120s, hourlyCap 3/h. Independente do que ele escolher no radio de velocidade no modal.
> 6. Começar com **1 grupo só** no primeiro lote pra validar. Se passar limpo, aguardar 10min e tentar +2. Escalar até 3 no primeiro dia, só depois subir pra 5-10.
> 7. Se algo der errado: o `finally` mantém a sessão quarantined; o badge no card vira permanente até liberação manual. Dhiego vê que a sessão precisa de atenção e libera manualmente quando achar seguro.
>
> **NÃO mexer em**: Outras 17 sessões (overrides só disparam pra Escalada + flagged); DHIEGO.BOT (1ae154a4-, phone 5511991154573); sessão Dhiego Rosa self-chat.
>
> **Arquivos críticos (para futura sessão do Claude retomar)**:
> - [whatsapp-server/src/services/baileys.js](whatsapp-server/src/services/baileys.js) — helpers quarentena (36-75), handler gates (541, ~859), overrides helper (~1944), entry em `createGroupsFromList` (~1996), remove groupMetadata (~2092), welcome collapse (~2131), finally rewrite (~2198), exports (2859)
> - [whatsapp-server/src/routes/sessions.js](whatsapp-server/src/routes/sessions.js) — gates 409 (174, 189, 249, 284) + 3 endpoints novos (306)
> - [whatsapp-server/src/routes/contacts.js](whatsapp-server/src/routes/contacts.js) — gates 409 (60, 96, 83)
> - [whatsapp-server/src/routes/messages.js](whatsapp-server/src/routes/messages.js) — gate 409 (linha 13)
> - [grupos.html](grupos.html) — loadSessions com quarantine (594), enterQuarantine/releaseQuarantine (630/645), classifySession (744), card render (824-836), modal guard (1734)
>
> **Rollback rápido** se algo regredir:
> - Runtime (sem redeploy): `curl -X POST http://localhost:3100/api/sessions/{id}/quarantine/release` + `pm2 restart ezap-whatsapp` (sessionQuarantine é in-memory, restart limpa)
> - Código: `ssh ... 'cd /opt/ezap/whatsapp-server && git revert --no-edit 4320fe8 && <deploy flow>'`. BUT ATENÇÃO: o commit 4320fe8 bundleou também o trabalho da tarde/noite do DHIEGO.AI (LID resolution + contextual state + ideas latest/delete/update + lid_phone_map upserts). Revert perde tudo isso também. Se quiser apenas desligar a quarentena sem reverter o resto, editar só o call `quarantineSession` em `createGroupsFromList` linha ~1996 de volta pra `photoWorker.pauseSession` e o finally pra `photoWorker.resumeSession` sempre.
>
> **Observação sobre o deploy**: a primeira tentativa teve um bug no shell pipeline — o `git pull 2>&1 | tail -20` mascarava o exit code, então um `pm2 restart` rodou sobre estado inconsistente. Na segunda tentativa, fiz `set -e` + `git checkout --` explícito em todos os tracked files modificados + `rm -f` dos untracked overlays + `git pull` limpo + `node --check` em cada arquivo JS antes do restart. Sem essa proteção, teriam entrado erros silenciosos em produção. Preservar esse padrão (`set -e` + syntax check pré-restart) nos próximos deploys.

---

> **Update 2026-04-15 manhã — DHIEGO.AI self-chat mode + pivot pra WhatsApp Business (em aberto)**
>
> Continuação da madrugada. Acordou, tudo crítico estável (Supabase SMALL, 18 sessões reconectadas, Escalada pronta pra uso). Foco da manhã foi destravar o DHIEGO.AI que ficou bloqueado por Signal protocol issues entre iPhone primário + baileys linked device.
>
> **Commits da manhã** (todos deployados no Hetzner):
> - `1147dc1` — `feat(dhiego-ai): self-chat mode` — novo filtro em `maybeHandle`: detecta `ownPhone = sock.user.id` e `chatPhone`, se `chatPhone === ownPhone` marca `isSelfChat`. Autorização: `isAllowed = isSelfChat || isInAllowlist`.
> - `0f52ec9` — `fix(dhiego-ai): strict fromMe requires self-chat` — o filtro anterior tinha um bug: com `authorizedPhones=["5511989473088"]` (o próprio número do user), toda mensagem `fromMe` passava pelo allowlist (sender = 5511989473088 = own). Isso significava que TYPING pra um cliente ou amigo disparava o bot, exatamente o hijack que a gente queria prevenir. Fix: `if (isFromMe) isAllowed = isSelfChat; else isAllowed = isInAllowlist;`. Paths mutuamente exclusivos.
> - `db1f7e3` — `fix(dhiego-ai): unwrap deviceSent/ephemeral/viewOnce envelopes` — mensagens entre linked devices próprios (ex: "Message Yourself" no iPhone) vêm embaladas em `msg.message.deviceSentMessage.message.conversation`. Adicionou `unwrapMessage()` recursivo que trata `deviceSentMessage`, `ephemeralMessage`, `viewOnceMessage`, `viewOnceMessageV2`, `viewOnceMessageV2Extension`, `documentWithCaptionMessage`. Plain text self-chat já funcionava; isso é pra edge cases.
>
> **Self-chat mode TESTADO E FUNCIONAL** — a sessão "Dhiego Rosa" (id `235d25ac-b2b4-4680-b5ed-3f1e0b373916`, phone 5511989473088, logada pelo próprio iPhone principal do Dhiego) recebeu texto, roteou pro Claude, respondeu via WhatsApp. Fluxo verificado nos logs:
> ```
> [DHIEGO.AI] Processing message from 5511989473088  text: oi
> [DHIEGO.AI] routed via Claude: llm-freeform
> [DHIEGO.AI] Processing message from 5511989473088  text: como vai?
> [DHIEGO.AI] Processing message from 5511989473088  text: mande os postos de gasolina perto de mim
> ```
> O Dhiego viu as respostas chegando no "Mensagem para si mesmo". **Funcionou 100%**.
>
> **Por que abandonou self-chat**: UX. No "Message Yourself", todas as mensagens (user + bot) aparecem do mesmo lado (verde, direita) — fica difícil visualmente diferenciar pergunta de resposta. O Dhiego pediu: "gostaria de poder falar com outro numero pra diferenciar o que eu envio do que eu recebo".
>
> **Pivot — DHIEGO.BOT via WhatsApp Business no iPhone**:
>
> O Dhiego tem um iPhone **dual-chip** com:
> - **WhatsApp normal** logado com 5511989473088 (pessoal)
> - **WhatsApp Business** logado com 5511991154573 (bot)
>
> Apps separados, cada um com ciclo de vida independente no iOS. Plano: linkar nosso baileys como aparelho conectado do **WhatsApp Business** (5511991154573). Mensagens do 3088 pro 4573 caem no allowlist (`authorizedPhones` já tem `["5511989473088"]`).
>
> **Passos executados**:
> 1. Disconectei a sessão antiga DHIEGO.AI (`da47bbe6`, phone 5519997012821) e a sessão self-chat "Dhiego Rosa" (`235d25ac`, phone 5511989473088) — ambas com `status='disconnected'` + `creds=null` no DB.
> 2. PM2 restart pra purgar as sessões da memória do baileys (achei um bug: `stopSession()` não remove do `sessions` Map, só pára — o restart contorna).
> 3. Dhiego criou no admin uma nova sessão "DHIEGO.BOT" (id `1ae154a4-8c8e-4956-a716-6c5f5159023a`).
> 4. Fresh-qr, escaneou o QR com o WhatsApp Business do iPhone, sessão ficou `connected` com phone `5511991154573`.
> 5. Atualizei:
>    - `wa_sessions.user_id` = `58db56f3-f84e-43b2-bbb2-17af8f52b9b8` (Dhiego Rosa)
>    - `app_settings.dhiego_ai_session_id` = `1ae154a4-8c8e-4956-a716-6c5f5159023a`
>    - Invalidate cache via PATCH `/api/dhiego-ai/config`
> 6. Config atual confirmada: enabled=true, sessionId=`1ae154a4...`, authorizedPhones=`["5511989473088"]`, llm_model=`claude-sonnet-4-6`, systemPrompt default, Claude+Whisper keys presentes.
>
> **PROBLEMA EM ABERTO AGORA**:
>
> Dhiego manda mensagens de 5511989473088 (WhatsApp Web + WhatsApp pessoal iPhone) pro contato "DHIEGO.BOT" (5511991154573). No remetente, chegam a **`✓✓` (dois checks = delivered)**. Mas **nenhuma mensagem chega no nosso baileys** — zero eventos em logs filtrados por `DHIEGO.AI` ou `1ae154a4` ou `5511989473088` durante os últimos ~200 log lines. Não tem Processing, não tem decrypt error, não tem ignoring — literalmente nada.
>
> **Hipótese principal**: cache de device-list no cliente do Dhiego. Tanto o WhatsApp Web quanto o WhatsApp pessoal do iPhone tinham o 5511991154573 na lista de contatos ANTES do baileys ser linkado. Eles estão entregando as mensagens apenas pros devices que conheciam (WhatsApp Business no iPhone), pulando nosso baileys novo. O `✓✓` vem do Business acking, não do nosso.
>
> **Fix sugerido mas NÃO TESTADO** (deixei de comunicar pro Dhiego logo antes desse handoff):
> 1. Force-quit WhatsApp Business no iPhone
> 2. Reabrir, esperar 5s
> 3. Fechar WhatsApp Web inteiro, reabrir e re-scanear QR pelo iPhone
> 4. Ou alternativa mais rápida: mandar mensagem direto **do iPhone** (não do Web) — isso força device list refresh localmente
>
> **Outras hipóteses** se a primeira não resolver:
> - History sync massivo do WhatsApp Business consumindo toda a banda de eventos (vi `msgs: 5000 chats: 0` em loop várias vezes no log do `1ae154a4`). Talvez o baileys ainda não tenha saído do initial sync quando o Dhiego mandou as mensagens de teste. Solução: esperar o history sync terminar (talvez 5-10min dependendo do tamanho).
> - iOS suspendendo o WhatsApp Business mesmo em foreground (improvável se user está ativamente olhando).
> - Bug na pairing: alguma coisa no QR scan que não completou 100%.
>
> **Fallback garantido** se o caminho DHIEGO.BOT não destravar: voltar pro **self-chat mode** (sessão "Dhiego Rosa" com 5511989473088). Deploy ainda está lá, código self-chat ativo. Basta re-escanear QR no admin pra reativar. Opcional: adicionar 1 linha em `llm-freeform.js` pra prefixar respostas do bot com `🤖 ` e dar diferenciação visual no "Message Yourself".
>
> **Estado atual no servidor**:
> - PM2 online, PID 104429, commit `db1f7e3` (último da manhã)
> - Sessões: 18+ conectadas (Escalada, CX, outras), + `1ae154a4-...` DHIEGO.BOT marcado connected
> - Config DHIEGO.AI: sessionId=`1ae154a4-8c8e-4956-a716-6c5f5159023a`, allowlist=`["5511989473088"]`
> - Sessões deprecated: `da47bbe6` (DHIEGO.AI antiga, phone 5519997012821) e `235d25ac` (Dhiego Rosa self-chat, 5511989473088) — ambas disconnected + creds=null, preservadas pra referência no DB
>
> **Como retomar**:
> 1. Ler o último diagnóstico: se as mensagens do Dhiego chegarem no baileys, deve aparecer `[DHIEGO.AI] Processing message from 5511989473088` nos logs do PM2. `ssh root@87.99.141.235 'pm2 logs ezap-whatsapp --lines 300 --nostream' | grep DHIEGO.AI`
> 2. Se nada chegou ainda, sugerir os 4 passos do fix acima pro Dhiego (force-quit + reabrir)
> 3. Se força-quit não resolver, esperar ~10min pra history sync terminar e tentar de novo
> 4. Se ainda não funcionar, voltar pro self-chat mode como plano B — funciona 100%, só requer re-scan do QR da sessão Dhiego Rosa
> 5. Feature nice-to-have pós-tudo: prefix `🤖 ` nas respostas do bot pra UX distinction (1 linha em `llm-freeform.js`, `return { ok: true, reply: "🤖 " + resp.text, ... }`)

---

> **Update 2026-04-15 madrugada — incidente de capacidade + DHIEGO.AI Fase 2 + bug crítico do dedup index**
>
> **Linha do tempo da madrugada (commits `5211bf7` → `26ca82a`)**:
>
> 1. **Latência 90–270s no `validate_token`** voltou após o commit do DHIEGO.AI Fase 1. Causa: 18 sessões reconectando paralelamente disparavam history sync simultâneo + cada upsert de mensagem retornava 409 (`merge-duplicates` sem `on_conflict` parametrizado), gerando milhares de round-trips por segundo. Kong/PostgREST saturaram → admin.html parava de logar.
> 2. **Fix 1 (commit `5211bf7`)**: adicionei `?on_conflict=session_id,message_id` (e equivalentes pra wa_chats, wa_contacts, group_members) em todos os upserts hot-path do baileys. Erros 409 zeraram. **MAS** isso introduziu o bug crítico do item 6 abaixo.
> 3. **Fix 2 (commit `edbe679`)**: semáforo `SUPA_MAX_CONCURRENCY=6` em `services/supabase.js` envolvendo `supaRest` + delay 2s→15s entre reconnects em `reconnectAllSessions`. Espaça as 18 sessões ao longo de ~4.5min em vez de detonar tudo de uma vez.
> 4. **Restart manual do Supabase** (REST/Kong ficaram unhealthy mesmo com Postgres ok) — usuário clicou no dashboard. Voltou em ~2min.
> 5. **Upgrade plan compute MICRO → SMALL** (1GB → 2GB RAM, recomendado pelo agente). Postgres patch 17.6.1.052 → .104 ficou pendente pra fim de semana calmo.
> 6. **Bug crítico descoberto via DHIEGO.AI** (commit `26ca82a`, **migration 045**): o `idx_wa_messages_dedup` é um índice unique PARCIAL com `WHERE message_id IS NOT NULL`. PostgREST **não consegue** usar índice parcial como alvo de `?on_conflict=...` — Postgres rejeita com 42P10. Resultado: desde o commit `5211bf7`, **todos os inserts em `wa_messages` falhavam silenciosamente** (HTTP 400 do PostgREST). Sintomas: ezapweb não persistia mensagens, e o hook do DHIEGO.AI nem rodava porque `handleIncomingMessage` jogava exceção no `supaRest` ANTES de chegar no hook. **Fix**: drop do índice parcial + recreate como UNIQUE regular (zero rows com NULL, comportamento idêntico). Migration 045 já rodada.
>
> **DHIEGO.AI Fase 2 entregue** (commit `5441168`):
> - **Memória persistente** — nova tabela `dhiego_conversations` (migration 044), helper `services/dhiego-ai/history.js` com `loadRecentTurns` (20 últimas) + `saveTurn`. `llm-freeform.js` agora prepende o histórico no `messages` antes do `complete()`.
> - **System prompt editável** — nova chave `app_settings.dhiego_ai_system_prompt`, exposta no `config.js` e usada como `system` no Claude call (com fallback hardcoded). Admin tem textarea estilo CLAUDE.md no card "📜 Contexto e regras globais".
> - **Audio transcription via Whisper** — novo helper `services/dhiego-ai/transcribe.js`, usa `app_settings.openai_api_key` (já existia). `dhiego-ai.js` `extractTextOrTranscribe` baixa áudio via `downloadMediaMessage` e roda Whisper, retorna texto que segue o fluxo normal.
> - **Admin panel novo**: cards "Contexto e regras globais", "Histórico de conversas" (lista cronológica role-coded com refresh + clear). Status indicator agora mostra Claude + Whisper.
> - **Novos endpoints**: `GET /api/dhiego-ai/conversations?userId=...&limit=50`, `DELETE /api/dhiego-ai/conversations?userId=...` (userId obrigatório).
> - **Endpoint emergencial**: `GET /api/sessions/:id/qr-raw` (commit `a5c0987`) retorna o QR string da sessão em memória pra fallback quando o socket do admin não entrega `session:qr`.
>
> **PROBLEMA EM ABERTO — DHIEGO.AI não recebe mensagens do iPhone do Dhiego**:
> - A sessão DHIEGO.AI está hoje no número **5511991154573**, num iPhone que tem WhatsApp instalado como device primário. O baileys entra como linked device.
> - **Sintoma**: mensagens só chegam quando o Dhiego abre a tela da conversa no iPhone. Quando fecha, baileys recebe mensagens criptografadas mas falha em decryptar com `PreKeyError: Invalid PreKey ID` ou `SessionError: No session record`.
> - **Causa**: iOS suspende WhatsApp em background mais agressivamente que Android (sem opção de "desabilitar otimização de bateria"). Quando o app primário está dormindo, prekeys não são distribuídas pro linked device baileys.
> - **Plano combinado pra amanhã**: desconectar o número 5511991154573 e usar **outro chip num outro aparelho** (provavelmente Android antigo deixado ligado 24/7 dedicado). Quando o novo número for escaneado, atualizar `app_settings.dhiego_ai_session_id` e `wa_sessions.user_id` (= `58db56f3-f84e-43b2-bbb2-17af8f52b9b8` do Dhiego Rosa).
>
> **Estado atual (deployed e rodando)**:
> - Hetzner PM2 commit `26ca82a` online com 18+ sessões reconectadas e estáveis
> - Latência Supabase saudável (~300-500ms validate_token, ~1s GET /users)
> - Photo-worker: ainda pausado globalmente (state em `data/photo-worker-state.json`)
> - DHIEGO.AI: enabled, session=`da47bbe6-c349-49f6-b7cd-50b0283aaabd` (a ser trocada amanhã), authorized_phones=`["5511989473088"]`, llm_model=`claude-sonnet-4-6`, system_prompt no default
> - Pendente Escalada (5519993473149) pra criação de grupos pela manhã — pre-flight liberado, plano de teste "1 grupo, 3 membros, delay 180s" continua válido

---

> **Update 2026-04-15 (DHIEGO.AI — Fase 1 MVP)**: nova feature — assistente pessoal via WhatsApp. Sessão dedicada `DHIEGO.AI` (5511989473088, id `d9f39bb5-5f3e-4bf3-8d47-9944c9cf78ff`) escuta mensagens, autoriza sender (fromMe OU allowlist admin), roteia intent (regex fast-path + Claude classifier fallback) e executa: `ideas-add` / `ideas-list` / `ideas-complete` / `ideas-cancel` / `ideas-pdf` / `llm-freeform`. Stack: Anthropic Claude via `@anthropic-ai/sdk` (Haiku 4.5 default), `pdfkit` pra PDF de backlog, tabela `dhiego_ideas` (migration 043). Admin panel novo tab "🤖 DHIEGO.AI" com toggle enabled, dropdown de sessão, allowlist de phones, seletor de modelo, e lista de ideias com ações. `claude_api_key` está em `app_settings` (injetada via SQL one-shot, NUNCA commitada). HubSpot/Whisper/áudio/Supabase queries = Fase 2. Detalhes em §2 "(próximo commit)" e arquivos em `whatsapp-server/src/services/dhiego-ai/*`.


> **Update 2026-04-15 (commit `3a893b2`)**: o painel de temperatura introduzido em `27afc70` estava saturando o pooler do Supabase com ~162 COUNT queries a cada 10s (9 counts × 18 sessões). Apenas o bucket "pending" tinha índice — todos os outros buckets em `wa_photo_queue` faziam seq scan. Sintomas: admin.html não logava, grupos.html nem renderizava o card, ezapweb lento. Fix em 3 camadas:
> 1. **Migration 042**: `idx_wa_photo_queue_session_status` composto + índices parciais em `wa_contacts(photo_url)` e `wa_chats(archived)` + RPC `get_sync_status_all()` que retorna counters de todas as sessões em uma única round-trip via LATERAL + FILTER.
> 2. **Novo endpoint** `GET /api/sync/status-all` em [whatsapp-server/src/routes/sync.js](whatsapp-server/src/routes/sync.js) com cache de 5s em memória.
> 3. **grupos.html**: loop N-calls virou 1 call ao batch endpoint, interval 10s → 30s, e polling pausa totalmente quando `document.hidden`. Resultado: ~162 queries/10s → 1 query/30s quando visível, 0 quando escondida.



Handoff para a próxima sessão do Claude. Este arquivo resume **o quê, por quê e o que falta** do fio de trabalho atual (anti-rate-limit + photo-worker + fotos no ezapweb + painel de temperatura).

> Para contexto operacional geral do projeto (deploy, credenciais, convenções) ver `CLAUDE.md` na raiz. Para contexto da ferramenta de grupos especificamente, ver `.claude/grupos-tool-handoff.md`.

---

## 1. O problema central desta sessão

O usuário reportou **rate-limit imediato** ao tentar criar grupos em massa nas contas recém-reconectadas. Diagnóstico após duas rodadas de análise:

1. **Não era o `createGroupsFromList` sozinho.** O photo-worker, ao retomar depois de uma reconexão, enfileirava **TODOS os contatos + TODOS os participantes de TODOS os grupos** (syncGroupMetadata → enqueuePhotos em massa, ~30k itens por sessão grande). Disparava `sock.profilePictureUrl()` a cada 8s por sessão.
2. O WhatsApp respondia com **"Timed Out" silenciosos** após algumas dezenas de IQs por conta — rate-limit server-side não-explícito.
3. Quando o usuário chamava `createGroupsFromList` nessa sessão, o device já estava no teto de IQ budget do WhatsApp. Primeiro `groupCreate` falhava imediatamente com `rate-overlimit`, mesmo com delay de 180s.

Estado inicial da `wa_photo_queue` na hora do incidente:
- **6281** rows failed (todos com `error="Timed Out"`)
- **1122** done (fotos reais baixadas)
- **119** no_photo
- **1224** rows stuck em `status='downloading'` (leak de PM2 restart anterior)

Conta crítica da empresa: **Escalada Ltda (5519993473149)**. Tinha 70 done / 1169 failed — conta silenciosamente flagged pelo WhatsApp.

---

## 2. O que já foi entregue (por commit, chronológico)

### [5a8f0ca](https://github.com/beniciorosa/E-ZAP/commit/5a8f0ca) — Primeira linha de defesa
Arquivos: `whatsapp-server/src/services/baileys.js`, `jobs.js`, `routes/sessions.js`, `routes/jobs.js`, `services/photo-worker.js`, `grupos.html`.

- **`photoWorker.pauseSession(sessionId)` / `resumeSession(sessionId)`** — pausa o worker de uma sessão específica, move o `intervalId` de `activeWorkers` para `pausedWorkers`, retoma sem perder estado
- **`createGroupsFromList`** agora pausa o photo-worker no início e retoma no `finally`, garantindo zero IQs concorrentes durante o groupCreate
- **`waitForGroupCreateBudget`** helper: drena fila de fotos (espera pending+downloading < 5, max 60s) + enforce hourly cap via `wa_group_creations` (default 6/h, `GROUP_CREATE_HOURLY_CAP` env var)
- **Leading delay** de `baseDelayMs/2` (max 90s) antes do primeiro `groupCreate`
- **`rateLimitRegistry`** em memória (Map no baileys.js) — persiste entre reconnects, apagado no PM2 restart. 30min cooldown após rate-limit detectado
- **`startCreateGroupsJob`** rejeita com HTTP 429 se `rateLimitHitAt` < 30min atrás
- **`/api/sessions`** agora retorna `connectedAt`, `rateLimitHitAt`, `rateLimitRemainingMs`, `photoWorkerHealth`
- `grupos.html`: card de sync de fotos no topo + botão "🖼️ Gerenciar fotos" → fotos.html; aviso no modal de criar grupos quando sessão recém-conectada ou em cooldown; job card mostra `waitPhase` (photo_drain / leading_delay / hourly_budget) com countdown

### [004fc83](https://github.com/beniciorosa/E-ZAP/commit/004fc83) — Detecção de silent rate-limit
- **Auto-pause on timeout cascade**: 10 timeouts consecutivos do `profilePictureUrl` na mesma sessão → pausa automática de 15min + `markRateLimit(sessionId)` pra bloquear create-groups também
- **Pre-flight health check em `startCreateGroupsJob`**: rejeita com 429 se (a) photo-worker auto-pausado OR (b) `wa_photo_queue` tem ≥100 "Timed Out" nas últimas 2h
- **`supaCount`** novo helper em `services/supabase.js` (HEAD + `Prefer: count=exact` + parse de `Content-Range`) — resolve o cap de 1000 do PostgREST no display
- **Sync card** mostra done/failed separados com barra tri-color (verde/azul/vermelho)
- **Modal de criar grupos** tem 4 níveis de alerta: vermelho (cooldown/pausado) bloqueia, amarelo (streak alto, recém-conectado) só avisa

### [7810d75](https://github.com/beniciorosa/E-ZAP/commit/7810d75) — Slow down do photo-worker
- `PHOTO_INTERVAL_MS: 15000 → 60000` (1 foto por minuto por sessão)
- Rows em `failed` **NÃO são retentadas automaticamente** — ficam failed até reset manual
- Decisão consciente: usuário OK com sync lento ao longo de dias/semana se evita suspensão

### [7863b33](https://github.com/beniciorosa/E-ZAP/commit/7863b33) — Fotos no ezapweb.html
- **Causa raiz**: o photo-worker fazia PATCH no `wa_chats`/`wa_contacts` pra gravar `photo_url`, mas se a linha não existia ainda (comum pra grupos — nunca entram em `wa_contacts`), o PATCH afetava 0 rows silenciosamente. Fotos ficavam **órfãs no Supabase Storage**, sem referência no DB
- **Fix**: `/api/contacts/:id/chat-photos` e `/api/messages/:id/chats` agora calculam a URL pública **direto do `wa_photo_queue` status='done'** usando o path determinístico `{SUPA_URL}/storage/v1/object/public/profile-photos/{sessionId}/{jid_safe}.jpg`
- Paginado wa_chats fetch (1000-row chunks) pra sessões pesadas: CX 1826 chats, Escalada 930
- Legacy `photo_url` de `wa_chats`/`wa_contacts` continua como fallback

### [27afc70](https://github.com/beniciorosa/E-ZAP/commit/27afc70) — Lazy fetch + toggle global + painel de temperatura
- **Lazy fetch**: REMOVEU todos os `enqueuePhotos` em massa de `syncGroupMetadata`, `chats.upsert`, `contacts.upsert`, `processHistorySync`. Adicionou `enqueuePhotos(sessionId, [jid])` em `handleIncomingMessage` (linha 685) — só baixa foto de quem MANDA mensagem. Com o intervalo de 60s, mesmo tráfego pesado = máx 60 IQs/hora por sessão
- **Global pause**: `photoWorker.pauseGlobal()` / `resumeGlobal()` / `isGlobalPaused()`. Flag persistido em `/opt/ezap/whatsapp-server/data/photo-worker-state.json` — sobrevive a PM2 restart. `processNext` short-circuit quando pausado
- **Novas rotas**: `GET /api/sync/photo-worker/status`, `POST /api/sync/photo-worker/pause`, `POST /api/sync/photo-worker/resume`
- **Painel de temperatura** (grupos.html): sync card virou "🌡️ Temperatura das contas" permanente (começa expandido). Classificação 🟢🟡🔴 por sessão baseada em success rate, failure streak, cooldown. Por sessão: barra tri-color, ✅/❌ pode criar grupos, badge de streak, linha de motivo humano. Ordenação red-first. Header tem toggle ⏸/▶ global

### (próximo commit) — Lazy fetch (A+C) + fix do toggle button
- **Bug crítico corrigido**: em `routes/sync.js`, as rotas `/photo-worker/status|pause|resume` estavam registradas DEPOIS da rota parametrizada `/:sessionId/status`. Express matava por ordem, então `GET /api/sync/photo-worker/status` caía em `/:sessionId/status` com `sessionId="photo-worker"`, retornava payload sem `globalPaused`, e o botão da UI revertia pra "Pausar" depois do click. Fix: rotas literais agora vêm ANTES da parametrizada
- **UI do botão agora é imediato**: `togglePhotoWorkerGlobal` atualiza `_globalPhotoWorkerPaused` e chama `updatePhotoWorkerButtonUI()` direto do POST response, sem depender de um GET follow-up. `refreshGlobalPhotoWorkerStatus` ficou mais defensivo (só confia no payload se tem `typeof globalPaused === "boolean"`)
- **Novo endpoint backend**: `POST /api/contacts/:sessionId/enqueue-photos { jids: [...] }` — até 200 jids por chamada, usa `ignore-duplicates`, NÃO retenta failed rows. Exportou `baileys.enqueuePhotos`
- **ezapweb.html (A) lazy-on-chat-open**: `openChat(jid, name)` agora detecta se o chat não tem foto (nem em `chats.photoUrl` nem em `chatPhotos`) e faz `POST /enqueue-photos` pro JID. Foto chega via `photo:ready` Socket.io event em até 60s
- **ezapweb.html (C) lazy-on-visible-list**: `renderChatList` chama `enqueueVisibleChatPhotos(filtered)` com debounce de 400ms. Coleta até 30 JIDs sem foto dos chats visíveis, dedupe via `_visiblePhotoEnqueued[sessionId]` pra garantir que cada jid só é requisitado uma vez por page load
- **CLAUDE.md**: adicionada seção "Memória de sessão (SUMMARY.md) — IMPORTANTE" lembrando de sempre atualizar o arquivo ao final de cada rodada

### SQL one-shot (não comitado, rodado via Management API)
```sql
UPDATE wa_photo_queue SET status='pending', attempts=0, error=NULL, last_attempt_at=NULL
WHERE status='downloading';
-- 1224 rows resetados
```

---

## 3. Estado atual (deployed + running)

- **Vercel**: grupos.html + ezapweb.html + fotos.html — auto-deploy no push da `main`
- **Hetzner** (`root@87.99.141.235`, `/opt/ezap/whatsapp-server`): rodando commit do último deploy (ver `git log` na raiz), PM2 online, 18 sessões reconectando em background
- **Supabase photo queue** (na hora do commit 7863b33): 1122 done, 119 no_photo, 6281 failed, 0 pending/downloading/active. Todos os workers ociosos — zero IQs saindo. Este é o estado mais seguro possível pras contas.
- **Lazy fetch agora ativo**: o próximo reconnect NÃO vai re-inundar a fila. Só novos IQs a partir de mensagens reais
- **Photo-worker global**: por padrão ATIVO (não pausado). Botão no grupos.html pode pausar instantaneamente se necessário. Estado persistido em `/opt/ezap/whatsapp-server/data/photo-worker-state.json`

### Saúde das sessões (snapshot anterior — a calibrar quando retomar)
🟢 **Seguras** (sucesso >65%):
- Maylon Clariano 5519997917020 — 95%
- Nicollas Portela 5519980071294 — 74%
- Diego Giudice 5519993341 — 73%
- Mateus Gomes 5519993559206 — 67%
- Rodrigo Zangirolimo 5519990024413 — 67%

🟡 **Médias** (30-65%): Guilherme Donato, Matheus Carrieiro, Vinicius Holanda, Caio Ribeiro, Fábio

🔴 **Quentes — EVITAR por pelo menos 2-4h**:
- **Escalada Ltda 5519993473149 — 5.6%** ⚠️ conta crítica da empresa
- CX2 5519971505209 — 0.07% (quase morta)
- CX 5519971714386 — 6%
- Follow Up 5519986123134 — 4.8%
- Eduardo Gossi (16%), Gabriel Costa (21%), Gustavo Netto (29%), Thomaz Stancioli (27%)

**Proteção automática**: o pre-flight check em `startCreateGroupsJob` bloqueia criar grupos com HTTP 429 se a sessão tem ≥100 timed out nas últimas 2h ou o photo-worker está auto-pausado. As sessões vermelhas se auto-liberam conforme o `last_attempt_at` envelhece.

---

## 4. Pendências ativas

**Nenhuma neste momento.** Todas as 3 frentes que estavam em andamento (lazy fetch, toggle global, painel de temperatura) foram entregues em `27afc70`. Próximos passos ficam a critério do usuário:

### 4.1. (Sugerido) Retry controlado das 6281 fotos em `failed`
Quando o usuário quiser recuperar as fotos que falharam (gradualmente, sem risco), criar um job que:
- Seleciona N rows por hora (ex: 20) por sessão que estiver `🟢` no painel de temperatura
- Reseta pra `pending` com `attempts=0`
- Deixa o photo-worker consumir no ritmo de 60s
- Auto-aborta se `failureStreak` subir rápido
- Ideal como um novo botão "Recuperar fotos falhadas" no painel, com modal de confirmação

### 4.2. (Sugerido) Toggle do photo-worker por sessão
Hoje o toggle é global. Útil ter um botão "pausar só Escalada Ltda" (ou outras contas críticas) mantendo as demais rodando. Implementação: expandir `pauseSession(sessionId, sock, { reason: "manual" })` e expor via rota `POST /api/sync/photo-worker/:sessionId/pause|resume`.

### 4.3. (Sugerido) Dashboard aparece também em admin.html
Hoje o painel de temperatura só vive em `grupos.html`. O usuário pediu "acompanhar permanentemente" — seria interessante embedar o mesmo card (ou uma versão resumida) em `admin.html` pra que ele tenha acesso sem precisar abrir a ferramenta de grupos.

---

## 5. Arquitetura de referência

```
grupos.html              ezapweb.html            admin.html
   │                         │                       │
   │ Bearer admin_token      │ Bearer admin_token    │ Supabase JWT (validate_token RPC)
   ▼                         ▼                       ▼
          whatsapp-server (Hetzner, port 3100, PM2: ezap-whatsapp)
               │
               ├── routes/sessions.js  — GET /api/sessions retorna connectedAt, rateLimitHitAt, photoWorkerHealth
               ├── routes/jobs.js      — POST /api/jobs/create-groups/start → startCreateGroupsJob (pre-flight health)
               ├── routes/sync.js      — GET /api/sync/:id/status usa supaCount (sem cap 1000)
               ├── routes/contacts.js  — GET /api/contacts/:id/chat-photos (usa wa_photo_queue como fonte)
               ├── routes/messages.js  — GET /api/messages/:id/chats (paginado 1000x)
               ├── routes/fotos.js     — upload/delete de avatares de grupo
               ├── services/baileys.js
               │     ├── rateLimitRegistry (Map em memória, 30min cooldown)
               │     ├── waitForGroupCreateBudget (warmup pós-reconexão, drain, hourly cap)
               │     ├── createGroupsFromList (pausa photo-worker, leading delay, budget check)
               │     ├── getQueueFailureStats (conta timed out das últimas 2h)
               │     ├── getSessionMeta (expõe pra rota sessions)
               │     └── markRateLimit (wired no photo-worker via setRateLimitMarker)
               ├── services/jobs.js    — startCreateGroupsJob (pre-flight cooldown + queue health)
               ├── services/photo-worker.js
               │     ├── PHOTO_INTERVAL_MS = 60000 (1 foto/min por sessão)
               │     ├── activeWorkers / pausedWorkers / failureStreaks Maps
               │     ├── pauseSession / resumeSession (por sessão)
               │     ├── processNext — auto-pause on 10 consecutive "Timed Out"
               │     └── getSessionHealth
               └── services/supabase.js — supaRest, supaRpc, supaCount (HEAD+count=exact)
                            │
                            ▼
                     Supabase (xsqpqdjffjqxdcmoytfc)
                     ├── wa_sessions
                     ├── wa_contacts (photo_url legacy)
                     ├── wa_chats (photo_url legacy)
                     ├── wa_photo_queue ← FONTE DA VERDADE pras fotos baixadas
                     ├── wa_group_creations (cap horário consulta aqui)
                     ├── wa_group_links, wa_group_additions
                     └── user_tokens (validate_token RPC — NÃO tocar)
```

---

## 6. Decisões e razões

| Decisão | Por quê |
|---|---|
| Photo-worker: slow 60s, no auto-retry | Usuário OK com drift ao longo de dias, NÃO OK com risco de suspensão |
| Failed rows ficam failed | Retry automático repoke contas que já estão na black list do WhatsApp |
| `wa_photo_queue` como fonte de verdade pra fotos | PATCH em `wa_chats`/`wa_contacts` falha silenciosamente; URL é determinística do path do Storage |
| `rateLimitRegistry` em memória (não Supabase) | Cross-session, cross-reconnect basta; PM2 restart zerar é aceitável |
| Cap horário via `wa_group_creations` no Supabase | Sobrevive PM2 restart, compartilhado entre jobs e workers |
| Pre-flight 2h de janela pra timeouts | Reflete quanto tempo WhatsApp lembra do flag informalmente |
| Cooldown 30min pós-rate-limit explícito | Empírico — tempo pro WhatsApp "esquecer" um 429 explícito |
| Leading delay = baseDelay/2 max 90s | Dá breathing room sem atrasar demais |

---

## 7. Conta crítica: Escalada Ltda 5519993473149

**Tratamento especial**: toda decisão arquitetural deve considerar Escalada primeiro. É o número mais importante da empresa.

Estado atual (a verificar quando retomar):
- 70 done / 1169 failed (5.6% sucesso)
- Último timeout: ~23:55 UTC do dia 2026-04-14
- Pre-flight liberará criar grupos quando `last_attempt_at > 2h`, ou seja ~01:55 UTC do 2026-04-15

**Recomendações para usar Escalada**:
1. Esperar pre-flight liberar naturalmente (NÃO forçar)
2. Primeiro grupo: 1 grupo só, modo manual, delay 180s. Observar
3. Se funcionar, no segundo aumenta pra 2-3 grupos/hora max
4. Nunca retentar failed photos da Escalada em massa
5. Considerar marcar Escalada pra photo-worker ficar desligado permanentemente (via toggle global quando 4.2 for entregue)

---

## 8. Como fazer deploy (IMPORTANTE — Hetzner tem mods locais)

O arquivo `src/index.js` do Hetzner tem **CORS permissivo** e o `package.json` está pinado em **Baileys 6.6.0** (repo tá em 6.7.16). Todo deploy precisa preservar isso:

```bash
# 1. Commit local + push
git add <files>
git commit -m "..."
git push origin main

# 2. Deploy Hetzner preservando mods
ssh -i ~/.ssh/ezap_hetzner root@87.99.141.235 'cd /opt/ezap/whatsapp-server && cp package.json /tmp/pkg.bak && git checkout -- package.json src/index.js && git pull && cp /tmp/pkg.bak package.json && sed -i "s|app.use(cors());|app.use(cors({ origin: \"*\", methods: [\"GET\",\"POST\",\"PATCH\",\"DELETE\",\"OPTIONS\"], allowedHeaders: [\"Content-Type\",\"Authorization\"] }));|" src/index.js && pm2 restart all && sleep 4 && curl -s http://localhost:3100/api/health && echo'
```

Se precisar editar `src/index.js` localmente com mudanças válidas (não-CORS), elas serão puxadas pelo `git pull` após o `git checkout -- src/index.js`. O sed só mexe no `app.use(cors())` original.

### Rodar SQL via Management API

```bash
SQL='{"query": "..."}'
curl -s -X POST "https://api.supabase.com/v1/projects/xsqpqdjffjqxdcmoytfc/database/query" \
  -H "Authorization: Bearer $(grep SUPABASE_MGMT_TOKEN .env | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  -d "$SQL"
```

**Sempre** User-Agent de browser (Cloudflare bloqueia curl/python).

---

## 9. Para a próxima sessão retomar

1. Lê este arquivo
2. `git log --oneline -10` pra confirmar quais commits estão aplicados
3. Checa se os TODOs pendentes em §4 ainda fazem sentido (arquitetura pode ter evoluído)
4. Para retomar o trabalho em §4:
   - Começar por 4.1 (lazy fetch) — é o que elimina a raiz do problema
   - 4.2 (toggle) depende de saber se o lazy fetch já está em produção
   - 4.3 (dashboard) consome as rotas de 4.2 + dados de `getSessionMeta` + `getSessionHealth`
5. Testar manualmente no ezapweb.html se as fotos estão aparecendo (deveria estar — commit 7863b33)
6. **NÃO** mexer em Escalada Ltda sem avisar o usuário antes

---

## 10. Credenciais rápidas (também em CLAUDE.md)

- **Supabase project ref**: `xsqpqdjffjqxdcmoytfc`
- **Management API token**: em `.env` como `SUPABASE_MGMT_TOKEN`
- **Hetzner SSH**: `~/.ssh/ezap_hetzner`
- **PM2 app**: `ezap-whatsapp` (id 0)
- **Health**: `curl http://localhost:3100/api/health`

---

> **Update 2026-04-15 tarde — DHIEGO.AI final 21: fix local para allowlist com LID (ainda nao deployado)**
>
> Diagnostico fechado no runtime do Hetzner:
> - `app_settings.dhiego_ai_session_id` esta apontando para `da47bbe6-c349-49f6-b7cd-50b0283aaabd` (numero final 21, `5519997012821`)
> - as mensagens do Dhiego entram normalmente em `wa_messages`
> - `dhiego_conversations` fica vazio porque o sender chega como `204943038361777@lid`, entao a allowlist por telefone nao bate e o `maybeHandle()` sai antes de salvar a turn
>
> **Implementado localmente neste workspace**:
> - `whatsapp-server/src/services/dhiego-ai.js`
> - resolve sender na ordem: `participantPn` -> `wa_contacts.linked_jid` -> `lid_phone_map.phone` -> fallback `jid`
> - log explicito para `ignoring unauthorized message` com `chatJid`, `senderJid`, `resolvedSenderPhone`, `resolutionSource`, `fromMe`, `isSelfChat`
> - reply em chat `@lid` agora sai para `5511...@s.whatsapp.net` quando o telefone real foi resolvido
> - `whatsapp-server/src/services/baileys.js`
> - persiste `participantPn` em `lid_phone_map`
> - faz upsert de `wa_contacts.linked_jid` no evento `chats.phoneNumberShare`
> - `sendMessage()` agora consulta `resolveLid()`/`lid_phone_map` antes do fallback antigo
> - nova migration `supabase/migration_047_wa_contacts_linked_jid.sql` formaliza a coluna `wa_contacts.linked_jid`
>
> **Status**:
> - patch aplicado localmente
> - validacao pendente/rodando nesta rodada
> - deploy no Hetzner ainda nao executado neste update

---

> **Update 2026-04-15 fim de tarde — ideias: ultima ideia agora prioriza backlog aberto; deletar agora apaga de verdade**
>
> Bug reproduzido no WhatsApp:
> - frase tipo "me lembra da minha ultima ideia" estava caindo em `ideas-list` com `status=all`
> - por isso o bot reapresentava ideia `cancelled` mesmo quando o painel do admin mostrava so a backlog aberta
> - adicionalmente, linguagem natural com verbo "deletar/apagar/remover" estava sendo mapeada para `ideas-cancel`, nao para delete real
>
> **Fix aplicado localmente e deployado no Hetzner**:
> - `whatsapp-server/src/services/dhiego-ai/router.js`
> - nova rota regex `ideas-latest` para "ultima ideia"/"me lembra da minha ultima ideia"
> - separacao semantica: `cancelar` -> `ideas-cancel`; `deletar/apagar/remover/excluir` -> `ideas-delete`
> - prompt do classifier atualizado com as duas tools novas
> - `whatsapp-server/src/services/dhiego-ai/tools/ideas.js`
> - nova tool `latestIdea()` busca primeiro a ideia aberta mais recente; se nao houver nenhuma aberta, faz fallback para a ultima ideia do banco
> - nova tool `deleteIdea()` faz `DELETE` real na `dhiego_ideas`, alinhado com o botao de lixeira do admin
> - `whatsapp-server/src/services/dhiego-ai.js`
> - dispatch atualizado para `ideas-latest` e `ideas-delete`
>
> **Validacao local**:
> - `me lembra da minha ultima ideia` -> `ideas-latest`
> - `deletar ideia 2` -> `ideas-delete`
> - `cancelar ideia 2` -> `ideas-cancel`
>
> **Deploy**:
> - backups remotos: `dhiego-ai.js.bak.20260415_174925`, `router.js.bak.20260415_174925`, `ideas.js.bak.20260415_174925`
> - arquivos copiados pro Hetzner e `pm2 restart ezap-whatsapp` executado
> - observacao: servidor entrou em reconnect wave das sessoes; `da47...` voltou com `status=connected` no DB e ainda estava estabilizando o `live` em memoria no ultimo poll

> **Update 2026-04-15 noite � DHIEGO.AI contextual: estado ativo, follow-ups e smoke test**
>
> Entregue uma segunda camada de interpretacao para o DHIEGO.AI, mais proxima de um assistente com contexto do que de um parser puro de comandos.
>
> **Implementado localmente e deployado no Hetzner**:
> - whatsapp-server/src/services/dhiego-ai/state.js
> - novo estado ativo por (user_id, session_id, chat_jid) com ctive_task, ctive_tool, ocus_idea_id e state_payload
> - fallback em memoria se a tabela do Supabase nao estiver acessivel
> - supabase/migration_048_dhiego_ai_state.sql
> - formaliza a tabela dhiego_ai_state
> - whatsapp-server/src/services/dhiego-ai/router.js
> - separacao entre roteamento explicito, follow-up contextual e classifier LLM
> - follow-ups como manda atualizado, 
ao mostre a cancelada e tualiza para: ... agora usam contexto recente + ideia em foco
> - nova tool ideas-show
> - whatsapp-server/src/services/dhiego-ai/tools/ideas.js
> - novas tools showIdea() e updateIdea(); helpers para buscar ideia por id e ultima aberta
> - whatsapp-server/src/services/dhiego-ai/tools/llm-freeform.js
> - injeta resumo do estado ativo no fallback livre e evita duplicar o turno atual no contexto
> - whatsapp-server/src/services/dhiego-ai.js
> - carrega ecentHistory + ctiveState antes do roteamento e sincroniza o estado apos a resposta
> - whatsapp-server/src/routes/dhiego-ai.js
> - nova rota GET /api/dhiego-ai/state e limpeza do estado junto com DELETE /api/dhiego-ai/conversations
> - whatsapp-server/scripts/dhiego-ai-smoke.js
> - smoke test versionado com frases reais do Dhiego
>
> **Validacao local**:
> - 
ode --check passou para dhiego-ai.js, outer.js, state.js, history.js, ideas.js, llm-freeform.js e rota dhiego-ai.js
> - 
pm run test:dhiego-ai passou com cenarios:
>   - me lembra da minha ultima ideia
>   - deletar ideia 2
>   - tualiza a ideia 3: ...
>   - manda atualizado
>   - 
ao mostre a cancelada
>   - tualiza para: ... com ideia em foco
>   - me lembra dela
>   - como esta a ideia 7
>
> **Deploy**:
> - backup remoto: 20260415_184353
> - arquivos de runtime copiados manualmente pro Hetzner e pm2 restart ezap-whatsapp executado
> - migration  48 aplicada via Supabase Management API depois de contornar o payload do curl com arquivo temporario
> - observacao: o state funciona mesmo se a tabela falhar, mas a migration ja entrou no projeto
