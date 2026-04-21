# GRUPOS.md — Ferramenta de grupos E-ZAP (grupos.html + backend)

## 📌 Regra obrigatória antes de mexer

Toda sessão que for tocar na ferramenta de grupos (código, comportamento, UI, fluxo) **DEVE**:

1. **LER** a pasta Obsidian `C:\Users\dhiee\OneDrive\Documentos\DHIEGO.AI VAULT\DHIEGO.AI\Projetos A.I\E-ZAP\Grupos\`, na ordem:
   - **`04 - HANDOFF - Próxima sessão.md`** ⭐ primeiro — onde paramos exatamente, configs em produção, riscos conhecidos, checklist obrigatório.
   - `00 - Como funciona hoje (Técnico).md` — referência canônica do fluxo.
   - `03 - CUIDADOS.md` — 13 regras absolutas do "o que NÃO mexer" + diagnósticos.
   - `05 - TAREFAS PENDENTES.md` — backlog priorizado com o que ainda falta.
   - `06 - BANCO DE DADOS.md` — tabelas, triggers, crons, matriz leitura/escrita, SQL de diagnóstico.
   - `_glossário.md` 📖 — consulta pontual quando aparecer termo técnico desconhecido.
2. **ATUALIZAR** os 6 arquivos do Obsidian após qualquer mudança. Incluir data, commit hash, e lição aprendida se for bug fix. Se for concluir tarefa, mover pra seção "✅ Concluídas" em `05 - TAREFAS PENDENTES`.
3. Se a mudança for grande (novo fluxo, refactor), atualizar também `01 - EXPLICAÇÃO LEIGO.md` e `02 - PASSO A PASSO.md`.

Este arquivo (`GRUPOS.md`) é o **changelog técnico cronológico**. O Obsidian é o **estado atual consolidado + documentação pro operador + handoff pra próxima sessão**.

---

Handoff vivo e autossuficiente da área de grupos. Cada rodada de trabalho nessa
ferramenta deve atualizar este arquivo com o que mudou. Para o fluxo geral do
projeto ver [CLAUDE.md](CLAUDE.md) na raiz; para histórico cronológico de
sessões ver [SUMMARY.md](SUMMARY.md). O handoff inicial da ferramenta está em
[.claude/grupos-tool-handoff.md](.claude/grupos-tool-handoff.md) (parcialmente
desatualizado — este documento é a fonte canônica).

---

## 1. O que a ferramenta faz

[grupos.html](grupos.html) é um SPA standalone (~3200 linhas, hospedado no
Vercel junto com admin.html) que opera sobre o whatsapp-server (Hetzner) e o
Supabase. Permite:

1. **Extração de links de convite** em massa de todos os grupos onde uma sessão
   é admin (Baileys `fetchGroupsWithInvites`).
2. **Adicionar um número** (com opção promover a admin) em todos ou num subset
   filtrado de grupos admin.
3. **Criar grupos em massa** a partir de 3 fontes: tickets HubSpot (default),
   XLSX/CSV, Google Sheets.
4. **Auto-criar grupos** a partir de mentorados pendentes (novo modal —
   2026-04-20).
5. **Dashboard de histórico** cross-session com filtros e exportação CSV
   (novo — 2026-04-20).
6. Controle de **temperatura de sessões** + quarentena para prevenir
   rate-limit do WhatsApp.

Todos os jobs rodam em background (in-memory no servidor + cache no Supabase)
— o usuário pode fechar a aba e reabrir depois.

---

## 2. Arquitetura

```
┌─────────────────────┐  HTTPS   ┌───────────────────────┐  Baileys  ┌──────────┐
│  grupos.html        │ ───────→ │  whatsapp-server      │ ────────→ │ WhatsApp │
│  (Vercel)           │  Bearer  │  (PM2, Hetzner :3100) │           │  servers │
└─────────┬───────────┘          └───────────┬───────────┘           └──────────┘
          │                                  │
          │  HTTPS (REST)                    │  REST (service_key)
          └──────────────┬───────────────────┘
                         ▼
                ┌──────────────────────┐
                │  Supabase            │
                │  hubspot_tickets     │◄── webhook HubSpot (Edge Function)
                │  mentorados          │◄── trigger de hubspot_tickets
                │  wa_group_creations  │◄── trigger de mentorados
                │  wa_group_links      │
                │  wa_group_additions  │
                │  wa_sessions         │
                └──────────────────────┘
