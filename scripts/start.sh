#!/bin/bash
# 🔥 Campfire Saga — START (double-click me)
# Starts (or restarts) the game server and shows the address players type into
# their phones. Output is also saved to logs/start-<timestamp>.log; the server
# itself always writes to logs/server.log.

source "$(dirname "$0")/_lib.sh" start
banner "Start"
cd "$APP_DIR" || fail "could not enter $APP_DIR"

if systemctl list-unit-files campfire-saga.service --no-legend 2>/dev/null | grep -q campfire-saga; then
  say "Starting the background service…"
  sudo systemctl restart campfire-saga || fail "could not start the service — try the Install icon again"
  sleep 2
  systemctl is-active --quiet campfire-saga || fail "server did not stay up — last server log lines:
$(tail -n 30 logs/server.log 2>/dev/null)"
  ok "Server is running (and survives reboots)"
  print_urls
  echo "   Recent server activity:"
  tail -n 12 logs/server.log 2>/dev/null | sed 's/^/      /'
  hold_open
else
  warn "Service not installed yet — running the server right here instead."
  warn "(Run the Install icon once to make it start automatically on boot.)"
  print_urls
  say "Starting… closing this window will stop the server. Log: logs/server.log"
  node server.js
  hold_open
fi
