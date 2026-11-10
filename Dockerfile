# syntax=docker/dockerfile:1
# Multi-architecture upstream image: build natively on linux/arm64 or with buildx.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
# Upgrade npm first as requested. Application dependencies are installed ONCE.
RUN npm install -g npm@11 && npm install -g pnpm@10.26.1
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
# Reuse the builder's toolchain/dependencies; never install dependencies again.
COPY --from=build /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=build /usr/local/bin/npm /usr/local/bin/npm
COPY --from=build /usr/local/bin/npx /usr/local/bin/npx
COPY --from=build /usr/local/bin/pnpm /usr/local/bin/pnpm
COPY --from=build --chown=node:node /app /app
ENV NODE_ENV=production \
    PORT=5000 \
    STORAGE_DIR=/data/objects \
    PUPPETEER_SKIP_DOWNLOAD=true
RUN mkdir -p /data/objects && chown -R node:node /data
USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "start"]
