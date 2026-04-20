# ===== E-ZAP Extension Updater =====
# Baixa a ultima versao da extensao E-ZAP do Supabase Storage e extrai
# em C:\ezap-ext (padrao), pronto pra carregar como "Unpacked" no Chrome.
#
# Uso:
#   .\install-ezap.ps1                 # atualiza C:\ezap-ext
#   .\install-ezap.ps1 -Dest D:\X      # destino customizado
#   .\install-ezap.ps1 -OpenChrome     # abre chrome://extensions no fim
#
# Setup inicial (uma vez):
#   1. Rode este script: .\install-ezap.ps1
#   2. Abra chrome://extensions no Chrome
#   3. Ative "Modo do desenvolvedor" no canto superior direito
#   4. Clique "Carregar sem compactacao" e selecione C:\ezap-ext
#
# Pra atualizar:
#   - Rode .\install-ezap.ps1 de novo
#   - No Chrome, va em chrome://extensions e clique no botao reload (ícone circular) da E-ZAP

param(
    [string]$Dest = "C:\ezap-ext",
    [switch]$OpenChrome,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ReleaseUrl = "https://xsqpqdjffjqxdcmoytfc.supabase.co/storage/v1/object/public/releases/release.json"

function Write-Step {
    param([string]$Msg, [string]$Color = "Cyan")
    Write-Host ""
    Write-Host ">>> $Msg" -ForegroundColor $Color
}

function Write-Ok {
    param([string]$Msg)
    Write-Host "    [OK] $Msg" -ForegroundColor Green
}

function Write-Err {
    param([string]$Msg)
    Write-Host "    [ERRO] $Msg" -ForegroundColor Red
}

try {
    # 1. Buscar release.json
    Write-Step "Buscando ultima versao..."
    $release = Invoke-RestMethod -Uri $ReleaseUrl -TimeoutSec 30
    if (-not $release.version -or -not $release.url) {
        throw "release.json invalido (sem version ou url)"
    }
    Write-Ok "Versao mais recente: $($release.version)"
    if ($release.notes) {
        Write-Host "    Notas: $($release.notes)" -ForegroundColor DarkGray
    }

    # 2. Verificar versao instalada (manifest.json)
    $installedVersion = $null
    $manifestPath = Join-Path $Dest "manifest.json"
    if (Test-Path $manifestPath) {
        try {
            $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
            $installedVersion = $manifest.version
        } catch {
            $installedVersion = "?"
        }
    }
    if ($installedVersion -and -not $Force) {
        if ($installedVersion -eq $release.version) {
            Write-Step "Ja esta na versao mais recente ($installedVersion). Use -Force para reinstalar." "Yellow"
            exit 0
        }
        Write-Host "    Versao instalada: $installedVersion -> nova: $($release.version)" -ForegroundColor DarkGray
    }

    # 3. Baixar ZIP
    Write-Step "Baixando $($release.url)..."
    $tempZip = Join-Path $env:TEMP ("ezap-" + $release.version + ".zip")
    if (Test-Path $tempZip) { Remove-Item $tempZip -Force }
    Invoke-WebRequest -Uri $release.url -OutFile $tempZip -TimeoutSec 120
    $zipSize = (Get-Item $tempZip).Length
    Write-Ok ("Baixado: " + [math]::Round($zipSize / 1KB, 1) + " KB")

    # 4. Preparar diretorio destino (limpa se existir)
    Write-Step "Preparando $Dest..."
    if (Test-Path $Dest) {
        # Backup do storage local do Chrome (se houver chrome.storage data)
        # Nada a salvar aqui — chrome.storage fica no profile do Chrome, nao na pasta da ext.
        Get-ChildItem $Dest -Force | Remove-Item -Recurse -Force
    } else {
        New-Item -ItemType Directory -Path $Dest -Force | Out-Null
    }
    Write-Ok "Pasta limpa"

    # 5. Extrair ZIP
    Write-Step "Extraindo extensao..."
    Expand-Archive -Path $tempZip -DestinationPath $Dest -Force
    $fileCount = (Get-ChildItem $Dest -Recurse -File).Count
    Write-Ok "$fileCount arquivos extraidos em $Dest"

    # 6. Cleanup
    Remove-Item $tempZip -Force -ErrorAction SilentlyContinue

    # 7. Resumo
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host " E-ZAP v$($release.version) instalado!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host " Pasta: $Dest" -ForegroundColor Gray
    Write-Host ""
    Write-Host " PROXIMOS PASSOS:" -ForegroundColor Yellow
    if (-not $installedVersion) {
        Write-Host "   1. Abra chrome://extensions"
        Write-Host "   2. Ative 'Modo do desenvolvedor' (canto sup direito)"
        Write-Host "   3. Clique 'Carregar sem compactacao' e selecione $Dest"
    } else {
        Write-Host "   1. Abra chrome://extensions"
        Write-Host "   2. Clique no botao de reload (icone circular) na E-ZAP"
        Write-Host "   3. (ou recarregue a aba do WhatsApp Web)"
    }
    Write-Host ""

    # 8. Abrir Chrome se solicitado
    if ($OpenChrome) {
        Write-Step "Abrindo chrome://extensions..."
        Start-Process "chrome.exe" -ArgumentList "chrome://extensions" -ErrorAction SilentlyContinue
    }

} catch {
    Write-Err $_.Exception.Message
    Write-Host ""
    Write-Host "Detalhes:" -ForegroundColor DarkGray
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    exit 1
}