```

**Stack**:
- **Frontend**: HTML/CSS/JS vanilla, zero frameworks. Push na `main` → Vercel
  deploy automático em ~1min.
- **Backend**: Node.js + Express + Baileys **6.6.0** (Hetzner) — **NÃO fazer
  `npm install` cegamente**, pode atualizar pra 6.7.x e quebrar. PM2 `ezap-whatsapp`.
- **Supabase**: project ref `xsqpqdjffjqxdcmoytfc`.
- **Auth**: Bearer admin token armazenado no localStorage do navegador.

---

## 3. Arquivos críticos

### Frontend

| Arquivo | Áreas principais (file:line) |
|---|---|
| [grupos.html](grupos.html) | **Toolbar** (~215), **Modais**: Nova extração (~243), Adicionar número (~265), Criar grupos (~321), Auto-criar (~465); **View Histórico** (~241); **CSS editable-title + auto-mentor** (~144); **JS core**: `openCreateGroupsModal` (~1903), `buildSpecsFromHubspotResolved` (~2312), `renderHubspotPreview` (~2495), `submitCreateGroupsJob` (~2729), `onTitleEdit`/`onTitleKeydown` (~2495), `openAutoCreateModal`/`renderAutoCreateResults`/`startAutoCreateForMentor`/`startAutoCreateAllSelected`/`buildSpecForPendingTicket` (~2770), `toggleHistoryView`/`loadHistoryRows`/`renderHistoryTableRows`/`exportHistoryCsv`/`formatRelativeTime` (~2940) |

### Backend (whatsapp-server/src/)

| Arquivo | Funções-chave |
|---|---|
| [routes/hubspot.js](whatsapp-server/src/routes/hubspot.js) | `POST /resolve-tickets` (34 — lê de hubspot_tickets), `GET /pending-groups` (188), `GET /group-history` (cross-session, 278), `GET /group-history/:sessionId` (~368, legado), `POST|GET /templates/:sessionId` (welcome editável), `POST /calls-today/refresh`, `POST /calls-week/refresh`, `GET /calls` |
| [routes/jobs.js](whatsapp-server/src/routes/jobs.js) | `POST /api/jobs/extract/start`, `POST /api/jobs/add/start`, `POST /api/jobs/create-groups/start`, `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel` |
| [routes/sessions.js](whatsapp-server/src/routes/sessions.js) | `/list-admin-groups`, `/import-cache`, `/groups`, quarentena (POST/GET/DELETE) |
| [services/baileys.js](whatsapp-server/src/services/baileys.js) | `createGroupsFromList` (~1958), `fetchGroupsWithInvites`, `addParticipantToAllGroups`, `quarantineSession`/`releaseSession`/`isQuarantined`, `applyCriticalSessionOverrides` (~1944 — forçar 10min/hourlyCap=3 pra Escalada) |
| [services/jobs.js](whatsapp-server/src/services/jobs.js) | `startCreateGroupsJob`, `startExtractJob`, `startAddJob`, `runCreateGroupsWorker` (dedup via spec_hash em `wa_group_creations`) |
| [services/hubspot-api.js](whatsapp-server/src/services/hubspot-api.js) | `fetchTicketFromApi` (expõe owner_{id,name,email}), `upsertMentorado`, `upsertHubspotTicket` (novo — fallback persiste na tabela canônica) |
| [services/supabase.js](whatsapp-server/src/services/supabase.js) | `supaRest`, `expandPhonesToJids`, `pickPrimaryJid`, `fetchChatNamesBatch` |

### Supabase migrations

| Migration | O que cria |
|---|---|
| [034](supabase/migration_034_wa_group_tools.sql) | `wa_group_links`, `wa_group_additions` |
| [035](supabase/migration_035_mentorados.sql) | `mentorados` (legacy, alimentada via trigger hoje) |
| [041](supabase/migration_041_wa_group_creations.sql) | `wa_group_creations` (spec_hash UNIQUE, dedup) |
| [053](supabase/migration_053_wa_group_creations_hubspot.sql) | Enriquece `wa_group_creations` com `hubspot_*` + trigger `trg_sync_mentorados_to_group_creations` |
| [054](supabase/migration_054_hubspot_tickets.sql) | `hubspot_tickets` (espelho completo HubSpot) + view `v_ticket_full` + trigger `sync_hubspot_tickets_to_mentorados` |

---

## 4. Tabelas usadas

### `hubspot_tickets` (fonte canônica HubSpot)
Espelho completo via webhook Edge Function [supabase/functions/hubspot-tickets/index.ts](supabase/functions/hubspot-tickets/index.ts). Colunas-chave pros grupos: `ticket_id`, `ticket_name`, `owner_id/name/email`, `mentor_responsavel_id/name`, `whatsapp_do_mentorado`, `tier` (string), `pipeline_stage_name`, `pipeline_type`, `status_ticket`, `synced_from`.

### `mentorados` (LEGACY — ainda atualizada via trigger de `hubspot_tickets`)
Subset de `hubspot_tickets` mantido por `sync_hubspot_tickets_to_mentorados()`. Colunas: `ticket_id` UNIQUE, `ticket_name`, `mentor_responsavel`, `whatsapp_do_mentorado`, tier booleans (`mentoria_{starter,pro,business}`), pipeline_*. **A ferramenta de grupos NÃO lê mais dessa tabela desde 2026-04-20** — lê direto de `hubspot_tickets`. Mantida pra consumers legados.

### `wa_group_creations` (jobs de criação em massa)
`source_session_id` FK wa_sessions, `spec_hash` UNIQUE (dedup), `group_name`/`group_jid`, `status` (created/failed/rate_limited/cancelled/pending), `members_added/total`, flags, `invite_link`, `hubspot_ticket_id`, `hubspot_ticket_name`, `hubspot_mentor`, `hubspot_tier`, `hubspot_pipeline_*`, `hubspot_last_synced_at`, `client_phone`, `mentor_session_id/phone`. Trigger `trg_sync_mentorados_to_group_creations` propaga mudanças de `mentorados` pra esta tabela (mas **não mexe em `group_name`** — edição inline fica preservada).

### `wa_group_links` (cache de invites)
Populada por `fetchGroupsWithInvites`. `session_id`+`group_jid` UNIQUE. Campos: `invite_link`, `invite_error`, `is_admin`, `participants_count`, `extracted_at`.

### `wa_group_additions` (bulk add history)
`source_session_id`+`target_phone`+`group_jid` UNIQUE. Campos: `status` (added/already_member/already_admin/privacy_block/etc), `was_promoted`.

### `wa_sessions`
Sessões Baileys conectadas. O `label` bate literal com `mentor_responsavel_name` do HubSpot (ex: "Rodrigo Zangirolimo") — é o que permite auto-map de mentor → sessão sem nova tabela.

### Outras usadas pra fallbacks
- `wa_photo_queue` (fila de fotos, `get_sync_status_all()` batch)
- `wa_chats`, `wa_contacts`, `group_members`, `lid_phone_map` (resolver nomes/membros)

---

## 5. Cadeia de sincronização HubSpot → wa_group_creations

```
Webhook HubSpot → Edge Function hubspot-tickets
                          │
                          ▼
                 UPSERT hubspot_tickets
                          │
                  trigger sync_hubspot_tickets_to_mentorados
                          │
                          ▼
                    UPSERT mentorados
                          │
                  trigger trg_sync_mentorados_to_group_creations
                          │
                          ▼
     UPDATE wa_group_creations WHERE hubspot_ticket_id = NEW.ticket_id
     SET hubspot_ticket_name, hubspot_mentor, hubspot_tier,
         hubspot_pipeline_*, client_phone (se NULL),
         hubspot_last_synced_at = NOW()
     — NÃO mexe em group_name nem em nada operacional (status, invite_link).
