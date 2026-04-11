# E-ZAP — Arquitetura

**E-ZAP** é uma Chrome Extension (Manifest V3) que transforma o WhatsApp Web em uma plataforma de gestão integrada com CRM, mensagens automáticas, fluxos de automação, IA (GEIA), transcrição de áudio, captura de eventos e anotações. A solução completa é composta por quatro grandes blocos: a **extensão Chrome**, o **painel administrativo web** (hospedado na Vercel), um **servidor Node.js multi-sessão** (Baileys, rodando em VPS com PM2) e o **Supabase** como backend unificado (PostgreSQL, Edge Functions e Storage).

---

## 1. Arquitetura Geral

Visão macro de todos os subsistemas, seus módulos principais e integrações externas.

```mermaid
flowchart LR
    subgraph EXT["Chrome Extension — Manifest V3"]
        direction TB
        popup["Popup<br/>Login · Info do Usuário"]
        sw["Service Worker<br/>background.js<br/>(Ponte p/ APIs)"]
        cs["Content Scripts · ISOLATED<br/>CRM · Mensagens · Fluxos<br/>GEIA · Abas · Notas<br/>Filtros · Captura · Widget"]
        mainw["MAIN World<br/>store-bridge · audio interceptor"]
        meet["Meet Recorder<br/>meet.google.com"]
        popup --> sw
        cs --> sw
        cs <--> mainw
        meet --> sw
    end

    subgraph ADMIN["Admin Web — Vercel"]
        direction TB
        adminHtml["admin.html<br/>Dashboard · Usuários · Tokens<br/>Fluxos Builder · GEIA KB · Releases"]
        indexHtml["index.html<br/>Changelog Público"]
        qrHtml["qr-display.html<br/>Pareamento QR"]
    end

    subgraph SERVER["WhatsApp Server — Hetzner · PM2"]
        direction TB
        express["Express REST API<br/>/api/sessions · /messages · /jobs"]
        socketio["Socket.io<br/>QR · Conexão · Mensagens"]
        baileys["Baileys<br/>Multi-Sessão"]
        jobs["Jobs Workers<br/>Extract · Add"]
        express --> baileys
        express --> jobs
        express -.- socketio
        jobs --> baileys
    end

    subgraph DB["Supabase Cloud"]
        direction TB
        authDb[("Auth DB<br/>users · user_tokens<br/>app_settings · token_attempts")]
        dataDb[("Data DB<br/>flows · message_events<br/>wa_sessions · wa_messages<br/>notas · labels · mentorados")]
        storage[("Storage<br/>releases/ · ZIP + release.json")]
        edgeFn["Edge Function<br/>hubspot-tickets"]
    end

    subgraph EXTAPI["Serviços Externos"]
        direction TB
        wa["WhatsApp Web"]
        hubspot["HubSpot CRM"]
        openai["OpenAI<br/>Whisper + Chat"]
        google["Google APIs<br/>Drive · Docs"]
        ipapi["ipapi.co"]
    end

    sw -->|REST / RPC| authDb
    sw -->|REST| dataDb
    sw -->|Bearer| hubspot
    sw -->|API Key| openai
    sw -->|OAuth2| google
    sw --> ipapi
    mainw -.->|injeção webpack| wa

    adminHtml -->|REST + RPC| authDb
    adminHtml -->|REST| dataDb
    adminHtml -->|Storage API| storage
    indexHtml --> storage
    adminHtml -->|Bearer + Socket.io| express

    baileys -->|WS Protocol| wa
    baileys -->|REST| dataDb

    hubspot -.->|Webhook| edgeFn
    edgeFn --> dataDb

    classDef frontend fill:#dbeafe,stroke:#1e40af,color:#1e3a8a
    classDef backend fill:#dcfce7,stroke:#166534,color:#14532d
    classDef database fill:#f3e8ff,stroke:#6b21a8,color:#581c87
    classDef external fill:#ffedd5,stroke:#c2410c,color:#7c2d12

    class popup,sw,cs,mainw,meet,adminHtml,indexHtml,qrHtml frontend
    class express,socketio,baileys,jobs backend
    class authDb,dataDb,storage,edgeFn database
    class wa,hubspot,openai,google,ipapi external
```

