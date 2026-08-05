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

# PORT (e.g. assigned by a launcher) is the web port; the API server gets
# PORT+1 unless MARGINALIA_SERVER_PORT overrides it. Defaults: 5173/3434.
web_port="${PORT:-5173}"
if [ -n "${PORT:-}" ]; then
  server_port="${MARGINALIA_SERVER_PORT:-$((web_port + 1))}"
else
  server_port="${MARGINALIA_SERVER_PORT:-3434}"
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
