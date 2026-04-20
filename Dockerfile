FROM oven/bun:1.3.12-debian AS builder
WORKDIR /app

COPY . .
RUN bun install --frozen-lockfile
# Build-time env vars injected from CI (e.g. GitHub Actions build-args).
# VITE_* vars are baked into the frontend bundle by Vite at build time.
ARG IMPRINT_MD
ENV VITE_IMPRINT_MD=$IMPRINT_MD
RUN bun run build

FROM oven/bun:1.3.12-debian AS runner
WORKDIR /app

ENV NODE_ENV=production

# Fixed UID/GID keeps the deploy script's host volume ownership predictable.
RUN groupadd -g 999 marginalia && useradd -u 999 -g marginalia -s /bin/bash marginalia

COPY --from=builder /app /app
COPY deploy-scripts/container-entrypoint.sh /app/entrypoint.sh

RUN chmod +x /app/entrypoint.sh && mkdir -p /app/.data && chown -R marginalia:marginalia /app

USER marginalia

EXPOSE 3434

ENV PORT=3434
ENV MARGINALIA_DATA_DIR=/app/.data/
ENV MARGINALIA_WEB_DIR=/app/apps/web/dist
ENV APP_ENV_LABEL=

# SQLite, the git repo, and the asset blob store all live under
# MARGINALIA_DATA_DIR. Declaring it as a volume means an ad-hoc
# `docker run` without `-v` still gets durable storage (anonymous
# volume) instead of silently writing to the container's writable
# layer. Production deploys bind-mount over this.
VOLUME ["/app/.data"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD /bin/sh -lc 'bun --bun -e "fetch(\"http://localhost:\" + (process.env.PORT || \"3434\") + \"/health\").then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"'

CMD ["/app/entrypoint.sh"]
