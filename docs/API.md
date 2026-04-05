# E-ZAP API — Visao e Roadmap

> **Status:** Documento vivo. Sem endpoints publicos ainda.
> Este arquivo evolui junto com o codigo: sempre que um novo domain
> (contacts, abas, pins, notes, etc) ganha persistencia estavel, documente
> o contrato aqui antes (ou durante) a implementacao.

## Visao geral

O E-ZAP hoje e uma extensao Chrome que integra WhatsApp Web com Supabase.
A estrategia de longo prazo e que os mesmos dados que a extensao
manipula estejam disponiveis via uma API publica, pra que ferramentas
externas (automacoes, integracoes, dashboards) leiam e escrevam nesses
dominios sem depender da extensao.

```
  [WhatsApp Web + Extensao]         [Outras ferramentas / automacoes]
             |                                 |
             +----------------------+----------+
                                    |
                        [ E-ZAP Public API ]
                                    |
                               [ Supabase ]
```

---

## Dominios ja modelados (atraves da extensao)

Todos estao em Supabase, schema `public`, RLS por `user_id`.

### 1. Contacts (`aba_contacts`)
Contatos que um usuario salvou em alguma aba.

| Coluna | Tipo | Notas |
|---|---|---|
| aba_id | uuid FK | aba a que pertence |
| contact_name | text | nome como aparece no WhatsApp (display) |
| contact_jid | text (nullable) | **identificador estavel do chat** (ex: `5511...@c.us`, `xxx@g.us`) |

**Importante:** `contact_name` pode ser ambiguo (o usuario renomeia, tem pipe "Nome \| Mentor", etc). O `contact_jid` e o identificador correto pra futuras integracoes.

### 2. Abas (`abas`)
Grupos customizados de contatos, criados pelo usuario.

| Coluna | Tipo |
|---|---|
| id | uuid PK |
| user_id | uuid |
| name | text |
| color | text |
| created_at | timestamp |

### 3. Pinned Contacts (`pinned_contacts`)
Contatos fixados pelo usuario (aparecem no topo).

| Coluna | Tipo |
|---|---|
| user_id | uuid |
| contact_name | text |
| contact_jid | text (nullable) |

### 4. Notes (documentar quando estabilizar)
TODO: extrair schema de `notes` ao criar API.

### 5. Flows (`flows`, `flow_*`)
Fluxos de mensagem automatica. TODO: documentar endpoints quando gerador de API existir.

### 6. Mensagens Automaticas / Sequencias
TODO: documentar `msg_sequences` quando estabilizar.

---

## Identificacao de chats — JID First

**Regra de ouro:** qualquer feature que relaciona dados a um chat do WhatsApp DEVE armazenar o `jid` do chat, nao so o nome.

### Por que?
- WhatsApp Web usa virtual scroll — a lista DOM tem so linhas visiveis
- Nomes mudam: usuario renomeia contato, titulos tem "\| Mentor" as vezes e outras nao
- Dois contatos podem ter o mesmo nome
- JIDs sao estaveis e unicos

### Como obtemos o JID?
Via `store-bridge.js` (MAIN world), que acessa `window.Store.Chat` do WhatsApp Web atraves de webpack chunk injection (tecnica do moduleRaid/wppconnect).

No content script, use `window.ezapGetAllChats()` ou `window.ezapResolveJid(chatName)` que ja estao expostos em `api.js`.

### Fallback
Contatos salvos antes da existencia do bridge tem `contact_jid = NULL`. Nestes casos, cai no **match tolerante por nome** (`window.ezapMatchContact`). O bridge tenta migrar esses contatos preguicosamente (ver `migrateJidsWhenStoreReady` em abas.js).

---

## Arquitetura de MAIN world bridges

Scripts que precisam acessar internals do WA Web rodam no MAIN world
(via manifest `world: "MAIN"`). Eles nao tem acesso ao `chrome.*` API
do content script, entao a comunicacao e via `window.postMessage`.

### Bridges existentes
| Bridge | Arquivo | Acesso a | Canal |
|---|---|---|---|
| Audio interceptor | `transcribe-interceptor.js` | URL.createObjectURL, HTMLMediaElement, AudioContext | `_ezap_get_audio`, `_ezap_mute_next` |
| Store bridge | `store-bridge.js` | window.Store.Chat (WA Web) | `_ezap_get_chats_req`, `_ezap_store_ready_req` |

### Wrappers no content script
Todas as bridges sao encapsuladas em helpers no `api.js`:
- `ezapGetAllChats()` — retorna `[{jid, name, isGroup, pushname}, ...]` ou null
- `ezapResolveJid(title)` — retorna JID do chat com esse nome, ou null
- `ezapBuildChatIndex()` — retorna `{byJid, byName, chats}` pra uso em loops sync
- `ezapFindJidInIndex(index, title)` — sync lookup dentro do index
- `ezapStoreReady()` — boolean se o bridge esta pronto

