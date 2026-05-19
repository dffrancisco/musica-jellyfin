#!/bin/sh
# Usa imagem oficial node:22 do Docker Hub (sem build)
set -e

cd "$(dirname "$0")"
mkdir -p "$HOME/.docker" ./downloads
export DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}"
chmod +x entrypoint.sh

echo "→ Baixando imagem node:22-bookworm-slim..."
docker pull node:22-bookworm-slim

echo "→ Removendo container antigo (se existir)..."
docker rm -f zima-dlp-ytb 2>/dev/null || true

echo "→ Subindo container..."
docker run -d \
  --name zima-dlp-ytb \
  --user root \
  --restart unless-stopped \
  -p 3000:3000 \
  -w /app \
  -v "$(pwd):/app" \
  -v "$(pwd)/downloads:/app/downloads" \
  -e NODE_ENV=production \
  -e YTDLP_DISABLE_COOKIES=1 \
  -e YTDLP_BIN=/usr/local/bin/yt-dlp \
  --entrypoint /bin/sh \
  node:22-bookworm-slim \
  /app/entrypoint.sh

echo ""
echo "→ Acompanhe o log (primeira vez demora ~1–2 min):"
echo "   docker logs -f zima-dlp-ytb"
echo ""
echo "Depois abra: http://$(hostname -I 2>/dev/null | awk '{print $1}'):3000"
echo "Pasta de destino na tela: /app/downloads"
