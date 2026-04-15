# E-ZAP — Sessão de trabalho 2026-04-14/15

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

### SQL one-shot (não comitado, rodado via Management API)
```sql
UPDATE wa_photo_queue SET status='pending', attempts=0, error=NULL, last_attempt_at=NULL
WHERE status='downloading';
-- 1224 rows resetados
```

---

## 3. Estado atual (deployed + running)

- **Vercel**: grupos.html + ezapweb.html + fotos.html — auto-deploy no push da `main`
- **Hetzner** (`root@87.99.141.235`, `/opt/ezap/whatsapp-server`): rodando commit `7863b33`, PM2 online, 2 sessões reconectadas no último restart, 18 sessões totais reconectando em background
- **Supabase photo queue atual**: 1122 done, 119 no_photo, 6281 failed, 0 pending/downloading/active. Todos os workers ociosos — zero IQs saindo. **Este é o estado mais seguro possível pras contas.**

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

## 4. Pendências ativas (em andamento nesta sessão)

O usuário pediu **3 coisas** que ainda não foram feitas. Cover todas no próximo commit:

### 4.1. Lazy photo fetch (remove bulk, adiciona on-message)
**Problema que resolve**: atualmente, toda reconexão re-enfileira milhares de fotos via `syncGroupMetadata`, `chats.upsert`, `contacts.upsert`, `processHistorySync`. Isso é o que causou o flood original.

**Solução**: transformar o photo-worker em lazy. Só enfileira foto quando há interação real.

**Mudanças em `whatsapp-server/src/services/baileys.js`**:
- **REMOVER** as chamadas `enqueuePhotos(...)` das seguintes funções/handlers:
  - `syncGroupMetadata` (linhas ~2276-2281) — remove enqueue de participants e groups
  - `chats.upsert` handler (linha ~259) — remove enqueue de newChats
  - `contacts.upsert` handler (linha ~302) — remove enqueue de contacts
  - `processHistorySync` (linhas ~2322, ~2327) — remove enqueue de uniqueJids e syncedChats
- **ADICIONAR** `enqueuePhotos(sessionId, [jid])` em `handleIncomingMessage` (linha ~685) — lazy: só baixa foto quando alguém manda mensagem. Usa `ignore-duplicates` então se já existe na queue, skip
- Deixar as chamadas singulares em `contacts.update` (linhas 331, 361) e `listAdminGroups` (linha 640) pois são orgânicas

### 4.2. Toggle global do photo-worker com persistência em disco
**Arquivo**: `whatsapp-server/src/services/photo-worker.js`

- Adicionar `globalPaused` flag em memória
- Persistir em `/opt/ezap/whatsapp-server/data/photo-worker-state.json` (criar dir se não existir via `fs.mkdirSync(..., { recursive: true })`)
- `processNext` faz short-circuit (return imediato) quando `globalPaused===true`
- Carregar estado no require() do módulo (read sync)
- Funções: `pauseGlobal()`, `resumeGlobal()`, `isGlobalPaused()`

**Nova rota** em `whatsapp-server/src/routes/sync.js` (ou novo `routes/photo-worker.js`):
- `GET /api/photo-worker/status` → `{ globalPaused, sessions: [{ sessionId, paused, failureStreak, pauseReason }] }`
- `POST /api/photo-worker/pause` → seta flag + persiste
- `POST /api/photo-worker/resume` → limpa flag + persiste

### 4.3. Painel de temperatura permanente em grupos.html
**Onde**: substituir/expandir o `syncCard` existente no topo do grupos.html. Título: "🌡️ Temperatura das contas".

**Dados exibidos (por sessão)**:
- 🟢🟡🔴 dot baseado em: success rate, failureStreak, rateLimitHitAt (verde >65%, amarelo 30-65%, vermelho <30% ou failureStreak>=5 ou cooldown ativo)
- Label + telefone
- Barra tri-color: done/pending/failed (reutilizar o render atual)
- Badge "timeout streak: N" se N > 0
- "Pode criar grupos: ✅/❌" baseado no mesmo predicado do pre-flight (≥100 timed out nas últimas 2h → ❌)
- Última atividade (`last_attempt_at` do queue)
- Relógio se `rateLimitHitAt` ativo com contagem regressiva

**Header global do card**:
- Botão "⏸ Pausar fotos / ▶ Ativar fotos" (toggle via POST `/api/photo-worker/pause|resume`)
- Contador agregado

**Polling**: 10s. Ordenação: vermelhas primeiro.

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