### Responsabilidades por camada

| Camada | Responsabilidade |
|---|---|
| **Chrome Extension** | UI injetada no WhatsApp Web (CRM sidebar, widget, abas, filtros), captura de eventos DOM, automação, transcrição, IA. O `background.js` é o único ponto que fala com APIs externas. |
| **Admin Web (Vercel)** | Painel administrativo para gestão de usuários, tokens, fluxos (builder visual), GEIA knowledge base, releases e analytics. |
| **WhatsApp Server** | Servidor Node.js paralelo à extensão para operações que exigem sessão persistente: multi-conta, envio/recebimento em background, operações em grupos (extração de links, adição em lote). |
| **Supabase** | Backend unificado — duas bases PostgreSQL (auth e dados), Storage para releases, Edge Functions para webhooks. |
| **Serviços Externos** | HubSpot (CRM), OpenAI (Whisper + Chat), Google (Drive/Docs para pipeline do Meet), ipapi.co (geo). |

---

## 2. Fluxo de Dados entre Módulos

Os cinco fluxos críticos que atravessam múltiplos subsistemas.

```mermaid
flowchart TB
    subgraph A["A · Autenticação & Token"]
        direction TB
        A1["auth.js<br/>detecta telefone"] -->|chrome.runtime| A2["Service Worker"]
        A2 -->|RPC validate_token| A3[("Auth DB")]
        A3 -->|user_id · role · features| A2
        A2 -->|persiste| A4["chrome.storage.local"]
        A4 -->|injeta| A5["window.__wcrmAuth"]
    end

    subgraph B["B · Captura de Mensagens"]
        direction TB
        B1["WhatsApp Web DOM"] -->|webpack injection| B2["store-bridge.js<br/>MAIN"]
        B2 -->|postMessage| B3["msg-capture.js<br/>ISOLATED"]
        B3 -->|buffer + dedup| B4["Service Worker"]
        B4 -->|batch insert<br/>supabase_rest| B5[("message_events")]
    end

    subgraph C["C · Transcrição de Áudio"]
        direction TB
        C1["Audio Blob<br/>URL.createObjectURL"] -->|intercept| C2["transcribe-interceptor.js<br/>MAIN"]
        C2 -->|postMessage| C3["transcribe.js<br/>UI"]
        C3 -->|base64| C4["Service Worker"]
        C4 -->|multipart POST| C5["OpenAI Whisper"]
        C5 -->|texto| C4
        C4 -->|exibe| C3
    end

    subgraph D["D · Sessão WhatsApp Server"]
        direction TB
        D1["Admin Web"] -->|POST /api/sessions| D2["Express"]
        D2 --> D3["Baileys · gera QR"]
        D3 -.->|socket session:qr| D1
        D1 -->|usuário escaneia| D4["WhatsApp Web"]
        D4 -->|creds| D3
        D3 -->|persiste| D5[("wa_sessions")]
        D3 -.->|socket session:connected| D1
        D4 -->|mensagens recebidas| D3
        D3 -->|persiste| D6[("wa_messages")]
    end

    subgraph E["E · Flow Engine de Automação"]
        direction TB
        E1["Admin Builder<br/>nodes · edges JSONB"] -->|salva| E2[("flows")]
        E2 -->|test_requested_at| E3["flow-engine.js<br/>polling 8s"]
        E3 -->|executa ações<br/>enviar msg · label · aba| E4["Content Script"]
        E4 -->|test_processed_at| E2
    end

    classDef flowA fill:#dbeafe,stroke:#1e40af,color:#1e3a8a
    classDef flowB fill:#dcfce7,stroke:#166534,color:#14532d
    classDef flowC fill:#fef3c7,stroke:#b45309,color:#78350f
    classDef flowD fill:#f3e8ff,stroke:#6b21a8,color:#581c87
    classDef flowE fill:#ffedd5,stroke:#c2410c,color:#7c2d12

    class A1,A2,A3,A4,A5 flowA
    class B1,B2,B3,B4,B5 flowB
    class C1,C2,C3,C4,C5 flowC
    class D1,D2,D3,D4,D5,D6 flowD
    class E1,E2,E3,E4 flowE
```

