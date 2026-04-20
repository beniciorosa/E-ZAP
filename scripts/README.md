# E-ZAP — Scripts utilitarios

## E-ZAP-Instalar.command — Para usuarios Mac

Arquivo unico. **Duplo clique e pronto.** Baixa o ZIP mais recente do
Supabase Storage e instala/atualiza a extensao em `~/ezap-ext`.

### Distribuir

Envie o arquivo `E-ZAP-Instalar.command` pros usuarios Mac (WhatsApp, e-mail,
Drive, AirDrop). Eles so precisam dar duplo clique.

### Primeira vez pro usuario (bloqueio do Gatekeeper)

Ao baixar de fonte externa, o macOS marca o arquivo como "quarantined".
Na **primeira execucao**:

- Clique com **botao direito** no arquivo > **Abrir** > confirma **Abrir**
- (duplo clique normal nao funciona na primeira vez)

Nas seguintes, duplo clique funciona normalmente.

### Se mesmo assim nao executar

No Terminal, dentro da pasta onde salvou o arquivo:

```bash
chmod +x E-ZAP-Instalar.command
xattr -d com.apple.quarantine E-ZAP-Instalar.command 2>/dev/null
./E-ZAP-Instalar.command
```

### Pasta de instalacao

`~/ezap-ext` (ou seja, `/Users/SEU_USUARIO/ezap-ext`)

### Primeira vez no Chrome

1. Quando abrir `chrome://extensions/`:
2. Ative **Modo do desenvolvedor** (canto superior direito)
3. Clique **Carregar sem compactacao**
4. Selecione a pasta `~/ezap-ext`

### Atualizacoes

Duplo clique de novo. Depois, em `chrome://extensions/`, clica no icone
circular (reload) no card da E-ZAP. Recarrega o WhatsApp Web (Cmd+R).

### Comando global no Terminal (opcional)

Pra digitar so `ezap-update` em qualquer terminal, cola isto uma vez:

```bash
cat >> ~/.zshrc <<'EOF'

# E-ZAP updater
ezap-update() {
  curl -sSL https://xsqpqdjffjqxdcmoytfc.supabase.co/storage/v1/object/public/releases/release.json -o /tmp/ezap.json && \
  URL=$(python3 -c 'import json;print(json.load(open("/tmp/ezap.json"))["url"])') && \
  VER=$(python3 -c 'import json;print(json.load(open("/tmp/ezap.json"))["version"])') && \
  curl -sSL "$URL" -o /tmp/ezap.zip && \
  rm -rf ~/ezap-ext && mkdir -p ~/ezap-ext && \
  unzip -q /tmp/ezap.zip -d ~/ezap-ext && \
  echo "E-ZAP v$VER em ~/ezap-ext" && \
  open -a "Google Chrome" "chrome://extensions/"
}
EOF
source ~/.zshrc
```

---

## E-ZAP-Instalar.bat — Para os usuarios finais

Arquivo unico. **Duplo clique e pronto.** Baixa o script PowerShell mais
recente do GitHub e instala/atualiza a extensao em `C:\ezap-ext`.

### Distribuir

Envie o arquivo `E-ZAP-Instalar.bat` para os usuarios (WhatsApp, e-mail,
Drive). Eles so precisam dar duplo clique.

### O que o .bat faz

1. Baixa o script `install-ezap.ps1` mais recente do GitHub
2. Roda ele com `-OpenChrome` (abre `chrome://extensions` no fim)
3. Mostra instrucoes diferentes pra primeira instalacao vs atualizacao

### Primeira vez para o usuario

1. Da duplo clique em `E-ZAP-Instalar.bat`
2. Aguarda o download
3. Quando abrir `chrome://extensions`:
   - Ativa "Modo do desenvolvedor" (canto superior direito)
   - Clica "Carregar sem compactacao"
   - Seleciona a pasta `C:\ezap-ext`
4. Pronto. Recarrega o WhatsApp Web.

### Atualizacoes

Mesma coisa: duplo clique no .bat. Quando abrir `chrome://extensions`,
clica no botao circular (Recarregar) na extensao E-ZAP. Recarrega o
WhatsApp Web (F5).

### Link direto pra download

`https://raw.githubusercontent.com/beniciorosa/E-ZAP/main/scripts/E-ZAP-Instalar.bat`

---

## install-ezap.ps1 — Atualizador da extensao

Baixa a ultima versao publicada (release.json no Supabase Storage) e extrai
em `C:\ezap-ext` (pasta padrao). Depois e so recarregar a extensao no Chrome.

### Uso direto

```powershell
.\scripts\install-ezap.ps1                  # atualiza C:\ezap-ext
.\scripts\install-ezap.ps1 -OpenChrome       # ja abre chrome://extensions
.\scripts\install-ezap.ps1 -Dest D:\X        # destino customizado
.\scripts\install-ezap.ps1 -Force            # reinstala mesmo se ja for ultima
```

### Setup inicial (uma vez por maquina)

1. Rode o script: `.\scripts\install-ezap.ps1`
2. Abra `chrome://extensions`
3. Ative **Modo do desenvolvedor** (canto superior direito)
4. Clique **Carregar sem compactacao** e selecione `C:\ezap-ext`

A extensao ficara instalada apontando pra essa pasta. Toda vez que rodar o
script, os arquivos sao atualizados — basta clicar no botao de reload da
extensao (icone circular) em `chrome://extensions`.

### Registrar como comando global (`ezap-update`)

Pra digitar so `ezap-update` em qualquer terminal PowerShell do Windows,
adicione esta funcao ao seu `$PROFILE`:

**Cole no PowerShell** (uma unica vez):

```powershell
$profileDir = Split-Path $PROFILE
if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }
$func = @'

# === E-ZAP updater ===
function ezap-update {
    param([string]$Dest = "C:\ezap-ext", [switch]$OpenChrome, [switch]$Force)
    $url = "https://raw.githubusercontent.com/beniciorosa/E-ZAP/main/scripts/install-ezap.ps1"
    $tmp = Join-Path $env:TEMP "install-ezap.ps1"
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
    $args = @{ Dest = $Dest }
    if ($OpenChrome) { $args.OpenChrome = $true }
    if ($Force) { $args.Force = $true }
    & $tmp @args
}
'@
if (-not (Select-String -Path $PROFILE -Pattern 'function ezap-update' -Quiet)) {
    Add-Content -Path $PROFILE -Value $func
    Write-Host "Comando 'ezap-update' instalado! Reinicie o PowerShell ou rode: . `$PROFILE" -ForegroundColor Green
} else {
    Write-Host "Comando ja estava instalado." -ForegroundColor Yellow
}
```

Depois disso, em qualquer terminal:

```powershell
ezap-update
ezap-update -OpenChrome
ezap-update -Force
```

### Como funciona

1. Le o `release.json` em `https://xsqpqdjffjqxdcmoytfc.supabase.co/storage/v1/object/public/releases/release.json`
2. Compara com a versao instalada em `C:\ezap-ext\manifest.json`
3. Se houver versao nova, baixa o ZIP da release e extrai em `C:\ezap-ext`
4. Mostra a versao instalada + proximos passos

### Permissao de execucao

Se der erro de "execution policy", rode antes (admin):

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```
