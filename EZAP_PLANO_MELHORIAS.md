# E-ZAP Chrome Extension — Plano Detalhado de Melhorias

**Data**: 15/04/2026
**Versão atual**: 2.0.1
**Autor da análise**: Claude (sessão de planejamento)
**Objetivo**: Documentar a arquitetura atual, problemas identificados, e plano de mudanças propostas para revisão

---

## PARTE 1: ESTADO ATUAL DA EXTENSÃO

### 1.1 O que é o E-ZAP

Chrome Extension (Manifest V3) que injeta uma camada de gestão no WhatsApp Web. Oferece CRM, automação de mensagens, supervisão de equipe, analytics, transcrição de áudio por IA, e integração com HubSpot. Usada internamente pelo Grupo Escalada.

### 1.2 Arquitetura de Arquivos

A extensão possui **22 arquivos JavaScript** e **2 arquivos CSS**, organizados em 3 fases de injeção:

**Fase 1 — document_start, mundo ISOLATED:**
- `early-hide.js` (38 linhas) — Esconde a lista de chats nativa do WhatsApp antes do DOM carregar, usando CSS injetado baseado em cache local

**Fase 2 — document_start, mundo MAIN:**
- `store-bridge.js` (2108 linhas, 96KB) — Intercepta o webpack interno do WhatsApp Web para acessar módulos internos (Chat, Contact, GroupMetadata, ProfilePicThumb). Usa `Object.defineProperty` e wrapping do `Array.push` no webpack chunk
- `transcribe-interceptor.js` (231 linhas) — Monkey-patch em `URL.createObjectURL`, `HTMLMediaElement.play`, `AudioContext.decodeAudioData` para capturar blobs de áudio

**Fase 3 — document_idle, mundo ISOLATED (16 scripts):**
1. `event-bus.js` (55 linhas) — Sistema pub/sub global (`ezapBus.on/emit/off/once`)
2. `sidebar-manager.js` (172 linhas) — Gerencia ciclo de vida de sidebars com exclusão mútua (só 1 aberto por vez). Controla largura do WhatsApp (340px sidebar + 62px rail)
3. `theme.js` (136 linhas) — Detecção dark/light mode e geração de paleta de cores
4. `api.js` (790 linhas) — Helpers compartilhados: `ezapSendBg()` (wrapper chrome.runtime com timeout 15s), `ezapSupaRest()` (proxy Supabase), matching de contatos, acesso ao Store bridge
5. `auth.js` (1192 linhas) — Device fingerprinting (UUID), detecção de telefone do WhatsApp (3 métodos), validação de token via RPC Supabase, feature flags, re-validação periódica
6. `content.js` (2230 linhas, 93KB) — Sidebar CRM: info do contato, integração HubSpot (deals, tickets, meetings, notes), editor de notas rich text (contenteditable + upload de imagem), sistema de labels com cores
7. `msg.js` (1269 linhas, 51KB) — Sequências de mensagens: templates com variáveis (@nome, @email, @telefone, @saudação, @assinatura), agendamento, envio de arquivos, mensagens globais do admin
8. `slice.js` (2644 linhas, 124KB) — Motor de filtro de chat list: marcações de não-lido customizadas (persistentes no DB), esconder/mostrar chats, integração com ABAS para filtrar lista, manipulação DOM virtual-scroll-aware
9. `abas.js` (1984 linhas, 78KB) — Sistema de abas customizadas: CRUD de tabs, atribuição de contatos, cores, drag-and-drop, sincronização com Supabase
10. `widget.js` (394 linhas) — Widget flutuante no header do chat: pills mostrando pin, abas, labels, assinatura. 4 variantes visuais (pill, glass, minimal, solid)
11. `transcribe.js` (523 linhas) — UI de transcrição: botão "Aa" em mensagens de áudio, cache de transcrições do DB, envio para Whisper API via background
12. `notes.js` (551 linhas) — Notas privadas por mensagem: ícone injetado em cada bolha de mensagem, editor inline, indicador amarelo em chats com notas
13. `geia.js` (592 linhas) — Sidebar IA: extração de mensagens da conversa, construção de system prompt com personalidade + base de conhecimento, resumo e sugestões de resposta via OpenAI
14. `admin-overlay.js` (943 linhas) — Supervisão admin: lista usuários, carrega conversas do `wa_messages`, modo imersivo read-only para ler conversas de outros usuários
15. `flow-engine.js` (768 linhas) — Motor de automação: sincroniza flows do Supabase, polling a cada 8s para test requests, execução de nós (enviar msg, esperar, condição, label)
16. `msg-capture.js` (528 linhas) — Captura de mensagens para analytics: scan a cada 15s via store-bridge, deduplicação por message_wid (cache até 15000), sync para `message_events` a cada 20s

