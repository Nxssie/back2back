#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cleanup() {
    trap - SIGINT SIGTERM EXIT
    echo ""
    echo "Stopping the development server..."
    # Kill the entire process group so bun's child processes also die cleanly
    kill -- -"$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
    stty sane 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM EXIT

echo "🎵 Starting Back2Back..."

# set -m gives the background job its own process group, so Ctrl+C doesn't
# reach the child directly — cleanup() handles shutdown in order.
set -m
(cd "$SCRIPT_DIR/packages/server" && exec bun --env-file="$SCRIPT_DIR/.env" run dev) &
SERVER_PID=$!
set +m

echo ""
echo "✅ Server started on http://localhost:3001"
echo ""
echo "Press Ctrl+C to stop"
