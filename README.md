# WhatsApp Integration para Claude

Duas formas de integrar WhatsApp com Claude:

## 1. MCP Server (`mcp-whatsapp/`)

Servidor MCP que expoe ferramentas WhatsApp para o Claude.

### Setup

```bash
cd mcp-whatsapp
npm install
npm run build
```

### Configurar no Claude Desktop

Adicione ao arquivo `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["C:\\Users\\dhiee\\OneDrive\\Desktop\\zap1\\mcp-whatsapp\\dist\\index.js"]
    }
  }
}
```

### Configurar no Claude Code

Adicione ao arquivo `~/.claude/settings.json` ou `.claude/settings.json` do projeto:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["C:\\Users\\dhiee\\OneDrive\\Desktop\\zap1\\mcp-whatsapp\\dist\\index.js"]
    }
  }
}
```

## 2. Plugin Cowork (`cowork-whatsapp-plugin/`)

Plugin para a aba Extensoes do Claude Cowork.

```bash
cd cowork-whatsapp-plugin
npm install
npm run build
```

## Primeiro uso

1. Inicie o servidor/plugin
2. No terminal do servidor, aparecera um QR code
3. Escaneie com WhatsApp > Configuracoes > Dispositivos Conectados > Conectar Dispositivo
4. Apos conectar, todas as ferramentas ficam disponiveis

## Ferramentas disponiveis

| Ferramenta | Descricao |
|---|---|
| `whatsapp_get_status` | Status da conexao |
| `whatsapp_get_qr` | QR code para autenticacao |
| `whatsapp_send_message` | Enviar mensagem texto |
| `whatsapp_send_image` | Enviar imagem |
| `whatsapp_read_messages` | Ler mensagens de um chat |
| `whatsapp_search_messages` | Buscar mensagens |
| `whatsapp_get_chats` | Listar conversas |
| `whatsapp_get_contacts` | Listar contatos |
| `whatsapp_get_contact_info` | Info de contato |
| `whatsapp_get_groups` | Listar grupos |
| `whatsapp_get_group_info` | Info do grupo |
| `whatsapp_set_group_subject` | Renomear grupo |
| `whatsapp_set_group_description` | Alterar descricao do grupo |
| `whatsapp_get_labels` | Listar etiquetas (Business) |
| `whatsapp_add_label_to_chat` | Adicionar etiqueta |
| `whatsapp_mark_as_read` | Marcar como lido |
| `whatsapp_archive_chat` | Arquivar/desarquivar |
| `whatsapp_pin_chat` | Fixar/desfixar |
| `whatsapp_mute_chat` | Silenciar/ativar |