**Background:**
- `background.js` (1838 linhas, 66KB) — Service worker único com 30+ action handlers: auth, HubSpot (rate limit 260ms), OpenAI Whisper, Google OAuth/Drive/Docs, Supabase REST passthrough, gerenciamento de arquivos, pipeline de resumo de reunião

**Google Meet:**
- `meet-recorder.js` (592 linhas) + `meet-recorder.css` — Auto-gravação de reuniões, restrito ao domínio grupoescalada.com.br

**Popup:**
- `popup.html` + `popup.js` — UI de login/info com token mascarado

**Estilo:**
- `sidebar.css` (659 linhas) — Design system completo com 60+ CSS custom properties, scoped sob `.escalada-crm`

### 1.3 Comunicação Entre Camadas

```
MAIN World (store-bridge, transcribe-interceptor)
    ↕ window.postMessage (tipos _ezap_*)
ISOLATED World (16 content scripts)
    ↕ chrome.runtime.sendMessage (via ezapSendBg)
Background Service Worker (background.js)
    ↕ fetch()
APIs Externas (Supabase, HubSpot, OpenAI, Google, ipapi)
```

### 1.4 Banco de Dados (25+ tabelas Supabase PostgreSQL)

**Autenticação:**
- `users` — id, name, email, phone, role (admin/user/cx_cs), token (WCRM-XXXX-XXXX-XXXX), features[], allowed_phones[], device_fingerprint, ext_version
- `user_tokens` — Multi-token por usuário com device binding
- `token_attempts` — Auditoria de login (IP, location, device, reason: login/device_mismatch/version_upgrade)
- `app_settings` — Key-value global (chaves API, configs)

**CRM:**
- `labels` — Labels coloridos por contato/usuário
- `observations` — Notas rich text por contato (HTML com imagens via Supabase Storage)
- `pinned_contacts` — Contatos fixados
- `abas` + `aba_contacts` — Tabs customizadas com contatos atribuídos

**Mensagens:**
- `msg_sequences` — Sequências multi-step com variáveis, delay, arquivos
- `global_messages` + `notification_reads` — Broadcasts do admin com tracking de leitura

**Analytics:**
- `message_events` — Cada mensagem capturada: direção, tipo (text/audio/image/video/document), timestamp, chat_jid, message_wid, response_time_seconds, char_count, is_group
- `user_activity` — Resumo diário: enviadas, recebidas, unique_contacts, avg/max_response_time, sla_met/missed

**Automação:**
- `flows` — Definições visuais (nodes/edges JSONB, trigger_type, scope_config, test_requested_at)
- `flow_runs` — Log de execução com steps detalhados

**WhatsApp Server (Baileys):**
- `wa_sessions` — Sessões com creds JSONB, status (disconnected/qr_pending/connected/banned)
- `wa_messages`, `wa_chats`, `wa_contacts` — Dados sincronizados do servidor
- `group_members` — Membros de grupos com roles e timestamps
- `wa_automations` — Regras server-side (keyword, new_chat, schedule, webhook)

**Outros:**
- `documents` — Metadados de arquivos uploadados
- `message_notes` — Notas por mensagem individual
- `geia_knowledge` — Base de conhecimento da IA (text, link, pdf)
- `api_keys` + `api_usage_logs` — Chaves API externas com rate limit e auditoria
- `chat_unread_marks`, `chat_hidden` — Estado customizado de chats

