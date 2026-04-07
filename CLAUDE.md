# E-ZAP - Instrucoes do Projeto

## Sobre o projeto
Chrome Extension (Manifest V3) para gestao de WhatsApp Business. Inclui CRM, mensagens automaticas, notas, abas e sistema de notificacoes do admin.

## Estrutura principal
- `chrome-extension/` — Codigo da extensao (auth.js, content.js, msg.js, background.js, etc.)
- `admin.html` — Painel administrativo (deploy via Vercel, push para GitHub)
- `supabase/` — Migrations SQL
- `index.html`, `qr-display.html` — Paginas auxiliares (Vercel)

## Regras de deploy

### Extensao (Chrome Extension)
1. **Sempre incrementar a versao** no `chrome-extension/manifest.json` a cada atualizacao
2. Gerar ZIP da pasta `chrome-extension/` (usar pasta temporaria se arquivos estiverem travados)
3. Subir ZIP no Supabase Storage bucket `releases/` (PUT com service key)
4. Atualizar `releases/release.json` com nova versao, URL e notas

### Admin e paginas web
- Fazer `git push origin main` — deploy automatico no Vercel

### SQL / Migrations
- Rodar via Supabase Management API: `POST https://api.supabase.com/v1/projects/xsqpqdjffjqxdcmoytfc/database/query`
- Sempre salvar o SQL em `supabase/migration_XXX_descricao.sql`

## Credenciais Supabase
- **Project ref**: `xsqpqdjffjqxdcmoytfc`
- **URL**: `https://xsqpqdjffjqxdcmoytfc.supabase.co`
- **Anon key**: no `background.js` linha 5 (AUTH_SUPA_ANON)
- **Service key**: no `background.js` linha 6 (AUTH_SERVICE_KEY)
- **Management API token**: salvo no `.env` (variavel `SUPABASE_MGMT_TOKEN`). NUNCA commitar tokens no repo.
- **IMPORTANTE**: chamar Management API com `User-Agent: Mozilla/5.0 ...` (Cloudflare bloqueia UAs de bot/python/curl com error 1010)

## GitHub
- Repo: `https://github.com/beniciorosa/E-ZAP.git`
- Branch principal: `main`
- Push direto na main (sem PR)

## Convencoes
- Codigo da extensao usa vanilla JS (sem frameworks, sem ES modules)
- Comunicacao content script <-> background via `chrome.runtime.sendMessage`
- Supabase REST via handler `supabase_rest` no background.js
- Idioma da UI: Portugues (BR), sem acentos no codigo
- Commits em ingles com `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`
