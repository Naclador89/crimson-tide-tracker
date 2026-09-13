# Small, non-root, no build step — the service is plain Node with one dependency.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first so a code change does not invalidate the install layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js keys.js ./

# Subscriptions live here; mount a volume so they survive a container replacement.
ENV DATA_FILE=/data/subscriptions.json
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8080

# The relay answers /health; the orchestrator can use it to decide readiness.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