**RPCs importantes:**
- `validate_token()` — Validação com device binding e version bypass
- `generate_token()` — Gera formato WCRM-XXXX-XXXX-XXXX
- `reset_user_device()` — Limpa binding de dispositivo
- `fn_dashboard_summary()`, `fn_admin_overview()`, `fn_response_times()` — Agregações de analytics

### 1.5 Features Existentes (18 features)

| # | Feature | Módulo | Flag de Permissão |
|---|---------|--------|-------------------|
| 1 | CRM Sidebar (contato, labels, notas, HubSpot) | content.js | `crm` |
| 2 | Sequências de Mensagens (templates, variáveis, agendamento) | msg.js | `msg` |
| 3 | ABAS (tabs customizadas de contatos) | abas.js, slice.js | `abas` |
| 4 | Pin de Contatos | widget.js | `pin` |
| 5 | Transcrição de Áudio (Whisper) | transcribe.js | `transcribe` |
| 6 | Supervisão Admin (ler conversas, modo imersivo) | admin-overlay.js | `admin_overlay` |
| 7 | GEIA AI (chat com personalidade) | geia.js | `geia` |
| 8 | GEIA Resumo de Conversa | geia.js | `geia_resumo` |
| 9 | GEIA Sugestão de Resposta | geia.js | `geia_sugestao` |
| 10 | Assinatura em Mensagens | widget.js, msg.js | `signature` |
| 11 | Filtro de Chat List (unread marks, esconder chats) | slice.js | Sempre ativo |
| 12 | Notas por Mensagem | notes.js | Sempre ativo |
| 13 | Widget no Header (pills: pin, abas, labels) | widget.js | Sempre ativo |
| 14 | Motor de Automação (flows visuais) | flow-engine.js | Admin |
| 15 | Captura de Mensagens (analytics/SLA) | msg-capture.js | Sempre ativo |
| 16 | Integração HubSpot (deals, tickets, meetings) | content.js, background.js | Via CRM |
| 17 | Auto-gravação Google Meet | meet-recorder.js | Domain-gated |
| 18 | Auto-update | background.js | Sempre ativo |

### 1.6 Painel Admin (admin.html)

Arquivo único de 6914 linhas com JS/CSS embedded. Tabs:
1. **Dashboard** — Visão geral do sistema
2. **Usuários** — CRUD de usuários, tokens, device reset, features
3. **Mensagens Globais** — Broadcasts para todos usuários
4. **Permissões** — Perfis de features (Admin, Usuário, CX/CS, custom)
5. **GEIA (I.A.)** — Base de conhecimento, personalidade
6. **Botões** — Config visual dos botões da extensão
7. **Fluxos** — Gerenciamento de automações
8. **Segurança** — Log de token_attempts, sessões ativas
9. **API Keys** — Gerenciamento de chaves API externas
10. **WhatsApp** — Sessões Baileys, chats, contatos
11. **Dhiego-AI** — Gerenciamento de conversas AI
12. **Settings** — Config geral, HubSpot API key

---

## PARTE 2: PROBLEMAS IDENTIFICADOS

### 2.1 CRÍTICO — Segurança

**Problema**: A chave `AUTH_SERVICE_KEY` (service_role do Supabase) está embutida no `background.js` (linha 6). Essa chave tem acesso TOTAL ao banco de dados, bypass de RLS. Qualquer usuário que inspecionar os arquivos da extensão pode extraí-la.

**Impacto**: Um usuário mal-intencionado poderia ler/modificar dados de TODOS os usuários, deletar tabelas, acessar tokens de outros.

**Solução proposta**: Criar um proxy server-side (Supabase Edge Function ou Vercel API route) que guarda a service key. A extensão passa apenas o token do usuário, e o proxy valida e executa a operação.

**Risco da mudança**: ALTO se feito apressadamente. Precisa de retrocompatibilidade para versões antigas.
**Estratégia de migração**:
1. Criar proxy que aceita as mesmas chamadas
2. Nova versão da extensão usa o proxy
3. Manter a chave antiga funcionando por 30 dias (período de atualização)
4. Após 30 dias, revogar chave e gerar nova (apenas no proxy)

---

### 2.2 ALTO — Manutenção (Arquivos Monolíticos)

