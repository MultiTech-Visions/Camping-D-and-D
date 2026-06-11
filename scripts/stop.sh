#!/bin/bash
# 🛑 Campfire Saga — STOP (double-click me)
# Stops the game server. Logged to logs/stop-<timestamp>.log.

source "$(dirname "$0")/_lib.sh" stop
banner "Stop"

if systemctl list-unit-files campfire-saga.service --no-legend 2>/dev/null | grep -q campfire-saga; then
  sudo systemctl stop campfire-saga || fail "could not stop the service"
  ok "Server stopped. Double-click “🔥 Start Campfire Saga” to light it again."
else
  warn "The background service isn't installed; nothing to stop."
fi
hold_open
