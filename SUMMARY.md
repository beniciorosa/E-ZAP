# E-ZAP — Sessão de trabalho 2026-04-14/15

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