**Problema A**: `background.js` com 1838 linhas misturando auth, HubSpot, OpenAI, Google, Supabase, files, versioning em um único arquivo.

**Solução**: Usar `importScripts()` (suportado no MV3 para imports estáticos declarados no topo do service worker) para dividir em módulos:
- `bg-auth.js` — Validação de token, IP detection, device binding
- `bg-hubspot.js` — Todas as chamadas HubSpot com rate limiter
- `bg-openai.js` — Whisper transcription, GEIA chat
- `bg-google.js` — OAuth, Drive, Docs, Meet summary
- `bg-supabase.js` — Passthrough REST genérico
- `background.js` — Apenas roteamento de mensagens (dispatch)

**Impacto funcional**: ZERO. É reorganização interna. O message listener continua idêntico, apenas chama funções de outros arquivos.

**Impacto no usuário**: NENHUM. Tokens não são afetados. Nenhuma tabela é alterada.

---

**Problema B**: `admin.html` com 6914 linhas (HTML + JS + CSS inline).

**Solução**: Separar JS em arquivo externo `admin.js` e CSS em `admin.css`. Opcionalmente, dividir em páginas por seção.

**Impacto funcional**: ZERO. Mesma funcionalidade, melhor organização.

---

**Problema C**: `slice.js` (2644 linhas, 124KB) e `store-bridge.js` (2108 linhas, 96KB) — arquivos enormes.

**Solução**: Extrair sub-módulos como scripts separados declarados no manifest.json:
- De `slice.js`: extrair `unread-marks.js` e `chat-visibility.js`
- De `store-bridge.js`: organizar handlers internamente (não precisa split porque roda no MAIN world)

**Impacto funcional**: ZERO. Comportamento idêntico.

---

### 2.3 ALTO — Confiabilidade

**Problema A**: Sem error tracking. Erros JavaScript só aparecem no console do navegador do usuário. Se algo quebra em produção, não há como saber.

**Solução**: Handler global de `window.onerror` e `unhandledrejection` que captura erros e envia para uma nova tabela `error_logs` no Supabase. Inclui versão da extensão, role do usuário, stack trace.

**Impacto funcional**: ZERO. É um observador passivo, não altera nenhum fluxo.
**Banco de dados**: Cria 1 tabela nova (`error_logs`). Não modifica nada existente.

---

**Problema B**: Cache de deduplicação do `msg-capture.js` faz reset total ao atingir 15000 itens. Após o reset, mensagens recentes podem ser re-capturadas.

**Solução**: Implementar evicção LRU — ao atingir 15000, remove os 5000 mais antigos em vez de limpar tudo.

**Impacto funcional**: POSITIVO. Reduz re-captura de mensagens. A tabela `message_events` tem constraint unique em `(user_id, message_wid)`, então duplicatas são rejeitadas pelo DB, mas a rede é desperdiçada.

---

**Problema C**: Sem suporte offline. CRUD de notas, labels, abas falha silenciosamente quando não há rede.

**Solução**: Write-ahead queue no `chrome.storage.local`. Operações são enfileiradas localmente e processadas quando a conexão retorna.

**Impacto funcional**: POSITIVO. Melhora a experiência sem alterar fluxos existentes.

---

### 2.4 MÉDIO — Performance

**Problema A**: HubSpot rate limiting serial (260ms entre chamadas). Carregar perfil completo (contato + deals + tickets + meetings + notes) leva 1.3s+ mínimo.

**Solução**: Usar batch API do HubSpot v3 (`/crm/v3/objects/{objectType}/batch/read`) ou paralelizar requests dentro do rate limit (4 req/s permite 4 paralelas).

**Impacto funcional**: POSITIVO. Carregamento de contato mais rápido.

---

**Problema B**: `flow-engine.js` faz polling no Supabase a cada 8 segundos para checar `test_requested_at`.

**Solução**: Substituir por Supabase Realtime subscriptions (WebSocket).

**Impacto funcional**: POSITIVO. Resposta instantânea a test requests, sem polling.

---

### 2.5 MÉDIO — Código

**Problema**: Uso de `document.execCommand` (API deprecated pelo W3C) para rich text e digitação no WhatsApp.

