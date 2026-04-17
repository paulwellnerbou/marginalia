#!/bin/bash
set -euo pipefail

SHARED_CADDY_PATH=${SHARED_CADDY_PATH:-/opt/caddy}
LEGACY_NOCTUA_PATH=${LEGACY_NOCTUA_PATH:-/opt/noctua-mail}
LEGACY_MARGINALIA_PATH=${LEGACY_MARGINALIA_PATH:-/opt/marginalia}
SYSTEM_CADDYFILE=${SYSTEM_CADDYFILE:-/etc/caddy/Caddyfile}
NOCTUA_PROD_PORT=${NOCTUA_PROD_PORT:-3654}
NOCTUA_DEV_PORT=${NOCTUA_DEV_PORT:-3655}
MARGINALIA_PROD_PORT=${MARGINALIA_PROD_PORT:-3434}
MARGINALIA_DEV_PORT=${MARGINALIA_DEV_PORT:-3435}

echo "=========================================="
echo "Configuring native Caddy"
echo "Shared path: $SHARED_CADDY_PATH"
echo "System file: $SYSTEM_CADDYFILE"
echo "=========================================="

mkdir -p "$SHARED_CADDY_PATH/sites"

write_site_config() {
  local env_file="$1"
  local site_name="$2"
  local prod_port="$3"
  local dev_port="$4"
  local target_file="$SHARED_CADDY_PATH/sites/$site_name.Caddyfile"

  if [[ ! -f "$env_file" ]]; then
    echo "Skipping $site_name; missing $env_file"
    return
  fi

  unset DOMAIN_PROD DOMAIN_DEV
  set -a
  source "$env_file"
  set +a

  if [[ -z "${DOMAIN_PROD:-}" || -z "${DOMAIN_DEV:-}" ]]; then
    echo "Skipping $site_name; $env_file must define DOMAIN_PROD and DOMAIN_DEV"
    return
  fi

  cat > "$target_file" <<EOF
$DOMAIN_PROD {
    reverse_proxy 127.0.0.1:$prod_port

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Frame-Options "SAMEORIGIN"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    log {
        output file /var/log/caddy/${site_name}-prod-access.log
        format json
    }
}

$DOMAIN_DEV {
    reverse_proxy 127.0.0.1:$dev_port

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Frame-Options "SAMEORIGIN"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    log {
        output file /var/log/caddy/${site_name}-dev-access.log
        format json
    }
}
EOF

  echo "Wrote $target_file"
}

write_site_config "$LEGACY_NOCTUA_PATH/.env.domains" "noctua-mail" "$NOCTUA_PROD_PORT" "$NOCTUA_DEV_PORT"
write_site_config "$LEGACY_MARGINALIA_PATH/.env.domains" "marginalia" "$MARGINALIA_PROD_PORT" "$MARGINALIA_DEV_PORT"

ROOT_CADDYFILE="$SHARED_CADDY_PATH/Caddyfile"
cat > "$ROOT_CADDYFILE" <<'EOF'
{
    email admin@wbou.dev
}

import /opt/caddy/sites/*.Caddyfile
EOF

mkdir -p "$(dirname "$SYSTEM_CADDYFILE")"
cp "$ROOT_CADDYFILE" "$SYSTEM_CADDYFILE"

echo "Validating Caddy config..."
caddy validate --config "$SYSTEM_CADDYFILE"

echo "Reloading native Caddy..."
systemctl reload caddy

echo ""
echo "Native Caddy configured."
echo "Root config: $SYSTEM_CADDYFILE"
echo "Sites path:  $SHARED_CADDY_PATH/sites"
