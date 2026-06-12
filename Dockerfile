# MediaMTX binary (pinned)
FROM bluenviron/mediamtx:1.19.1 AS mediamtx

FROM node:22-bookworm-slim
WORKDIR /app

COPY --from=mediamtx /mediamtx /usr/local/bin/mediamtx
ENV MEDIAMTX_PATH=/usr/local/bin/mediamtx \
    NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY mediamtx.yml ./
COPY src ./src
COPY mml ./mml
COPY public ./public

# 8080: HTTP (front page, HLS proxy, MML WebSocket) - Railway domain target
# 1935: RTMP ingest - expose via Railway TCP Proxy
EXPOSE 8080 1935

CMD ["node", "src/server.js"]