**Solução parcial**: Substituir nos editores de notas/MSG por Selection/Range API. MANTER `insertText` para o compose box do WhatsApp (necessário para React synthetic events).

**Impacto funcional**: NENHUM visível para o usuário. Compatibilidade futura melhorada.

---

## PARTE 3: NOVAS FEATURES PROPOSTAS

### 3.1 Quick Reply Templates (Prioridade: ALTA)

**O que é**: Templates de resposta rápida acessíveis digitando `/` no compose box do WhatsApp. Diferente das sequências (que são multi-step e agendáveis) — estas são mensagens únicas inseridas instantaneamente.

**Como funciona**:
1. Usuário digita `/` no compose box → aparece dropdown com lista de templates
2. Digita para filtrar → seleciona com Enter ou clique
3. Template é inserido no compose box com variáveis resolvidas (@nome, @email)

**Implementação**:
- Novo arquivo: `quick-replies.js` (content script no manifest)
- Nova tabela: `quick_replies (id, user_id, shortcut, title, body, is_shared, created_at)`
- Listener de `keydown` no compose box do WhatsApp
- Reutiliza sistema de variáveis do `msg.js`

**Impacto em código existente**: NENHUM. Arquivo novo, tabela nova. Não modifica nada.
**Impacto no token/auth**: NENHUM.
**Versões antigas**: Não são afetadas (ignoram a tabela e o script novo).

---

### 3.2 Timeline do Contato (Prioridade: ALTA)

**O que é**: Visão cronológica unificada de TODAS as interações com um contato: mensagens (de `message_events`), notas (de `observations`), deals/meetings HubSpot — tudo em uma timeline vertical.

**Como funciona**: Nova seção no CRM sidebar, abaixo das notas. Mostra ícones por tipo de evento + data/hora + preview.

**Implementação**:
- Modificação em `content.js` — nova seção HTML no sidebar
- Leitura de dados existentes (message_events, observations, HubSpot cache)
- Possível novo RPC `fn_contact_timeline()` para agregar dados

**Impacto em código existente**: Adiciona uma seção nova ao CRM sidebar. Não modifica seções existentes (labels, notas, HubSpot).
**Impacto no token/auth**: NENHUM.
**Versões antigas**: Não são afetadas.

---

### 3.3 Atalhos de Teclado (Prioridade: ALTA)

**O que é**: Keyboard shortcuts para ações frequentes:
- `Ctrl+Shift+C` — Toggle CRM sidebar
- `Ctrl+Shift+M` — Toggle MSG sidebar
- `Ctrl+Shift+A` — Toggle ABAS sidebar
- `Ctrl+Shift+G` — Toggle GEIA sidebar
- `Escape` — Fechar sidebar atual

**Implementação**:
- Novo arquivo: `shortcuts.js` (content script no manifest)
- `document.addEventListener('keydown', ...)` com detecção de modifier keys
- Chama `window.ezapSidebar.toggle()` (API já existente)

**Impacto em código existente**: ZERO. Usa API pública do sidebar-manager.
**Impacto no token/auth**: NENHUM.
**Versões antigas**: Não são afetadas.

---

### 3.4 Seções Colapsáveis no CRM Sidebar (Prioridade: ALTA)

**O que é**: Cada seção do CRM sidebar (HubSpot, Labels, Notas, Meetings) pode ser colapsada/expandida clicando no título.

**Implementação**:
- Adiciona classes CSS `.ezap-section--collapsible` no `sidebar.css`
- Click handlers nos títulos de seção em `content.js`
- Estado de collapse salvo em `chrome.storage.local`

**Impacto em código existente**: MÍNIMO. Adiciona click handlers e classes CSS. Não remove nada.
**Impacto no token/auth**: NENHUM.
**Versões antigas**: Não são afetadas.

---

### 3.5 Templates Compartilhados (Prioridade: MÉDIA)

**O que é**: Biblioteca de templates de mensagem da organização. Admin cria templates que todos os usuários veem em aba "Compartilhados" no MSG sidebar.

**Implementação**:
- Nova tabela: `shared_templates (id, title, body, category, created_by, active, created_at)`
- Nova aba no MSG sidebar para templates compartilhados
- Painel admin: CRUD de templates compartilhados

