#!/bin/sh

set -eu

SERVER_PORT="${PORT:-3434}"
WEB_PORT="${WEB_PORT:-5173}"

listening_pids() {
  lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

kill_port() {
  port="$1"
  pids="$(listening_pids "$port")"
  if [ -z "$pids" ]; then
    return 0
  fi

  kill $pids 2>/dev/null || true

  attempts=0
  while [ "$attempts" -lt 20 ]; do
    if [ -z "$(listening_pids "$port")" ]; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 0.1
  done

  pids="$(listening_pids "$port")"
  if [ -n "$pids" ]; then
    kill -9 $pids 2>/dev/null || true
  fi
}

kill_port "$WEB_PORT"
kill_port "$SERVER_PORT"