```

Implicação prática: grupos criados ficam com dados HubSpot sempre frescos
automaticamente. O Dashboard de histórico mostra `hubspot_last_synced_at`
como indicador de freshness.

---

## 6. Fluxos típicos

### 6.1 Criar grupos via tickets HubSpot (modo default)
1. Toolbar → **+ Criar grupos** → modal abre na tab "🎫 Tickets HubSpot" (default).
2. Colar URLs ou IDs de tickets (até 200) → **🔍 Resolver tickets**.
3. Frontend chama `POST /api/hubspot/resolve-tickets`. Backend: query em `hubspot_tickets` + fallback HubSpot API (se ticket missing) + upsert em `hubspot_tickets` AND `mentorados`. Retorna shape com `ticket_owner`, `tier`, `mentorSessionId`, etc.
4. Preview (`renderHubspotPreview`) mostra tabela com cliente/mentor/tier/foto/status. Expandir row permite **editar título inline** (contenteditable). Helpers checkbox (CX2 etc) entra em todos os grupos.
5. Dhiego escolhe sessão criadora, ajusta welcome (textarea `#hubspotCustomWelcome`), delay, clica "Iniciar criação".
6. `submitCreateGroupsJob` → `POST /api/jobs/create-groups/start` → backend pega cached creations via `getCachedGroupCreations(sessionId)`, dedup por `spec_hash`, chama `baileys.createGroupsFromList` → job card aparece com polling de 5s.

### 6.2 Auto-criar grupos (mentorados pendentes — 2026-04-20)
1. Toolbar → **🤖 Auto-criar grupos** → modal abre.
2. Filtros opcionais (tier, pipeline_type) → **🔍 Buscar pendentes**.
3. `GET /api/hubspot/pending-groups?tier=...&pipeline_type=...` retorna tickets com tier preenchido que NÃO têm row `status='created'` em wa_group_creations, agrupados por `owner_name` com auto-map de sessão.
4. Accordion expansível por mentor, cada um com: tabela de tickets (checkbox default on), welcome + rejectDm editáveis POR mentor, botão "▶ Iniciar só {mentor}".
5. **Iniciar só {mentor}**: monta specs via `buildSpecForPendingTicket`, POST único pro backend → 1 job.
6. **Iniciar todos selecionados**: `Promise.all` dispara N POSTs em paralelo, um por mentor. Cada job vai rodar independentemente pq cada mentor usa uma sessão distinta.

### 6.3 Criar grupos via XLSX/CSV/Google Sheets
Modal de criar → mudar tab. Parse local com XLSX.js ou Papa.parse. Normalização via `normalizeCreateSpec` (expect columns: "Nome do Grupo", "Descrição", "Foto URL", "Membros", "Apenas Admin Edita Info", "Mensagem de Boas-Vindas"). Resto do pipeline é igual ao HubSpot.

### 6.4 Extrair links / Adicionar número
Modal separado, 1 sessão alvo, delay configurável, cards de job com ETA + barra de progresso + tabela colapsável de resultados. Cache em `wa_group_links` / `wa_group_additions`. Detalhes em [.claude/grupos-tool-handoff.md](.claude/grupos-tool-handoff.md).

### 6.5 Consultar Dashboard de histórico
Toolbar → **📊 Histórico**. Filtros (from/to, mentor ilike, tier, status, sessão). `GET /api/hubspot/group-history` com JOIN on-the-fly em `hubspot_tickets` (pra owner_name) + `wa_sessions` (pra label). Tabela 11 colunas incluindo "Sincronizado" (há Xh). Exportar CSV com BOM UTF-8 (Excel-friendly).

---

## 7. Proteções contra rate-limit

O WhatsApp banimento de grupos é o risco #1. Protecões em camadas:

1. **Quarentena por sessão** (`quarantineSession`): "modo avião" — photo-worker parado, handlers pulam `sock.groupMetadata`, rotas HTTP retornam 409. Auto-entra em `createGroupsFromList` e **fica ativa se rate-limited** até liberação manual.
2. **Overrides críticos** (`applyCriticalSessionOverrides`, [baileys.js:~1944](whatsapp-server/src/services/baileys.js:1944)): forçam `delaySec≥600`, `hourlyCap=3`, `leadingDelayMs=120000` para sessões em `CRITICAL_PHONES` (hoje só Escalada 5519993473149) OU com `failureStreak≥5` OU `timedOut≥50`.
3. **Pre-flight check**: bloqueia criar grupos com HTTP 429 se `timedOut≥100` nas últimas 2h ou photo-worker auto-pausado.
4. **Hourly cap**: `GROUP_CREATE_HOURLY_CAP` env var (default 6/h, forçado 3/h pra Escalada).
5. **Painel de temperatura** (grupos.html): `loadSessions` batch via `GET /api/sync/status-all`, classificação 🟢🟡🔴 por sessão, badges de streak, botões Quarentena/Liberar.

---

## 8. Deploy

### Frontend (grupos.html)
```
git add grupos.html && git commit -m "..." && git push origin main
# Vercel publica em ~1min automaticamente.
```

### Backend (whatsapp-server/)
**Atenção — o Hetzner tem 2 modificações locais que NÃO estão no git e precisam
ser preservadas a cada deploy:**
1. CORS em `src/index.js`: `app.use(cors({ origin: "*", methods: [...], allowedHeaders: [...] }))` em vez do `app.use(cors())` do repo.
2. `package.json` com Baileys **6.6.0** (repo tem 6.7.16 — não upgrade cego).

Deploy pattern (preservando ambos):

```bash
ssh -i ~/.ssh/ezap_hetzner root@87.99.141.235 \
  'set -eo pipefail; cd /opt/ezap/whatsapp-server && \
   cp package.json /tmp/pkg.bak && \
   git checkout -- package.json src/index.js && \
   git pull --ff-only && \
   cp /tmp/pkg.bak package.json && \
   sed -i "s|app.use(cors());|app.use(cors({ origin: \"*\", methods: [\"GET\",\"POST\",\"PATCH\",\"DELETE\",\"OPTIONS\"], allowedHeaders: [\"Content-Type\",\"Authorization\"] }));|" src/index.js && \
   node --check src/routes/hubspot.js && node --check src/services/hubspot-api.js && node --check src/index.js && \
   pm2 restart ezap-whatsapp && sleep 3 && \
   curl -s http://localhost:3100/api/health'
```

### Pegadinhas de deploy já encontradas
- **`git pull 2>&1 | tail -10` mascara exit code** — o status do pipeline é o do `tail`, não do `pull`. Usar `set -o pipefail` ou deixar o output do pull direto.
- **Arquivos untracked conflitantes**: se o repo incluir arquivos que já existem como untracked no Hetzner (ex: fotos PNGs), `git pull` aborta. Fazer backup em `/tmp/` + `rm` antes do pull.
- **Validar sintaxe ANTES do pm2 restart** — `node --check` pega erros de syntax; rodar em TODO arquivo modificado do backend.

---

## 9. Rollback

