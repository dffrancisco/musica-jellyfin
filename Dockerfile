# OPCIONAL — só se quiser imagem própria com yt-dlp já embutido (mais rápido ao subir).
# Estratégia padrão: imagem node:22 + entrypoint.sh (sem usar este Dockerfile).

FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
        -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js public ./

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
