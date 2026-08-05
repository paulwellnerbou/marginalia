#!/bin/sh

set -eu

cleanup() {
  if [ -n "${server_pid:-}" ]; then
    kill "$server_pid" 2>/dev/null || true
  fi
  if [ -n "${web_pid:-}" ]; then
    kill "$web_pid" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

is_port() {
  case "${1:-}" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# PORT (e.g. assigned by a launcher) is the web port; the API server gets
# PORT+1 unless MARGINALIA_SERVER_PORT overrides it. Defaults: 5173/3434.
# Both are validated first: under `set -u` a non-numeric value in the
# arithmetic below would abort before either server starts.
if is_port "${PORT:-}"; then
  web_port="$PORT"
  server_default=$((web_port + 1))
  is_port "$server_default" || server_default=3434
else
  if [ -n "${PORT:-}" ]; then
    echo "[dev] ignoring PORT=$PORT; using 5173" >&2
  fi
  web_port=5173
  server_default=3434
fi

if is_port "${MARGINALIA_SERVER_PORT:-}"; then
  server_port="$MARGINALIA_SERVER_PORT"
else
  if [ -n "${MARGINALIA_SERVER_PORT:-}" ]; then
    echo "[dev] ignoring MARGINALIA_SERVER_PORT=$MARGINALIA_SERVER_PORT; using $server_default" >&2
  fi
  server_port="$server_default"
fi

PORT="$web_port" MARGINALIA_SERVER_PORT="$server_port" bun --filter @marginalia/web dev &
web_pid=$!

sleep 2

if ! kill -0 "$web_pid" 2>/dev/null; then
  wait "$web_pid"
  exit $?
fi

PORT="$server_port" bun --filter @marginalia/server dev &
server_pid=$!

while :; do
  if ! kill -0 "$web_pid" 2>/dev/null; then
    wait "$web_pid"
    exit $?
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    wait "$server_pid"
    exit $?
  fi
  sleep 1
done