- **Frontend**: `git revert <hash>` + push → Vercel reverte em ~1min.
- **Backend**: `git revert <hash>` no Hetzner + `pm2 restart ezap-whatsapp`. Jobs in-memory se perdem, mas o cache Supabase preserva o progresso (user clica "Nova extração" e retoma).
- **Runtime sem redeploy** (p/ quarentena): `POST /api/sessions/:id/quarantine/release` + (se necessário) `pm2 restart`.

---

## 10. Changelog

### 2026-04-21 noite-final — commit `67de8e1` — PR 2 contador real de IQ via monkey-patch

Implementa #1 e #2 do plano original (pós-PR1 do mesmo dia):

**Backend** — `whatsapp-server/src/services/iq-counter.js` (novo):
- Map<sessionId, {iqByType, total, events sliding window 1h, firstAt, lastAt, label, phone}>
- `recordIq(sessionId, type)`: increment + trim window 1h
- `classifyIqNode(node)`: classifica IQ pela `xmlns` + first-child tag. Tipos: `groupCreate`, `groupParticipantsUpdate`, `groupInviteCode`, `groupMetadata`, `groupUpdate{Description,Subject}`, `groupSetting{Lock,Announcement}`, `groupMemberAddMode`, `groupPicture`, `onWhatsApp`, `profilePictureUrl`, `businessProfile`, `presenceSubscribe`, `passive`, `iq:<xmlns>`, `iq_unknown`
- `attachToSock(sessionId, sock)`: monkey-patch `sock.query` preservando `this` + spread args + try/catch defensivo. Flag `__iqCounterPatched` evita patch duplo em reconnect.
- `startSnapshotLoop(logEventFn)`: setInterval 5min, emite `iq:snapshot` event pra cada sessão com atividade na última hora.

**baileys.js**:
- Importa iq-counter
- `attachToSock(sessionId, sock)` logo após `makeWASocket` retornar
- `setMeta(sessionId, label, phone)` no `connection === "open"` handler
- Incluído `iqStats` no metadata de `group_create:success/failed/rate_limit` — chave pra correlacionar rate-limit com contagem real de IQs no momento

**routes/sessions.js**:
- `GET /api/sessions/iq-stats-all` (definida ANTES de `/:id` pra não ser capturada)
- `GET /api/sessions/:id/iq-stats`

**index.js**:
- `iqCounter.startSnapshotLoop(activityLog.logEvent)` após `setIO`

**Frontend (`grupos.html`)**:
- `_sessionIqStats` Map + `loadSessionIqStats()` polling 30s visibility-aware
- Badge ⚡ "N/h" em cada card de sessão — cor por intensidade: <30 cinza, 30-60 amarelo, 60+ vermelho
- Tooltip com top 3 tipos de IQ + total acumulado
- Filtro de sidebar `⚡ IQ snapshots` + emoji ⚡ no renderActivityLog

**Risco**: monkey-patch é ponto de falha. Mitigado com try/catch defensivo (Baileys nunca quebra se algo der errado no patch). Rollback: `git revert 67de8e1` + pm2 restart.

### 2026-04-21 noite — commits `c47fbb7` + `f990e36` — PR1 log enriquecido + transient_drop distinto

Melhoria de observabilidade em cima do activity log implementado mais cedo (`7868853`).

**Enriquecimentos:**
- **Latência por step**: `_stepDurations` em cada step do `createGroupsFromList` (groupCreate, inviteCode, description, photo, memberAddMode, lock, adminAddPromote, welcome, altWelcome, dmClient, dmCx2, dmEscalada). Incluído em `metadata.stepDurations` de `group_create:success/failed` → permite análise "photo sempre demora 3s?" ou spot outliers.
- **DMs como eventos separados**: `dm:sent:client | :cx2 | :escalada` e `dm:failed:*`. Antes estava embedded no metadata do `group_create:success`. Agora cada DM tem evento próprio filtrável no sidebar.
- **Welcome como evento**: `welcome:sent | :alt_sent | :failed`. Antes só boolean no metadata.
- **Stream error capture**: listener em `connection.update` classifica close events:
  - Critical (vermelho): `device_removed`, `loggedOut`, `rate-overlimit`, 403 → `wa:stream_error`
  - Transient (info/amarelo, reconecta automaticamente): 503, 500, 408, 428, `Connection Closed`, `restart_required`, `connectionLost` → `session:transient_drop`
  - Generic: `session:disconnected`
- **Reconnect**: `session:reconnected` quando connection volta após `reconnectAttempts > 0`. Fecha ciclo visual: `transient_drop → reconnected`.
- **Retenção eterna**: cron cleanup 30d DESATIVADO. Volume ~450MB/ano comporta 10-18 anos em Supabase SMALL.
- **Auto-criar grupos DESATIVADO**: botão disabled + tooltip "🚧 Em manutenção" até ser re-investigado.

**Arquivos**: [baileys.js](whatsapp-server/src/services/baileys.js), [grupos.html](grupos.html), [index.js](whatsapp-server/src/index.js).

### 2026-04-21 tarde — commits `7868853` + `29dcd63` + `12697dd` — Activity log + sidebar real-time

Tabela unificada `activity_events` (migration 062) + service `activity-log.js` + sidebar colapsável em grupos.html + endpoints `/api/activity` e `/api/activity/insights` + cron cleanup diário (depois desativado).

- Shape: `{event_type, level, session_*, job_id, group_*, message, metadata}`. Coluna `day` generated em America/Sao_Paulo.
- Socket.io canal `activity:event` emit a cada `logEvent` call.
- Sidebar: header com insights de ontem, filtros (dia/tipo/level), lista rolável 500 eventos.
- Instrumentação inicial: group_create:*, group_create_job:*, session:quarantine_*, resolve_tickets, phone_validation:*.

### 2026-04-21 tarde — commit `eb3b037` — VCard self-chat

Feature pra mentor salvar clientes na agenda ANTES de criar grupos (elimina `bad-request`).

- Migration 063: `vcard_sent_registry` (UNIQUE mentor+phone).
- Nova rota `POST /api/vcard/send-batch` — envia mensagem de texto com "Nome | +55 DD 9XXXX-XXXX" pro self-chat de cada mentor (`sock.sendMessage(sock.user.id, {text})`).
- WhatsApp auto-detecta número como link → mentor toca → "Adicionar aos contatos".
- `/resolve-tickets` enriquecido com `vcardAlreadySent` flag (consulta `vcard_sent_registry`).
- Frontend: botão 📇 na toolbar + modal com resolve + preview agrupado por mentor + envio com activity log events.

