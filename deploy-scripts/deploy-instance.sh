#!/bin/bash
set -e

# Deploy a specific instance (dev or prod) to the target host without git checkout
# This script is designed to be piped via SSH from CI/CD

INSTANCE=${1:-dev}
IMAGE_TAG=${2:-latest}
DEPLOY_PATH=${DEPLOY_PATH:-/opt/marginalia}
REGISTRY=${REGISTRY:-ghcr.io}
IMAGE_NAME=${IMAGE_NAME:-$GITHUB_REPOSITORY}
FULL_IMAGE="$REGISTRY/$IMAGE_NAME:$IMAGE_TAG"
CONTAINER_NETWORK=${CONTAINER_NETWORK:-}
HOST_BIND_IP=${HOST_BIND_IP:-127.0.0.1}

if [[ "$INSTANCE" != "dev" && "$INSTANCE" != "prod" ]]; then
  echo "Error: Instance must be 'dev' or 'prod'"
  exit 1
fi

echo "=========================================="
echo "Deploying Marginalia - $INSTANCE"
echo "Image: $FULL_IMAGE"
echo "=========================================="

mkdir -p "$DEPLOY_PATH/data-$INSTANCE"
chown -R 999:999 "$DEPLOY_PATH/data-$INSTANCE"

cd "$DEPLOY_PATH"

if [[ -n "$GITHUB_TOKEN" ]]; then
  echo "Logging in to $REGISTRY..."
  echo "$GITHUB_TOKEN" | docker login "$REGISTRY" -u "$GITHUB_ACTOR" --password-stdin 2>/dev/null || echo "Warning: Registry login failed"
fi

echo "Pulling Docker image..."
docker pull "$FULL_IMAGE"

echo "Stopping old container..."
docker stop marginalia-$INSTANCE 2>/dev/null || true
docker rm marginalia-$INSTANCE 2>/dev/null || true

ENV_FILE="$DEPLOY_PATH/.env.$INSTANCE"
if [[ -f "$ENV_FILE" ]]; then
  echo "Loading environment from $ENV_FILE"
  set -a
  source "$ENV_FILE"
  set +a
else
  echo "Warning: $ENV_FILE not found, using defaults"
fi

DEFAULT_APP_ENV_LABEL=""
if [[ "$INSTANCE" == "dev" ]]; then
  DEFAULT_APP_ENV_LABEL="DEV"
fi

APP_ENV_LABEL_VALUE="${APP_ENV_LABEL:-$DEFAULT_APP_ENV_LABEL}"
PORT_VALUE="${PORT:-3434}"
DATA_DIR_VALUE="${MARGINALIA_DATA_DIR:-/app/.data/}"
WEB_DIR_VALUE="${MARGINALIA_WEB_DIR:-/app/apps/web/dist}"
DEFAULT_HOST_PORT=3434
if [[ "$INSTANCE" == "dev" ]]; then
  DEFAULT_HOST_PORT=3435
fi
HOST_PORT_VALUE="${HOST_PORT:-$DEFAULT_HOST_PORT}"

DOCKER_ARGS=(
  -d
  --name "marginalia-$INSTANCE"
  --restart unless-stopped
  --memory=512m
  --memory-reservation=256m
  -v "$DEPLOY_PATH/data-$INSTANCE:/app/.data"
  -p "$HOST_BIND_IP:$HOST_PORT_VALUE:$PORT_VALUE"
  -e PORT="$PORT_VALUE"
  -e MARGINALIA_DATA_DIR="$DATA_DIR_VALUE"
  -e MARGINALIA_WEB_DIR="$WEB_DIR_VALUE"
  -e APP_ENV_LABEL="$APP_ENV_LABEL_VALUE"
)

# Optional passthrough vars, set in .env.$INSTANCE.
#
# MARGINALIA_TRUST_PROXY=1 makes per-client rate limits read
# X-Forwarded-For. Needed here because the container publishes to
# HOST_BIND_IP (127.0.0.1 by default) behind a reverse proxy, so without
# it every request looks like it came from the proxy.
#
# Blob storage: fs (default) keeps binaries in the mounted /app/.data
# volume at .data/blobs. Setting MARGINALIA_BLOB_STORAGE=s3 in the
# .env.$INSTANCE file switches to an S3-compatible bucket; credentials
# come from the companion MARGINALIA_S3_* vars in the same file.
# Forwarded explicitly here (rather than --env-file) so the script
# still enumerates every knob it passes through — a var added to
# .env.$INSTANCE but not to this list is silently ignored.
#
# IMPORTANT: use `-e NAME` (no value) rather than `-e NAME=VALUE` so
# credentials aren't embedded in the docker argv — otherwise the
# MARGINALIA_S3_SECRET_ACCESS_KEY shows up in `ps aux` on the host
# (and often in CI logs that echo commands). Docker reads the value
# from the parent shell's environment; the earlier `set -a; source
# $ENV_FILE` already exported these.
for var in MARGINALIA_TRUST_PROXY \
           MARGINALIA_BLOB_STORAGE \
           MARGINALIA_S3_BUCKET \
           MARGINALIA_S3_ACCESS_KEY_ID \
           MARGINALIA_S3_SECRET_ACCESS_KEY \
           MARGINALIA_S3_ENDPOINT \
           MARGINALIA_S3_REGION \
           MARGINALIA_S3_PREFIX \
           MARGINALIA_S3_VIRTUAL_HOSTED; do
  if [[ -n "${!var:-}" ]]; then
    DOCKER_ARGS+=(-e "$var")
  fi
done

if [[ -n "$CONTAINER_NETWORK" ]]; then
  DOCKER_ARGS+=(--network "$CONTAINER_NETWORK")
fi

echo "Starting new container..."
docker run "${DOCKER_ARGS[@]}" "$FULL_IMAGE"

echo "Waiting for container to start..."
sleep 5

if docker ps | grep -q "marginalia-$INSTANCE"; then
  echo "✅ Deployment successful!"
  docker ps | grep "marginalia-$INSTANCE"
else
  echo "❌ Deployment failed! Container is not running."
  docker logs --tail=50 marginalia-$INSTANCE
  exit 1
fi

echo ""
echo "Recent logs:"
docker logs --tail=20 marginalia-$INSTANCE

echo ""
echo "Cleaning up old images..."
docker images "$REGISTRY/$IMAGE_NAME" --format "{{.ID}}" | tail -n +4 | xargs -r docker rmi -f 2>/dev/null || true

echo ""
echo "=========================================="
echo "✅ $INSTANCE deployment complete!"
echo "Container: marginalia-$INSTANCE"
echo "Image: $FULL_IMAGE"
echo "Host port: $HOST_BIND_IP:$HOST_PORT_VALUE -> $PORT_VALUE"
echo "=========================================="
