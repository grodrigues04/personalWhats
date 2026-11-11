FROM node:22-bookworm-slim

ENV TZ=America/Sao_Paulo

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY sender.js crypto.js outgoing.js ./

RUN mkdir -p /app/auth /app/qr && chown -R node:node /app
USER node

CMD ["node", "sender.js"]