Motivo de não ser vCard real: WhatsApp não permite compartilhar contato que o remetente ainda não tem na agenda.

### 2026-04-21 — commit `2403111` — onWhatsApp batch + multi-templates

- `/resolve-tickets` faz batch `sock.onWhatsApp(...phones)` em sessão doadora (CX2 > Escalada) antes de retornar. 1-2 IQs por lote total, independente do tamanho. Zero IQ adicional na criadora.
- Trata 9 BR automático: se número original não existe, tenta variante com/sem "9" após DDD.
- Response: `resolvedClientJid` + `clientValidation` ("ok"/"adjusted_no_9"/"not_on_whatsapp"/"no_validator"/"not_validated").
- Frontend: auto-força `includeClient=false` quando not_on_whatsapp.
- Multi-templates: `app_settings.hubspot_templates_{sessionId}` vira `{templates: [{id, name, isDefault, fields...}]}`. UI com dropdown + Salvar como + Default + Deletar.

### 2026-04-21 — commit `0001fbf` — Modo convite + jitter configurável + members_list + UI
Contexto: Matheus Carrieiro bateu rate-limit em 92s logo no 1º grupo mesmo nunca tendo batido antes. Diagnóstico: conta "fria" (só 2 grupos em 5 dias) + provável falta de contato mútuo entre criador e clientes. Solução: permitir que o usuário decida QUEM entra via `groupCreate` e quem recebe DM com invite link — minimiza "IQ signal" pro WhatsApp quando a conta criadora está sensível.

**Modo convite (3 checkboxes no modal):**
- `includeCx2` / `includeEscalada` / `includeClient` — default todos ON (comportamento antigo preservado).
- Quando OFF: membro não entra via groupCreate, recebe DM com invite link do criador.
- Caso extremo (todos OFF): só o criador (mentor) fica no grupo; cliente + CX2 + Escalada recebem DM.
- 2 templates novos em `#hubspotRejectDmMessage` (cliente) e `#hubspotHelperDmMessage` (helpers). Placeholders: `{primeiro_nome}`, `{nome_grupo}`, `{link}`, `{cliente_nome}`, `{mentor}`.
- Alt welcome no grupo agora lista quem faltou entrar + inclui o WhatsApp do mentor pra contato direto.
- Backend: `spec.includeCx2/Escalada/Client` + `spec.inviteDmClientTemplate/inviteDmHelperTemplate`. DMs enviadas entre Step 2 (invite link) e Step 3 (cliente). `row.cx2DmSent` / `row.escaladaDmSent` populados em runtime.

**Jitter configurável:**
- Novos campos "entre X e Y min a mais" no modal (range 0-60 min). Default 0/0.
- Backend: se `jitterMinSec/MaxSec` > 0, usa range positivo. Senão, preserva ±30s legado.
- Quebra padrão robótico (22:13, 24:55, 23:41… em vez de 20:00 fixo).

**Custom delay em minutos:** input `#createDelayCustom` agora é minutos (1-1440), não segundos. Conversão `* 60` no frontend antes de mandar pro backend.

**Members list (DB + UI):**
- Migration 061: `wa_group_creations.members_list JSONB`. Shape: `[{role, phone, name, in_group, dm_sent}]`. Roles: `client|mentor|cx2|escalada|helper`.
- Backend popula automaticamente no `createGroupsFromList` após welcome. `upsertGroupCreation` + `getCachedGroupCreations` levam/trazem a coluna.
- 3 colunas novas na tabela de resultados: **DM Cli / DM CX2 / DM Esc** (✓ enviado, ✗ falhou, — N/A entrou direto). Ler do cache via helper `extractDmStatus(membersList, role)` em [jobs.js](whatsapp-server/src/services/jobs.js).

**Templates endpoint:** `POST /api/hubspot/templates/:sessionId` agora aceita campo `helperDm` além dos 3 existentes (backward compat: key ausente = string vazia).

**Modal UI:**
- Scroll horizontal removido (`overflow-x:hidden` + `box-sizing:border-box` global dentro do modal).
- Scroll vertical estilizado (thumb discreto combinando com tema dark, `::-webkit-scrollbar` + `scrollbar-width:thin` + `scrollbar-color`).
- Width 720 → 820px pra caber inputs novos.

### 2026-04-20 noite-8 — commit `5c058b0` — Pausar + ajustar delay + retomar (frontend-only)
Reportado por Dhiego em produção: 2 sessões (Maylon Clariano e Thomaz Stancioli) bateram rate-limit com delay de 20 min entre grupos (Maylon no 3°, Thomaz no 4°). Pedido: poder pausar um job, mudar o delay (ex: pra 1 hora) e retomar de onde parou.

- **Frontend-only** ([grupos.html](grupos.html)) — zero backend change, zero pm2 restart. Reusa toda a infra existente (cancel + cache via `specHash`).
- Botão "Interromper" vira "⏸ Pausar" só pra jobs `create-groups` (mensagem de confirmação adaptada). Internamente segue chamando `POST /api/jobs/:id/cancel`.
- Em jobs `create-groups` com status `cancelled` / `rate_limited` / `error`, o botão "Tentar novamente" agora vem precedido de um **input editável de delay (em min)** + botão "▶️ Retomar". Default = `job.config.delaySec / 60`. Range visual 1-30 (matches backend clamp em [baileys.js:2053](whatsapp-server/src/services/baileys.js:2053)).
- Nova função `resumeCreateGroupsJob(jobId)` lê o input, valida (clampa em 30 com warning) e chama `retryFailedJob(jobId, minutes * 60)`.
- `retryFailedJob` ganha 2º parâmetro `delaySecOverride` opcional — se passado, sobrescreve `job.config.delaySec` na chamada `POST /api/jobs/create-groups/start`.
- Mensagens dos status `rate_limited` e `cancelled` (só create-groups) reescritas pra apontar pro fluxo "ajuste o delay → Retomar".
- Cap atual: 30 min máx (clamp do backend). Pra liberar até 60 min como Dhiego pediu, futura sessão precisa: `Math.min(1800, …)` → `Math.min(3600, …)` em [baileys.js:2053](whatsapp-server/src/services/baileys.js:2053) + pm2 restart.

