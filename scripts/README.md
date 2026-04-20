# E-ZAP — Scripts utilitarios

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
