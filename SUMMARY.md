# E-ZAP — Sessão de trabalho 2026-04-14/15

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