### 2026-04-20 noite-7 — commit `c655cea` — 4 fixes: bad-request fallback + transient retry + cancel + UI pendente
Observados em produção 20/04 noite (lotes Diego Giudice + Eduardo Gossi + Mateus Gomes):

- **Problema 1 — `bad-request` no `groupCreate`** quando seed member (cliente) não está nos contatos do mentor criador. Confirmado via query `wa_contacts`: Andrei, Franciele, Marlie **não estão** nos contatos dos respectivos mentores → bad-request. Vitor, Rodrigo RGB, Ricardo (que **estão** nos contatos) → OK.
  - Fix: catch no `groupCreate` detecta `bad-request` ou `statusCode === 400`, faz segundo `groupCreate` com `memberJids.filter(j => j !== clientJid)`. Se OK: `clientRejected = true` + `clientWasSkipped = true` → Step 3 envia DM com link + Step 10 envia alt message no grupo.

- **Problema 2 — Connection Closed em cascata nos Steps 2-7** derrubava desc/foto/lock/invite_link/Escalada admin. Só welcome (Step 10) sobrevivia porque tinha `callWithTransientRetry`.
  - Fix: todos os Steps 2-7 envolvidos em `callWithTransientRetry(sessionId, fn, {label})` — 3 tentativas (15s/20s/25s) aguardando `waitForSessionConnected(30000)`. Só não retenta rate-limit nem loggedOut.

- **Problema 3 — Botão Interromper não funcionava durante delay** entre grupos. `setTimeout(baseDelayMs + jitter)` não checava `shouldCancel`.
  - Fix: delay entre grupos agora usa `waitWithHeartbeat(..., {shouldCancel})` que checa em slices. Cancel imediato durante sleep.

- **Problema 4 — Grupos pendentes invisíveis na UI** até serem processados.
  - Fix backend: `GET /api/jobs/:jobId` expõe `pendingSpecs` (derivado de `job._specs` vs `job.results`) + `job.progress.currentSpecHash`/`currentSpecName` via novo evento `onProgress({phase: "processing_spec"})`.
  - Fix frontend: `renderCreateGroupsResultsTable` monta 3 grupos de rows (processados | atual ⏳ Pendente com spinner | aguardando ⏸ opacity 0.55). Tabela mostra todos os N grupos desde o submit.

### 2026-04-20 noite-6 — commit `84017d0` — Members fixos (CX2 + Escalada) substituem checklist de helpers
Validado em produção com Diego Giudice (20/04 noite): 1 grupo criado, welcome enviado, zero disconnect. Estado considerado **estável**.

- Checklist `#helperSessionsChecklist` e checkbox Escalada-admin REMOVIDOS da UI. Em seu lugar: `#hubspotFixedMembersBox` read-only listando os 4 members esperados + warning vermelho se CX2 ou Escalada estiverem offline.
- `buildSpecsFromHubspotResolved` resolve CX2 (`5519971505209`) → `helperSessionIds = [cx2Session.id]` e Escalada (`5519993473149`) → `adminSessionIds = [escaladaSession.id]`. Ambos via match por `phone` em `_sessions` com `status="connected"`.
- `buildSpecForPendingTicket` (Auto-criar) idem.
- Checkbox `#hubspotAddEscaladaAdmin` preservado como `<input type="hidden" checked>` pra não quebrar `onHelperChecklistChange` legado.
- Racional (pedido Dhiego): blindar fluxo contra regressão do `device_removed` — sem checklist arbitrário, ninguém marca por engano uma sessão com LID em `wa_sessions.phone`.
- **Auto-criar** ainda não funciona (separado). Fluxo HubSpot manual é o estável.

### 2026-04-20 noite-5 — commit `0d5214f` — ROLLBACK do refactor cliente-primeiro (root cause = device_removed)
Root cause identificado nos logs: `node:{tag:"stream:error",attrs:{code:"401"},content:[{tag:"conflict",attrs:{type:"device_removed"}}]}`. O WhatsApp estava removendo linked devices porque o pattern "groupCreate([cliente]) + batch add helpers via groupParticipantsUpdate" — introduzido no `a4d8878` — parecia automação/spam. **Não era LID nem rate-limit**. O LID aparecia nos `status_message` apenas porque era o último helper sendo adicionado quando o socket já estava sendo morto pelo WhatsApp — red herring.

**Fix**: volta ao pattern original pré-`a4d8878`:
- `groupCreate(name, [cliente, mentor, helpers])` — TODOS de uma vez, 1 IQ orgânico.
- Rejeitados por privacy (403) detectados individualmente em `created.participants` — Baileys reporta por JID sem matar o socket.
- Cliente rejeitado no fluxo HubSpot → DM com invite link (Step 3, preservado).
- Admin extra (Escalada) continua em add+promote separado — pattern sempre aceito.
- **Step 8 (batch add helpers) REMOVIDO inteiro** — era o vilão.
- Welcome no final com branch alt/normal (inalterado).

**Preservados (fixes legítimos)**: `stopSession.removeAllListeners`, `callWithTransientRetry`, `resolveSessionToJid` (usado agora pra MONTAR a lista do `groupCreate`), `isLikelyLid` (filtro preventivo pre-create pra reduzir noise).

**Também**: `jobs.js` pre-populate agora copia `r.created_at` → `createdAt` no `job.results`. Job card "Criado em" mostra data pra grupos em cache também (não só os da rodada atual).

### 2026-04-20 noite-4 — commit `105ea6b` — Helpers/admins como session_id (refactor definitivo)
Depois do `ed051bd` (que filtrava LIDs via heurística), veio o refactor arquitetural: helpers e admins agora trafegam como `session_id` em vez de phone cru. Elimina a origem do bug, não só sintoma.

- **Frontend**: o checklist de helpers já tinha `data-session-id` (grupos.html:2220); agora `buildSpecsFromHubspotResolved` coleta e envia `spec.helperSessionIds` + `spec.adminSessionIds` (via `escaladaSession.id` quando Escalada conectada). Fallback pra `spec.adminJids` legado se Escalada offline. Mentor do ticket entra automaticamente em `helperSessionIds` quando a sessão criadora é outra. `buildSpecForPendingTicket` (Auto-criar) idem.
- **Backend** ([baileys.js](whatsapp-server/src/services/baileys.js)):
  - Novo `resolveSessionToJid(sessionId)`: lê `sessions.get(sid).sock.user.id`, extrai dígitos BR (10-13), retorna `{digits}@s.whatsapp.net` ou null.
  - `createGroupsFromList` resolve `spec.helperSessionIds` e `spec.adminSessionIds` no início do loop em `resolvedHelperJids` e `resolvedAdminJids` com dedupe.
  - Step 7 (admins) prefere `resolvedAdminJids`; fallback `spec.adminJids`.
  - Step 8 (helpers) prefere `resolvedHelperJids` — passa direto ao `groupParticipantsUpdate` sem `validateMembersForCreate` (JID já é canônico). Fallback phone-based preservado pro fluxo XLSX.
  - `membersTotal` conta `helperSessionIds`+`adminSessionIds` quando presentes.
