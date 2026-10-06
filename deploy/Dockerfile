FROM node:22-bookworm-slim

WORKDIR /opt/ompiui
COPY package.json package-lock.json ./
COPY packages ./packages
COPY scripts ./scripts
COPY patches ./patches
RUN npm ci --include=dev && npm run build

ENV OMPIUI_DATA_DIR=/data/ompiui
ENV OMPIUI_ADMIN_DATA_DIR=/data/ompiui
ENV OMPIUI_SERVER_ENTRY=/opt/ompiui/packages/server/dist/bundle-entry.js
EXPOSE 9898 8787
VOLUME ["/data"]

# /api/status answers 401 without the admin token — either proves the manager is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9898/api/status').then(r=>process.exit(r.status===401||r.status===200?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "packages/admin/dist/cli.js", "web", "--host", "0.0.0.0", "--port", "9898"]