**Impacto em código existente**: Adiciona aba no MSG sidebar. Não modifica sequências existentes.
**Versões antigas**: Não são afetadas (ignoram a tabela nova).

---

### 3.6 Smart Notifications (Prioridade: MÉDIA)

**O que é**: Alertas configuráveis: mensagem de contato VIP, SLA estourado (tempo de resposta > threshold), keyword detectada em mensagem recebida.

**Implementação**:
- Nova tabela: `notification_rules (id, user_id, rule_type, config_json, enabled)`
- Extensão de `msg-capture.js` para checar regras após captura
- Chrome `notifications` API (requer adicionar permissão "notifications" no manifest)

**Impacto em código existente**: Adiciona lógica pós-captura no `msg-capture.js`. Não modifica a captura em si.
**Impacto no token/auth**: NENHUM.
**Versões antigas**: Sem a permissão "notifications", não recebem alertas, mas não quebram.

---

### 3.7 Dashboard na Extensão (Prioridade: MÉDIA)

**O que é**: Painel analytics dentro da extensão para admins/supervisores: mensagens enviadas/recebidas hoje, tempo médio de resposta, atividade da equipe.

**Implementação**:
- Novo sidebar ou modal no floating rail
- Usa RPCs existentes (`fn_dashboard_summary`, `fn_admin_overview`)
- Gráficos simples com CSS/SVG (sem biblioteca externa)

**Impacto**: ADITIVO. Novo sidebar registrado no sidebar-manager. Não modifica nada existente.

---

### 3.8 Outras Features (Prioridade: BAIXA)

| Feature | Descrição | Esforço |
|---------|-----------|---------|
| Atribuição de Chat | Atribuir chats a membros da equipe | 4-5 dias |
| Labels em Massa | Aplicar/remover labels em múltiplos contatos | 2-3 dias |
| Exportação CSV | Exportar analytics e contatos | 2-3 dias |
| Transferência de Chat | Transferir conversa com contexto | 3-4 dias |
| Auto-tagging | Labels automáticos por keywords | 2-3 dias |
| Kanban de Deals | Board visual de pipeline HubSpot | 5-7 dias |
| Merge de Contatos | Unificar duplicatas | 5-7 dias |

---

## PARTE 4: MELHORIAS NO CHAT OVERLAY

### 4.1 Navegação por Tabs no Sidebar

**Estado atual**: Sidebars trocados via botões na rail flutuante (direita). Cada clique fecha o anterior e abre o novo.

**Proposta**: Tab bar fixa no topo do sidebar com ícones (CRM, MSG, ABAS, GEIA). O conteúdo troca abaixo, a tab bar permanece visível.

**Arquivo modificado**: `sidebar-manager.js`
**API pública mantida**: `ezapSidebar.toggle/open/close` continua igual — outros módulos não precisam mudar.

### 4.2 Largura Ajustável do Sidebar

**Estado atual**: Hardcoded 340px em `sidebar-manager.js` (linha 7: `var SIDEBAR_W = 340`).

**Proposta**: Drag handle na borda esquerda. Min 280px, max 500px. Salvo em `chrome.storage.local`.

**Arquivo modificado**: `sidebar-manager.js` + `sidebar.css` (CSS variable `--ezap-sidebar-width`)

### 4.3 Busca Dentro do Sidebar

**Estado atual**: Apenas ABAS tem busca interna. CRM e MSG não têm.

**Proposta**: Input de busca no topo de cada sidebar filtrando conteúdo visível. CRM filtra notas/labels, MSG filtra sequências.

---

## PARTE 5: IMPACTO DAS MUDANÇAS

### 5.1 Tabela de Impacto por Mudança