- **Vantagens sobre phone-based**: fonte da verdade vira `sock.user.id` runtime, não `wa_sessions.phone` DB. Funciona mesmo se o phone do DB estiver com LID salvo. Sessão disconnected é silenciosamente pulada (null do resolve) em vez de matar socket. O `isLikelyLid` vira defense-in-depth no path phone-based só.

### 2026-04-20 noite-3 — commit `ed051bd` — Filtro LOCAL de LID + fallback seguro
`6cf308d` não fechou o LID-kill porque `sock.onWhatsApp` retorna `exists: true` pra LIDs que estão no contact store da sessão (history sync trouxe). Resultado: LID passava pelo `validateMembersForCreate`, virava `{digits}@s.whatsapp.net`, WhatsApp derrubava socket com loggedOut, welcome caía em "Sessão não disponível". Caso em prod: Luis Antonio Lopes | Guilherme Donato (18:03).

- Novo helper `isLikelyLid(phoneOrDigits)` próximo a `isRateLimitError` — rejeita dígitos fora do range BR (10-13). Filtro LOCAL, sem depender do contact store.
- `validateMembersForCreate` ([baileys.js:2438](whatsapp-server/src/services/baileys.js:2438)) agora: (1) filtra LIDs localmente ANTES do `onWhatsApp`; (2) rejeita jids retornados que terminam em `@lid`; (3) fallback em exception retorna `[]` (em vez de build cego com `@s.whatsapp.net`).
- Step 8 agora reporta os dígitos exatos skipados em `status_message` (ex: `helpers_skipped_invalid: 194051538174167`) + log no PM2.
- Trade-off documentado: helpers LID/inválidos ficam de fora do grupo (user vê a lista skipada) mas o socket sobrevive e o welcome é enviado.

### 2026-04-20 noite-2 — commit `6cf308d` — 4 fixes no createGroupsFromList (welcome não enviava)
**Regressão do commit `a4d8878`**: Step 8 (batch add helpers) passava dígitos direto como `{digits}@s.whatsapp.net` pro `groupParticipantsUpdate`. Se algum member era um LID (14-15 dígitos não-BR como `65816548667409`), WhatsApp derrubava o socket com loggedOut 401 — quebrando welcome de TODOS os grupos seguintes. Observado em Aline/Priscila/Amanda (20/04 tarde).

- **Fase 1**: `stopSession` ([baileys.js:2494](whatsapp-server/src/services/baileys.js:2494)) agora chama `sock.ev.removeAllListeners()` ANTES de `sock.end()`. Impede eventos async tardios (connection.update loggedOut, creds.update com creds velhas) de contaminar sessões novas startadas depois. Era o root cause do QR não aparecer após fresh-qr e de 401 mid-job.
- **Fase 2**: `membersTotal` agora inclui `spec.adminJids.length + 1` (owner). Corrige UI "4/3" — bate com o critério usado em `membersAdded`.
- **Fase 3** (FIX PRINCIPAL): Step 8 (linha ~2270) agora filtra os helpers via `validateMembersForCreate(sock, extraPhones)` antes do `groupParticipantsUpdate`. LIDs e números fora do WhatsApp são descartados (reportados em `helpers_skipped_invalid: N`). Elimina a stanza malformada → socket sobrevive → welcome funciona.
- **Fase 4**: `sendMessage` do welcome (normal e alt) envolto em `callWithTransientRetry(sessionId, fn, {label})` — defensivo pra disconnects transientes entre groupCreate e welcome.

### 2026-04-20 noite — commit `3eb1870` — Retry/Delete por linha no Dashboard + fix CSS inputs de data
- Novo endpoint `POST /api/hubspot/group-creation/:id/retry` — reconstrói spec a partir da row persistida (`group_name`, `client_phone`, `hubspot_tier`, `mentor_session_phone`) + fire-and-forget `createGroupsFromList` com `specHash` original (upsert atualiza a MESMA row). Bloqueia com 429 se sessão em cooldown; recusa 400 se `status=created`. Helpers não ficam persistidos, então o retry só repõe cliente + mentor como members.
- Novo endpoint `DELETE /api/hubspot/group-creation/:id` — apaga a row do banco, não toca o grupo no WhatsApp. Útil pra duplicatas e pra ticket reaparecer como pendente no Auto-criar.
- Frontend: coluna "Ações" na tabela do Dashboard com `↻ Retry` (só em `status != created`) e `🗑️` (sempre, com confirm explicando que não afeta WhatsApp).
- Fix CSS: regra global dos inputs estendida (`text|password|date|number|email|search`) + `color-scheme:dark` em `date/datetime-local/time` — datepicker nativo agora aparece dark-themed.

### 2026-04-20 tarde — commit `a4d8878` — Fix ordem cliente-primeiro + permissões + retry por grupo
- **Bug fix cliente-DM-duplicada**: no fluxo HubSpot, `groupCreate` agora é chamado SÓ com o cliente. Se o WhatsApp retorna 403 (privacy block), gera invite link e manda DM IMEDIATAMENTE antes de adicionar helpers/admins. Depois adiciona helpers em batch (1 IQ) e admins sequencialmente. Fluxo XLSX preservado.
- **Bug fix "Convidar via link" OFF**: `groupMemberAddMode("all_member_add")` agora é chamado ANTES de `groupSettingUpdate("locked")`, com 4s entre as calls. A permissão de invite via link só fica disponível no WhatsApp após `add_members` estar habilitado.
- **Connection Closed retry**: novo helper `callWithTransientRetry(sessionId, fn, opts)` em baileys.js — retenta até 3x com delays 15s/20s/25s, aguarda reconexão via `waitForSessionConnected(30000)` entre tentativas. Aplicado no `groupCreate` principal. Não retenta rate-limit.
- **Retry por grupo falho**: novo endpoint `POST /api/jobs/:jobId/retry-group { specHash }` + `retryGroupInJob` em services/jobs.js. Fire-and-forget, re-roda `createGroupsFromList` com 1 spec, atualiza `job.results[idx]`. Botão "↻ Tentar" no frontend aparece em rows com `status=failed`.
- **Coluna "Criado em"**: nova coluna na tabela de resultados do job card (entre Welcome e Link). `row.createdAt` preenchido logo após groupCreate. Formato "DD/MM - HHhMM" via helper `formatDateShort`.

