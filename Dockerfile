FROM oven/bun:1.3.13-debian AS builder
WORKDIR /app

# Skip the Chromium auto-download triggered by Playwright's postinstall —
# we don't render PDFs during `bun run build`, and carrying the ~170 MB
# browser through to the runner stage via `COPY --from=builder` would
# either bloat the runner or get overwritten by the explicit install
# below anyway.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY . .
RUN bun install --frozen-lockfile
# Build-time env vars injected from CI (e.g. GitHub Actions build-args).
# VITE_* vars are baked into the frontend bundle by Vite at build time.
ARG IMPRINT_MD
ENV VITE_IMPRINT_MD=$IMPRINT_MD
ARG MARGINALIA_RELEASE_VERSION
ENV VITE_RELEASE_VERSION=$MARGINALIA_RELEASE_VERSION
RUN bun run build

# ---------------------------------------------------------------------
# Mermaid → PNG renderer (mmdr)
# ---------------------------------------------------------------------
# `mmdr` is the CLI from the `mermaid-rs-renderer` crate — a pure-Rust,
# Chromium-free mermaid renderer. The DOCX export pipeline shells out
# to it per diagram (see apps/server/src/export/mermaid-rust.ts) so the
# embedded image is real bytes, not a labeled-code-block stopgap.
#
# We compile from source rather than pulling the upstream release
# tarball: only x86_64-linux prebuilts are published, and Marginalia's
# image already builds for both linux/amd64 and linux/arm64. `cargo
# install` picks the right target automatically. The Rust toolchain
# stays in this throw-away stage — only the final ~10 MB binary is
# copied into the runner.
#
# Licensing: mermaid-rs-renderer is MIT; transitive deps (resvg, usvg,
# clap, fontdb, ttf-parser, …) are MIT or Apache-2.0 / dual-licensed.
# No copyleft. See THIRD_PARTY_LICENSES.md at the repo root for
# attribution.
# ---------------------------------------------------------------------
FROM rust:1.95-slim-bookworm AS mermaid-builder
# `--locked` consumes the Cargo.lock published with the crate so the
# binary is reproducible; bumping ${MMDR_VERSION} is the only knob
# that should change the resulting bytes.
ARG MMDR_VERSION=0.2.2
RUN cargo install mermaid-rs-renderer --version ${MMDR_VERSION} --locked --root /out

FROM oven/bun:1.3.13-debian AS runner
WORKDIR /app

ENV NODE_ENV=production
ARG MARGINALIA_RELEASE_VERSION
ENV MARGINALIA_RELEASE_VERSION=$MARGINALIA_RELEASE_VERSION

# Fixed UID/GID keeps the deploy script's host volume ownership predictable.
RUN groupadd -g 999 marginalia && useradd -u 999 -g marginalia -s /bin/bash marginalia

# Document storage is isomorphic-git, which needs no binary — but the
# three-way merge behind accepting an edit proposal does. iso-git has no
# recursive merge strategy, so GitStore falls back to `git merge-file`
# (see mergeTextWithNativeGit) for criss-cross histories and overlapping
# hunks. Without the binary that fallback fails and every such proposal
# reports as an unresolvable conflict.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Vendor the single mermaid file we consume (~3 MB) out of the
# builder's `node_modules` into a fixed path. At runtime, the PDF
# exporter reads this file as text and inlines it into the export
# Chromium page (see apps/server/src/export/html-envelope.ts). Every
# other file in the mermaid package — 72 MB of ESM code-split chunks,
# source maps, and unminified bundles — plus mermaid's entire
# transitive-dep graph (cytoscape, dagre, d3, langium, katex, …
# ~50 MB more) are only used when mermaid is loaded as a JS module,
# which we don't do in Node: Chromium loads the self-contained UMD
# from this vendored file. By moving the file out first and then
# doing a production install WITHOUT mermaid as a direct dep, none
# of that tree enters the runtime image.
# Bun hoists packages into `node_modules/.bun/<name>@<version>/…` and
# creates stable version-independent symlinks at each workspace's
# `node_modules/<name>`. We copy through the server's symlink so the
# COPY path doesn't bake in a mermaid version — bumping mermaid in
# package.json doesn't require a Dockerfile edit.
COPY --from=builder /app/apps/server/node_modules/mermaid/dist/mermaid.min.js \
     /app/apps/server/vendor/mermaid.min.js

