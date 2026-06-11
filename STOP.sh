#!/bin/bash
# 🛑 STOP — double-click me. Shuts the whole thing down:
# stops the game server AND turns the campsite hotspot off (if it was on).
# Logged to logs/stop-<timestamp>.log.

source "$(dirname "$0")/scripts/_lib.sh" stop
banner "Stop everything"
cd "$APP_DIR" || fail "could not enter $APP_DIR"

if systemctl is-active --quiet campfire-saga 2>/dev/null; then
  sudo systemctl stop campfire-saga || fail "could not stop the service"
  ok "Game server stopped"
elif [ -f logs/server.pid ] && kill -0 "$(cat logs/server.pid)" 2>/dev/null; then
  kill "$(cat logs/server.pid)" && rm -f logs/server.pid
  ok "Game server stopped"
else
  say "Game server was not running"
fi

if command -v nmcli >/dev/null && nmcli -t -f NAME connection show --active 2>/dev/null | grep -qx "Hotspot"; then
  sudo nmcli connection down Hotspot && ok "Campsite hotspot turned off (Pi rejoins its usual WiFi)" \
    || warn "could not stop the hotspot"
else
  say "Hotspot was not on"
fi

ok "All quiet. Double-click START.sh next game night."
close_soon
