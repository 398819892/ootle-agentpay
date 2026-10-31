# AgentPay dashboard — production image.
#
# Build from the REPO ROOT (the context must include clients/ts/dist):
#   docker build -f web/Dockerfile -t agentpay-dashboard .
#
# The dashboard is zero-dependency: it needs only Node 18+, the server, the public SPA and the
# pre-built TS client (clients/ts/dist). There is no `npm install` and no build step.
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    AGENTPAY_STATE_FILE=/data/state.json

WORKDIR /app

# The committed, pre-built TS client the backend drives the chain with.
COPY --chown=node:node clients/ts/dist ./clients/ts/dist
COPY --chown=node:node clients/ts/package.json ./clients/ts/package.json

# The dashboard itself.
COPY --chown=node:node web/server ./web/server
COPY --chown=node:node web/public ./web/public

# Writable location for the runtime state file (mount a volume here to persist across restarts).
RUN mkdir -p /data && chown -R node:node /data

USER node
EXPOSE 8787

# Minimal healthcheck: the public session endpoint needs no auth and no chain.
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||8787) +'/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "web/server/server.js"]