### 2026-04-20 — commit `deb412c` — Auto-criar + Dashboard histórico + fix título HubSpot
- `/api/hubspot/resolve-tickets` passa a ler de `hubspot_tickets` (fonte canônica) — expõe `ticket_owner`, `tier` string, `pipeline_stage_name`, `pipeline_type`, `status_ticket`.
- Fix duplicação do mentor no preview: `clientName = split("|")[0]` + `owner = r.ticket_owner || r.mentor`.
- Edição inline do título via `contenteditable` no row expandido; `_editedName` preserva entre re-renders.
- Novo endpoint `GET /api/hubspot/pending-groups`: tickets com tier sem `status='created'` agrupados por owner + auto-map sessão.
- Novo modal "🤖 Auto-criar grupos": accordion por mentor, welcome/rejectDm por seção, massa = N jobs paralelos via `Promise.all`.
- Novo endpoint `GET /api/hubspot/group-history` cross-session com JOIN em `hubspot_tickets` (pra `owner_name`) + `wa_sessions` (pra label/phone).
- Nova aba "📊 Histórico": filtros (from/to/mentor/tier/status/sessão), tabela 11 colunas, exportação CSV UTF-8.
- `hubspot-api.js`: `fetchTicketFromApi` expõe `owner_{id,name,email}`; novo helper `upsertHubspotTicket`.

### 2026-04-15 madrugada — commit `4af06c5` — Criar grupos via links HubSpot (default)
- Rota `POST /api/hubspot/resolve-tickets` (lia de `mentorados` até 2026-04-20). Radio "🎫 Tickets HubSpot" default no modal.
- `buildSpecsFromHubspotResolved`, `renderHubspotPreview`, `renderHelperSessionsChecklist`, `toggleCreateSourceMode` no grupos.html.

### 2026-04-15 final — commit `4320fe8` — Session Quarantine Mode
- Helpers `quarantineSession`/`releaseSession`/`isQuarantined` no baileys.js.
- Gates HTTP 409 em routes de grupo/mensagem/contacts.
- `applyCriticalSessionOverrides` pra Escalada + sessões degradadas.
- Quarentena auto-ativa em `createGroupsFromList`, fica ativa após rate-limit.

### 2026-04-13 a 15 — série de commits — Photo-worker + painel temperatura
- Commit `3a893b2`: endpoint batch `/api/sync/status-all` + RPC `get_sync_status_all()` + polling pausado quando `document.hidden`.
- Painel de temperatura 🟢🟡🔴 no grupos.html.
- Pre-flight check em `createGroupsFromList`: 429 se `timedOut≥100/2h`.

### Anteriores
Commits de jobs em memória, multi-session, ETA, cancel, configurable delay, Supabase como fonte de verdade (histórico detalhado em [.claude/grupos-tool-handoff.md](.claude/grupos-tool-handoff.md)).

---

## 11. Pontos em aberto (ordem de prioridade sugerida)

1. **Grupos históricos com nome duplicado**: grupos criados antes do 2026-04-20 ficam com `"Cliente | Mentor | Mentor"` no `wa_group_creations.group_name`. Não afeta o WhatsApp (nome do grupo lá já foi setado uma vez e não muda sozinho), só afeta o Dashboard. Script SQL opcional pra limpeza: `UPDATE wa_group_creations SET group_name = regexp_replace(group_name, ' \| (.+) \| \1$', ' | \1') WHERE group_name ~ ' \| (.+) \| \1$'`.
2. **`owner_name` denormalizado em `wa_group_creations`**: hoje o Dashboard faz JOIN on-the-fly toda query. Se performance apertar, adicionar coluna `hubspot_owner_name` em `wa_group_creations` + expandir o trigger `trg_sync_mentorados_to_group_creations` pra também ler de `hubspot_tickets.owner_name`.
3. **Preview visual com foto no modal Auto-criar**: hoje mostra só tier como badge. Adicionar thumb `/static/fotos/{tier}.png` na primeira coluna da tabela do accordion.
4. **Progress indicator em "Iniciar todos selecionados"**: hoje o botão fica desabilitado e os status por mentor atualizam. Adicionar barra de progresso "3/7 jobs iniciados…" no footer.
5. **Re-resolve inline no preview**: se um ticket está com info stale (ex: tier null), permitir re-chamar `/resolve-tickets` só pra aquele ticket via botão na linha.
6. **Edição inline de outros campos no preview** (welcome, descrição individual): hoje só título. Estendendo o pattern do `_editedName` pra outros campos não é difícil.
7. **WebSocket em vez de polling**: socket.io do servidor existe mas grupos.html usa polling 5s. Dava updates instantâneos.
8. **Persistir jobs em disco**: hoje perdem com PM2 restart. O cache Supabase mitiga (retoma), mas persistir ganha alguns minutos.

---

## 12. Credenciais e acessos operacionais

- **GitHub repo**: `beniciorosa/E-ZAP`, branch `main`, push direto.
- **SSH Hetzner**: `ssh -i ~/.ssh/ezap_hetzner root@87.99.141.235`, path `/opt/ezap/whatsapp-server`.
- **PM2 app**: `ezap-whatsapp` (id 0), porta 3100.
- **Supabase**: project ref `xsqpqdjffjqxdcmoytfc`. Management token em `.env` (var `SUPABASE_MGMT_TOKEN`). User-Agent `Mozilla/5.0...` obrigatório (Cloudflare bloqueia bot UAs).
- **Admin token do whatsapp-server**: lido de `/opt/ezap/whatsapp-server/.env` (`ADMIN_TOKEN=...`). Hoje: `EZAP-SERVER-ADMIN-2026`.
- **Critical phones** (overrides automáticos): `CRITICAL_PHONES = {"5519993473149"}` (Escalada Ltda) — sempre forçam 10min delay + hourlyCap 3.