---

## Endpoints publicos (Roadmap)

**Ainda nao implementados.** Documentado aqui como contrato planejado.

### Autenticacao
API keys por usuario/tenant, Bearer token:
```
Authorization: Bearer ezap_live_xxxxxxxxxxxxx
```

### Endpoints planejados

#### Abas
- `GET /v1/abas` — lista abas do usuario
- `POST /v1/abas` — cria aba `{ name, color }`
- `PATCH /v1/abas/:id` — atualiza nome/cor
- `DELETE /v1/abas/:id` — apaga aba (cascades contacts)

#### Contatos em abas
- `GET /v1/abas/:id/contacts` — lista contatos da aba
- `POST /v1/abas/:id/contacts` — adiciona `{ name, jid }` (jid recomendado)
- `DELETE /v1/abas/:id/contacts/:jid` — remove por JID
- `DELETE /v1/abas/:id/contacts?name=X` — remove por nome (fallback)

#### Pins
- `GET /v1/pins` — lista contatos fixados
- `POST /v1/pins` — fixa `{ name, jid }`
- `DELETE /v1/pins/:jid` — desafixa

#### Notes
- `GET /v1/contacts/:jid/notes`
- `POST /v1/contacts/:jid/notes`
- `PATCH /v1/notes/:id`
- `DELETE /v1/notes/:id`

#### Flows / Automacoes
- `GET /v1/flows` — lista fluxos
- `POST /v1/flows` — cria fluxo
- `POST /v1/flows/:id/execute` — dispara manualmente

#### Outros
- `POST /v1/messages/send` — envia mensagem via WhatsApp Web conectado (requer extensao ativa)
- `GET /v1/me` — dados do usuario e limites
- `GET /v1/usage` — uso atual da API

---

## Gerador de API Keys (Admin)

**TODO — fase futura.** Depois que os endpoints acima estiverem firmes, criar no painel Admin (`admin.html` no Vercel):

- Tela "API Keys" por usuario/tenant
- Gerar / revogar keys
- Definir escopos (read-only, read-write)
- Rate limits configuraveis
- Logs de uso (data, endpoint, status, IP)

### Referencia de UX (concorrente WaSeller)
Modal "Configurar API" com:
1. Input de texto com token gerado (formato: `1775408386952-fbe3d2fd6b9aa63e560d4bfa381378fc` — timestamp-hash)
2. Botao "Gerar Token" (regerar/revogar+criar novo) + botao copiar
3. Toggle "Ativar/Desativar API"
4. Botao "Abrir Documentacao" → abre swagger/redoc da API

API publica deles: `https://api-whatsapp.wascript.com.br/api-docs/` (referencia de estudo — endpoints REST expondo mensagens/contatos/grupos).

Schema sugerido (Supabase):
```sql
CREATE TABLE api_keys (
  id uuid PK,
  user_id uuid REFERENCES auth.users(id),
  key_hash text NOT NULL UNIQUE,      -- armazena apenas o hash
  key_prefix text NOT NULL,           -- ex: "ezap_live_abc" (primeiros chars, pra display)
  scopes text[] DEFAULT '{read,write}',
  rate_limit_per_min int DEFAULT 60,
  created_at timestamp DEFAULT now(),
  last_used_at timestamp,
  revoked_at timestamp
);

CREATE TABLE api_usage_logs (
  id uuid PK,
  api_key_id uuid REFERENCES api_keys(id),
  endpoint text NOT NULL,
  method text NOT NULL,
  status_code int NOT NULL,
  response_ms int,
  created_at timestamp DEFAULT now()
);
```

---

## Extensao: como os dados sao sincronizados

O fluxo atual (sem API publica ainda):

1. Usuario age na extensao (fixa contato, adiciona em aba, etc)
2. Extensao salva em `chrome.storage.local` (fast cache)
3. Extensao envia pra Supabase via `supabase_rest` handler do `background.js`
4. No proximo load, loadAbasData/loadPinnedContacts puxa do cache + sync background com Supabase

Uma API publica futura seria um **terceiro cliente** para os mesmos dados, com:
- Auth via API key (vs auth por sessao JWT da extensao)
- Rate limits e scopes
- Versionamento (`/v1/`, `/v2/`)

---

## Historico de decisoes

### 2026-04-05 — JID-first matching
Adotamos JID como identificador estavel para contatos em Abas e Pins.
`contact_jid` e nullable pra retrocompat com dados antigos salvos so por nome.
Bridge `store-bridge.js` acessa `window.Store.Chat` do WA Web via webpack
chunk injection pra resolver JIDs sem depender do DOM/virtual-scroll.
