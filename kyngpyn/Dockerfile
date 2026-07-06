FROM node:22-alpine

WORKDIR /app

# Zero runtime dependencies — copy source only.
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    TRADING_MODE=simulation \
    PORT=8420 \
    KYNGPYN_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8420

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8420/api/health || exit 1

USER node
CMD ["node", "src/index.js"]
