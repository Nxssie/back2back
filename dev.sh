#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cleanup() {
    trap - SIGINT SIGTERM EXIT
    echo ""
    echo "Stopping development servers..."
    # Kill entire process groups so bun's child processes also die cleanly
    kill -- -"$SERVER_PID" -"$WEB_PID" 2>/dev/null
    wait "$SERVER_PID" "$WEB_PID" 2>/dev/null
    stty sane 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM EXIT

echo "🎵 Starting Back2Back development servers..."

echo "Starting server on http://localhost:3001..."
# set -m gives each background job its own process group, so Ctrl+C doesn't
# reach the children directly — cleanup() handles shutdown in order.
set -m
(cd "$SCRIPT_DIR/packages/server" && exec bun --env-file="$SCRIPT_DIR/.env" run dev) &
SERVER_PID=$!
set +m

echo "Starting frontend on http://localhost:5173..."
set -m
(cd "$SCRIPT_DIR/packages/web" && exec bun run dev --host) &
WEB_PID=$!
set +m

echo ""
echo "✅ Development servers started!"
echo "   Frontend: http://localhost:5173"
echo "   Backend:  http://localhost:3001"
echo ""
echo "Press Ctrl+C to stop both servers"

wait "$SERVER_PID" "$WEB_PID"
