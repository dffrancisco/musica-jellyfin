#!/bin/sh
set -e

YTDLP_BIN="/usr/local/bin/yt-dlp"

install_deps() {
    echo "→ Instalando ffmpeg, python3 e yt-dlp..."
    apt-get update -qq
    apt-get install -y --no-install-recommends ffmpeg ca-certificates curl python3
    curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
        -o "$YTDLP_BIN"
    chmod a+rx "$YTDLP_BIN"
    rm -rf /var/lib/apt/lists/*
}

if ! "$YTDLP_BIN" --version >/dev/null 2>&1; then
    install_deps
fi

if ! "$YTDLP_BIN" --version >/dev/null 2>&1; then
    echo "✗ Falha ao instalar yt-dlp"
    exit 1
fi

echo "✓ yt-dlp: $($YTDLP_BIN --version)"

cd /app

echo "→ Instalando dependências npm..."
npm ci --omit=dev

export YTDLP_BIN
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

echo "→ Iniciando servidor..."
exec node server.js