| Mudança | Altera código existente? | Altera banco? | Afeta token? | Versão antiga quebra? |
|---------|:---:|:---:|:---:|:---:|
| Split background.js | Reorganiza, não altera lógica | NÃO | NÃO | NÃO |
| Split admin.html | Reorganiza, não altera lógica | NÃO | NÃO | NÃO |
| Split slice.js | Reorganiza, não altera lógica | NÃO | NÃO | NÃO |
| Error tracking | Adiciona observer passivo | Cria 1 tabela nova | NÃO | NÃO |
| LRU no msg-capture | Modifica evicção de cache | NÃO | NÃO | NÃO |
| Suporte offline | Adiciona queue local | NÃO | NÃO | NÃO |
| Quick Replies | Novo script + tabela | Cria 1 tabela nova | NÃO | NÃO |
| Timeline do Contato | Adiciona seção no CRM | Possível 1 RPC nova | NÃO | NÃO |
| Atalhos de Teclado | Novo script | NÃO | NÃO | NÃO |
| Seções Colapsáveis | Adiciona classes CSS + handlers | NÃO | NÃO | NÃO |
| Templates Compartilhados | Adiciona aba no MSG | Cria 1 tabela nova | NÃO | NÃO |
| Smart Notifications | Estende msg-capture | Cria 1 tabela nova | NÃO | NÃO |
| Tab Navigation | Modifica sidebar-manager | NÃO | NÃO | NÃO |
| Largura Ajustável | Modifica sidebar-manager + CSS | NÃO | NÃO | NÃO |
| Remoção service key | Cria proxy, modifica background | NÃO | NÃO | **SIM (com migração)** |

### 5.2 Ordem de Implementação Recomendada

**Fase 1 — Sem risco, alto valor (1-2 semanas)**
1. Atalhos de teclado (novo script, zero interferência)
2. Seções colapsáveis (CSS + handlers mínimos)
3. Error tracking (observador passivo)
4. LRU no msg-capture (melhoria pontual)

**Fase 2 — Novas features aditivas (2-3 semanas)**
5. Quick Reply Templates (novo script + tabela)
6. Timeline do Contato (nova seção no CRM)
7. Templates Compartilhados (nova aba + tabela)

**Fase 3 — Refatoração (2-3 semanas)**
8. Split background.js em módulos
9. Split slice.js em sub-módulos
10. Separar JS/CSS do admin.html

**Fase 4 — Segurança (1-2 semanas, com migração)**
11. Criar proxy server-side
12. Migrar extensão para usar proxy
13. Período de transição (30 dias)
14. Revogar chave antiga

### 5.3 Garantias

- **NENHUMA mudança altera o sistema de tokens** — `validate_token()`, `generate_token()`, `device_fingerprint` permanecem intactos
- **NENHUMA mudança modifica tabelas existentes** — apenas criação de tabelas novas
- **NENHUMA mudança remove funcionalidade** — todas são aditivas ou reorganização
- **Versões antigas da extensão continuam funcionando** para todas as mudanças EXCETO a remoção da service key (que tem plano de migração gradual)
- **Todas as mudanças podem ser revertidas** — não há operações destrutivas no banco

---

## PARTE 6: PONTOS DE ATENÇÃO — SESSÃO WHATSAPP-SERVER (15/04/2026)

A sessão anterior trabalhou no whatsapp-server (Hetzner) e grupos.html. Nenhum arquivo da Chrome Extension foi tocado, mas estes pontos DEVEM ser considerados:

### 6.1 Campo `photoWorkerHealth` foi REMOVIDO do GET /api/sessions

O photo-worker foi eliminado por completo. O campo `photoWorkerHealth` não existe mais no response do GET /api/sessions.

**Campos alterados:**
- ❌ REMOVIDO: `photoWorkerHealth`
- ✅ ADICIONADO: `quarantine` — `{ enteredAt, reason, durationMs }` ou `null`
- ✅ ADICIONADO: `skip_group_sync` — boolean (default false)

**Ação**: Se admin.html ou extensão referenciar `photoWorkerHealth`, receberá `undefined`. Verificar e atualizar referências.

### 6.2 Rotas HTTP DELETADAS do whatsapp-server

Estas rotas retornam 404 agora:
```
GET  /api/sync/photo-worker/status
POST /api/sync/photo-worker/pause
POST /api/sync/photo-worker/resume
GET  /api/sync/status-all
GET  /api/sync/:sessionId/status
GET  /api/contacts/:sessionId/profile-pic
GET  /api/contacts/:sessionId/chat-photos
POST /api/contacts/:sessionId/enqueue-photos
POST /api/contacts/:sessionId/photos/refresh
```

