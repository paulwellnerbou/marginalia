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

bun --filter @marginalia/web dev &
web_pid=$!

sleep 2

if ! kill -0 "$web_pid" 2>/dev/null; then
  wait "$web_pid"
  exit $?
fi

bun --filter @marginalia/server dev &
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
