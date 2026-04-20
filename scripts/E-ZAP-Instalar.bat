@echo off
chcp 65001 >nul
title E-ZAP Instalador
color 0A
mode con: cols=70 lines=25

echo.
echo  ====================================================================
echo                    E-ZAP - Instalador / Atualizador
echo  ====================================================================
echo.
echo   Este programa baixa a ultima versao da extensao E-ZAP e instala
echo   em C:\ezap-ext.
echo.
echo  --------------------------------------------------------------------
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& { try { $url = 'https://raw.githubusercontent.com/beniciorosa/E-ZAP/main/scripts/install-ezap.ps1'; $tmp = Join-Path $env:TEMP 'install-ezap.ps1'; Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -TimeoutSec 30; & $tmp -OpenChrome } catch { Write-Host ''; Write-Host '  ERRO: ' $_.Exception.Message -ForegroundColor Red; Write-Host ''; exit 1 } }"

set "RC=%ERRORLEVEL%"
echo.
echo  --------------------------------------------------------------------
echo.

if not exist "C:\ezap-ext\manifest.json" (
    echo   PRIMEIRA VEZ?
    echo.
    echo   Para ativar a extensao no Chrome:
    echo.
    echo     1. O Chrome ja deve ter aberto na pagina chrome://extensions
    echo     2. Ative "Modo do desenvolvedor" no canto superior direito
    echo     3. Clique "Carregar sem compactacao"
    echo     4. Selecione a pasta:  C:\ezap-ext
    echo     5. Pronto! Abra o WhatsApp Web.
    echo.
) else (
    echo   ATUALIZACAO PRONTA
    echo.
    echo   Para aplicar a nova versao:
    echo.
    echo     1. O Chrome ja deve ter aberto em chrome://extensions
    echo     2. Encontre a extensao E-ZAP
    echo     3. Clique no botao com o icone circular (Recarregar)
    echo     4. Recarregue a aba do WhatsApp Web (F5)
    echo.
)

echo  --------------------------------------------------------------------
echo.
pause
exit /b %RC%