### Observações sobre os fluxos

- **Fluxo A** — a validação usa device fingerprinting (`token_attempts`) e recupera `features` por perfil (crm, msg, abas, geia, fluxos, buttons).
- **Fluxo B** — a bridge `store-bridge.js` roda no MAIN world para acessar `window.Store` via webpack injection; `msg-capture.js` roda no ISOLATED world e se comunica por `postMessage`. Eventos são deduplicados por `message_wid` e enviados em batch.
- **Fluxo C** — três APIs do browser são interceptadas (`URL.createObjectURL`, `HTMLMediaElement.play`, `AudioContext.decodeAudioData`). O blob é convertido em base64 e enviado ao Whisper via `background.js`.
- **Fluxo D** — Baileys usa o protocolo Signal+Noise do WhatsApp (sem API oficial). As credenciais são persistidas como JSONB na tabela `wa_sessions`, permitindo reconexão sem novo QR.
- **Fluxo E** — o admin aciona testes manuais via `test_requested_at`; o content script faz polling a cada 8s e executa o fluxo localmente, marcando `test_processed_at` ao finalizar.

---

## 3. Infraestrutura e Deploy

Hospedagem, integrações externas e os dois canais de distribuição da extensão (Chrome Web Store + auto-update via Supabase Storage).

```mermaid
flowchart LR
    subgraph DEV["Desenvolvimento"]
        direction TB
        dev["Developer Machine"]
        git["GitHub<br/>beniciorosa/E-ZAP<br/>branch main"]
        buildScript["Script local<br/>bump manifest + ZIP"]
    end

    subgraph CLOUD["Hospedagem · Runtime"]
        direction TB

        subgraph VERCEL["Vercel Edge Network"]
            vAdmin["admin.html"]
            vIndex["index.html"]
            vQr["qr-display.html"]
        end

        subgraph HETZNER["Hetzner VPS · PM2"]
            server["whatsapp-server<br/>Node.js · Porta 3100"]
        end

        subgraph SUPA["Supabase Cloud"]
            pgAuth[("PostgreSQL<br/>Auth DB")]
            pgData[("PostgreSQL<br/>Data DB")]
            supaStore[("Storage<br/>releases/")]
            supaFn["Edge Functions<br/>Deno"]
        end

        subgraph CWS["Chrome Web Store"]
            storeListing["Extensão Publicada"]
        end
    end

    subgraph USERS["Usuários Finais"]
        direction TB
        userChrome["Chrome Browser<br/>+ E-ZAP Extension"]
        userAdmin["Admin Panel Users"]
    end

    subgraph THIRDPARTY["Integrações Externas"]
        direction TB
        hub["HubSpot CRM"]
        oa["OpenAI"]
        ggl["Google APIs"]
        ip["ipapi.co"]
        waNet["WhatsApp Network"]
    end

    dev -->|git push main| git
    git -->|auto deploy| VERCEL
    dev --> buildScript
    buildScript -->|PUT ZIP + release.json| supaStore
    dev -.->|upload manual| storeListing

    storeListing -->|install| userChrome
    supaStore -.->|auto-update check| userChrome

    userChrome -->|REST + RPC| pgAuth
    userChrome -->|REST| pgData
    userChrome -->|Bearer| hub
    userChrome -->|Whisper + Chat| oa
    userChrome -->|OAuth2| ggl
    userChrome --> ip
    userChrome -->|Bearer + Socket.io| server
    userChrome -->|Extension DOM| waNet

    userAdmin -->|HTTPS| VERCEL
    VERCEL -->|REST + RPC| pgAuth
    VERCEL -->|REST| pgData
    VERCEL -->|Storage API| supaStore
    VERCEL -->|Bearer + Socket.io| server

    server -->|service_key| pgData
    server -->|Baileys WS| waNet

    hub -.->|Webhook POST| supaFn
    supaFn --> pgData

    classDef dev fill:#e5e7eb,stroke:#374151,color:#111827
    classDef cloud fill:#dbeafe,stroke:#1e40af,color:#1e3a8a
    classDef infra fill:#dcfce7,stroke:#166534,color:#14532d
    classDef database fill:#f3e8ff,stroke:#6b21a8,color:#581c87
    classDef external fill:#ffedd5,stroke:#c2410c,color:#7c2d12
    classDef user fill:#fef3c7,stroke:#b45309,color:#78350f

    class dev,git,buildScript dev
    class vAdmin,vIndex,vQr cloud
    class server,storeListing infra
    class pgAuth,pgData,supaStore,supaFn database
    class hub,oa,ggl,ip,waNet external
    class userChrome,userAdmin user
```