**A Chrome Extension NÃO chama nenhuma dessas.** Mas não usar em features novas.

### 6.3 Rotas HTTP NOVAS disponíveis

```
POST /api/hubspot/resolve-tickets        — resolve ticket IDs contra mentorados + HubSpot
GET  /api/hubspot/group-history/:sessionId — histórico de grupos criados
POST /api/hubspot/templates/:sessionId   — salvar templates de mensagem
GET  /api/hubspot/templates/:sessionId   — carregar templates de mensagem
POST /api/sessions/:id/quarantine        — entrar em quarentena
POST /api/sessions/:id/quarantine/release — liberar quarentena
GET  /api/sessions/:id/quarantine        — status da quarentena
```

**Oportunidade**: As rotas de templates podem ser integradas na feature 3.5 (Templates Compartilhados).

### 6.4 ⚠️ CRÍTICO — Service Key compartilhada com Hetzner

O whatsapp-server no Hetzner (`87.99.141.235`) usa a **MESMA** `SUPABASE_SERVICE_KEY` (em `/opt/ezap/whatsapp-server/.env`) para TODAS as operações de banco.

**Se a Phase 4 (remoção da service key) revogar essa chave e gerar uma nova:**
1. O `.env` do Hetzner **PRECISA** ser atualizado com a nova chave
2. `pm2 restart ezap-whatsapp` deve ser executado
3. Caso contrário, **TODAS as 20 sessões WhatsApp, criação de grupos, DHIEGO.AI — tudo para de funcionar**

**Procedimento obrigatório na Phase 4:**
```bash
ssh root@87.99.141.235
nano /opt/ezap/whatsapp-server/.env
# Atualizar SUPABASE_SERVICE_KEY=<nova chave>
pm2 restart ezap-whatsapp
```

### 6.5 Tabelas/colunas novas no Supabase (já em produção)

- `wa_sessions.skip_group_sync` — BOOLEAN DEFAULT false (migration 049)
- `mentorados` — já existia, populada por webhook HubSpot
- `app_settings` keys: `hubspot_templates_{sessionId}` (JSON com description/welcome/rejectDm)

**NENHUMA tabela existente foi modificada** (users, user_tokens, labels, observations etc. permanecem intactas).

---

## PARTE 7: CORREÇÕES JÁ IMPLEMENTADAS

### 7.1 Busca accent-insensitive (acentos)

**Problema**: Ao buscar "Fabio" não encontrava "Fábio". A busca era case-insensitive mas não accent-insensitive.

**Solução**: Adicionada função `_stripAccents()` usando `NFD.normalize()` no `api.js`. A função `ezapNormalizeName()` agora remove acentos antes de comparar. Isso corrige automaticamente o `ezapMatchContact()` usado em ~20 pontos do código (abas.js, slice.js, content.js, api.js).

**Arquivos alterados**: `api.js` (linha 80), `slice.js` (2 search handlers), `abas.js` (picker + select-all)

### 7.2 Busca por número de telefone

**Problema**: Não era possível buscar contato pelo número, apenas pelo nome. O WhatsApp nativo permite buscar por número.

**Solução**: O JID do WhatsApp já era salvo em `data-ezap-jid` nas rows do overlay (ex: `5519993473149@c.us`). Os search handlers agora extraem os dígitos do JID e comparam com os dígitos digitados (mínimo 3 dígitos para ativar busca por número).

**Arquivos alterados**: `slice.js` (2 search handlers)

---

## PARTE 8: PERGUNTAS PARA DECISÃO

1. Qual a prioridade: começar por features novas ou refatoração/segurança?
2. A remoção da service key deve ser priorizada mesmo com o risco de migração? (LEMBRAR: afeta Hetzner server também)
3. Quais features do Tier 1 são mais urgentes para o negócio?
4. O domínio do meet-recorder deve ser configurável ou pode ficar hardcoded?
5. O admin.html deve continuar como single-page ou pode ser dividido em páginas?
6. As rotas novas de templates do whatsapp-server devem ser integradas na extensão?
