#!/bin/bash
# E-ZAP - Instalador / Atualizador pro Mac
# Duplo-clique no Finder pra rodar.
# Baixa a ultima versao em ~/ezap-ext e abre chrome://extensions/
#
# Se o Mac bloquear na primeira vez ("nao foi possivel abrir"):
#   - Clique com o botao direito no arquivo > Abrir > Abrir
#   - OU rode no Terminal: chmod +x E-ZAP-Instalar.command

set -e

RELEASE_URL="https://xsqpqdjffjqxdcmoytfc.supabase.co/storage/v1/object/public/releases/release.json"
DEST="$HOME/ezap-ext"
TMP_JSON="/tmp/ezap-release.json"
TMP_ZIP="/tmp/ezap.zip"

clear
echo "========================================"
echo "        E-ZAP - Instalador Mac"
echo "========================================"
echo ""

# Pre-requisitos (todos vem no macOS padrao)
for cmd in curl unzip python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[ERRO] Comando '$cmd' nao encontrado."
    echo "       Instale o Xcode Command Line Tools: xcode-select --install"
    read -p "Pressione Enter pra sair..."
    exit 1
  fi
done

echo ">>> Buscando ultima versao..."
if ! curl -fSL "$RELEASE_URL" -o "$TMP_JSON" 2>/dev/null; then
  echo "[ERRO] Nao foi possivel baixar release.json."
  echo "       Verifique sua conexao com a internet ou firewall."
  read -p "Pressione Enter pra sair..."
  exit 1
fi

URL=$(python3 -c 'import json;print(json.load(open("/tmp/ezap-release.json"))["url"])')
VER=$(python3 -c 'import json;print(json.load(open("/tmp/ezap-release.json"))["version"])')
NOTES=$(python3 -c 'import json;print(json.load(open("/tmp/ezap-release.json")).get("notes",""))' 2>/dev/null || echo "")

echo "    Versao: $VER"
if [ -n "$NOTES" ]; then
  echo "    Notas:  $NOTES"
fi
echo ""

# Versao atual instalada (se houver)
INSTALLED=""
if [ -f "$DEST/manifest.json" ]; then
  INSTALLED=$(python3 -c "import json;print(json.load(open('$DEST/manifest.json'))['version'])" 2>/dev/null || echo "?")
fi

if [ -n "$INSTALLED" ] && [ "$INSTALLED" = "$VER" ]; then
  echo ">>> Ja esta na versao mais recente ($INSTALLED)."
  echo ""
else
  if [ -n "$INSTALLED" ]; then
    echo ">>> Atualizando $INSTALLED -> $VER..."
  fi

  echo ">>> Baixando ZIP..."
  curl -fSL "$URL" -o "$TMP_ZIP"
  SIZE_KB=$(( $(stat -f%z "$TMP_ZIP" 2>/dev/null || stat -c%s "$TMP_ZIP") / 1024 ))
  echo "    Baixado: ${SIZE_KB} KB"

  echo ">>> Extraindo em $DEST..."
  rm -rf "$DEST"
  mkdir -p "$DEST"
  unzip -q "$TMP_ZIP" -d "$DEST"
  COUNT=$(find "$DEST" -type f | wc -l | tr -d ' ')
  echo "    $COUNT arquivos extraidos"

  rm -f "$TMP_ZIP" "$TMP_JSON"

  echo ""
  echo "========================================"
  echo " E-ZAP v$VER instalado!"
  echo "========================================"
  echo " Pasta: $DEST"
  echo ""
fi

echo "PROXIMOS PASSOS:"
if [ -z "$INSTALLED" ]; then
  echo "  1. O Chrome vai abrir em chrome://extensions/"
  echo "  2. Ative 'Modo do desenvolvedor' (canto superior direito)"
  echo "  3. Clique em 'Carregar sem compactacao'"
  echo "  4. Selecione a pasta: $DEST"
else
  echo "  1. O Chrome vai abrir em chrome://extensions/"
  echo "  2. Clique no icone de reload (circular) no card da E-ZAP"
  echo "  3. Recarregue a aba do WhatsApp Web (Cmd+R)"
fi
echo ""

echo ">>> Abrindo Chrome..."
if ! open -a "Google Chrome" "chrome://extensions/" 2>/dev/null; then
  echo "[AVISO] Google Chrome nao encontrado em /Applications."
  echo "        Abra manualmente e acesse: chrome://extensions/"
fi

echo ""
echo "Pronto! Pode fechar esta janela."
read -p "Pressione Enter pra sair..."