### Pipelines de deploy

| Alvo | Gatilho | Destino |
|---|---|---|
| **Admin Web** (admin.html, index.html, qr-display.html) | `git push origin main` | Vercel (auto-deploy) |
| **Chrome Extension** (versão pública) | Upload manual do ZIP | Chrome Web Store |
| **Chrome Extension** (auto-update interno) | Script local: bump manifest → ZIP → PUT Storage → patch `release.json` | Supabase Storage `releases/` |
| **WhatsApp Server** | Deploy manual (pull + `pm2 restart`) | Hetzner VPS (PM2, porta 3100) |
| **Supabase Migrations** | Management API | Supabase PostgreSQL |
| **Edge Functions** | Supabase CLI / Management API | Supabase Edge Runtime (Deno) |

### Regras operacionais (do CLAUDE.md)

- Toda edição na extensão **deve bumpar `version`** no `chrome-extension/manifest.json`.
- Textos de UI em PT-BR **sempre com acentos**.
- SQL de migration salvo em `supabase/migration_XXX_descricao.sql`.
- Management API do Supabase deve enviar `User-Agent: Mozilla/5.0 ...` (Cloudflare bloqueia UAs de bot).

---

## Stack Resumida

| Camada | Tecnologia |
|---|---|
| **Extensão** | Vanilla JS · Manifest V3 · Service Worker · Content Scripts (ISOLATED + MAIN) |
| **Admin Web** | HTML + Vanilla JS + Charts.js · Hospedagem Vercel |
| **Servidor WhatsApp** | Node.js · Express 4 · Socket.io 4 · Baileys 6.7 · Pino · PM2 |
| **Banco de Dados** | Supabase — PostgreSQL + RLS + RPC |
| **Edge Functions** | Supabase Functions (Deno) |
| **Storage** | Supabase Storage (bucket `releases/`) |
| **Integrações** | HubSpot · OpenAI (Whisper + Chat) · Google APIs (Drive + Docs) · ipapi.co |
| **Hosting** | Vercel · Hetzner VPS · Supabase Cloud · Chrome Web Store |
| **Versionamento** | GitHub (`beniciorosa/E-ZAP`, branch `main`) |

---

## Principais diretórios

```
zap1/
├── chrome-extension/        # Extensão Manifest V3 (background, content scripts, popup)
│   ├── manifest.json        # v1.9.97 — permissões, host_permissions, OAuth2
│   ├── background.js        # Service Worker — única ponte para APIs externas
│   ├── content.js · msg.js · slice.js · abas.js · notes.js · geia.js · ...
│   ├── store-bridge.js      # MAIN world — acesso a window.Store
│   └── transcribe-interceptor.js  # MAIN world — hook em audio APIs
│
├── whatsapp-server/         # Servidor Node.js Baileys (Hetzner · PM2)
│   ├── src/
│   │   ├── index.js         # Entry — Express + Socket.io
│   │   ├── routes/          # sessions · messages · jobs
│   │   ├── services/        # baileys · supabase · jobs
│   │   └── middleware/      # auth (Bearer)
│   └── package.json         # express · socket.io · baileys · pino · dotenv
│
├── admin.html               # Painel admin (Vercel) — ~6488 linhas
├── index.html               # Changelog público (Vercel)
├── qr-display.html          # Página QR para pareamento
├── vercel.json              # CORS para /api/*
│
├── supabase/
│   ├── functions/
│   │   └── hubspot-tickets/ # Edge Function Deno — webhook receiver
│   └── migration_*.sql      # Migrations versionadas
│
└── CLAUDE.md                # Regras e credenciais do projeto
```