# Copy the source tree from the builder minus its `node_modules`.
# Full workspace tree is retained so `bun install --frozen-lockfile`
# can validate against the lockfile; production install below skips
# all dev deps.
COPY --from=builder /app/package.json /app/bun.lock ./
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/packages ./packages
COPY deploy-scripts/container-entrypoint.sh /app/entrypoint.sh
# Ship the third-party-license attribution alongside the binary it
# documents (mmdr / mermaid-rs-renderer is MIT — the license text
# travels with the redistributed binary).
COPY --from=builder /app/THIRD_PARTY_LICENSES.md /app/THIRD_PARTY_LICENSES.md

# Re-install, production-only, without mermaid (which we vendored
# above). Using `--trust` with an empty list is fine; the key is
# that the post-install `rm` drops the whole mermaid package and
# bun's orphan sweep can't put it back because we also strip it
# from `node_modules/.bun/`. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
# keeps Chromium out of node_modules — the explicit install into
# /ms-playwright in the next `RUN` block writes it exactly once.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN bun install --frozen-lockfile --production \
  && rm -rf /app/node_modules/mermaid \
            /app/node_modules/.bun/mermaid@* \
            /app/node_modules/.bun/@mermaid-js* \
            /app/node_modules/.bun/cytoscape* \
            /app/node_modules/.bun/dagre* \
            /app/node_modules/.bun/d3* \
            /app/node_modules/.bun/langium@* \
            /app/node_modules/.bun/elkjs@* \
            /app/node_modules/.bun/katex@*

# ---------------------------------------------------------------------
# PDF export: Chromium + system deps for Playwright.
#
# `bunx playwright install-deps chromium` installs the OS packages
# Chromium needs (libnss3, libatk1.0-0, libxkbcommon0, fonts, …) —
# apt-based, must run as root. `bunx playwright install chromium`
# downloads the actual browser binary into PLAYWRIGHT_BROWSERS_PATH.
# Both run BEFORE `USER marginalia`, into a shared path that we then
# chown along with /app so the non-root runtime user can launch it.
#
# Without these steps the server starts fine but the PDF endpoint
# returns 500 `export-engine-missing` (see apps/server/src/export/pdf.ts).
# The ~250 MB image-size hit is unavoidable for PDF fidelity.
# ---------------------------------------------------------------------
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Install ONLY the headless-shell binary, not the full Chrome for
# Testing. As of Playwright 1.49+ these are separate downloads:
#   - `chromium`              → full Chrome (~500 MB) + headless-shell
#   - `chromium-headless-shell` → just the shell (~300 MB)
# We never render in headed mode, so full Chrome is dead weight.
#
# The `install-deps chromium-headless-shell` step still needs to
# resolve apt package lists, so it stays separate from the clean-up.
# Chown in the SAME `RUN` as the download: a later `chown -R` would
# rewrite every touched file into its own layer and double the
# Chromium bytes in the image.
RUN bunx playwright install-deps chromium-headless-shell \
  && bunx playwright install chromium-headless-shell \
  && chown -R marginalia:marginalia /ms-playwright \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Drop the `mmdr` binary onto PATH so the DOCX exporter's subprocess
# wrapper finds it without needing MARGINALIA_MERMAID_BIN to be set.
# Static binary — just `+x` and we're done. Chmod is owned by root
# but readable by `marginalia` after the chown sweep below.
COPY --from=mermaid-builder /out/bin/mmdr /usr/local/bin/mmdr
RUN chmod 0755 /usr/local/bin/mmdr

RUN chmod +x /app/entrypoint.sh \
  && mkdir -p /app/.data \
  && chown -R marginalia:marginalia /app

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
