#!/bin/bash
set -euo pipefail

BASE_TITLE="Marginalia"
ENV_LABEL="${APP_ENV_LABEL:-}"

if [[ -n "$ENV_LABEL" ]]; then
  APP_TITLE="$BASE_TITLE ($ENV_LABEL)"
else
  APP_TITLE="$BASE_TITLE"
fi

WEB_DIR="${MARGINALIA_WEB_DIR:-/app/apps/web/dist}"
INDEX_FILE="$WEB_DIR/index.html"
if [[ -f "$INDEX_FILE" ]]; then
  APP_TITLE="$APP_TITLE" INDEX_FILE="$INDEX_FILE" bun --eval '
const fs = require("node:fs");

const indexFile = process.env.INDEX_FILE;
const appTitle = process.env.APP_TITLE || "Marginalia";

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

try {
  const current = fs.readFileSync(indexFile, "utf8");
  const next = current.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(appTitle)}</title>`);
  if (next !== current) {
    fs.writeFileSync(indexFile, next);
  }
  console.log(`[entrypoint] using title: ${appTitle}`);
} catch (error) {
  console.warn(`[entrypoint] failed to update title: ${error.message}`);
}
'
fi

exec bun --bun /app/apps/server/src/main.ts
