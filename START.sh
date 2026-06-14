#!/bin/bash
# 🔥 START — double-click me, choose "Execute in Terminal". That's the whole job:
#   1. starts the game server
#   2. gets the network ready (no WiFi around? it raises the Pi's own
#      CampfireSaga hotspot automatically; already on a WiFi? it just uses that)
#   3. opens the system window: WiFi join QR + game QR + live status
# Then turn this screen off if you like — everyone plays from their phones.
# Everything is logged to logs/start-<timestamp>.log (+ logs/server.log).

source "$(dirname "$0")/scripts/_lib.sh" start
banner "Start everything"
cd "$APP_DIR" || fail "could not enter $APP_DIR"

[ -d node_modules ] || fail "not installed yet — double-click INSTALL.sh first"

# --- 1. the game server -------------------------------------------------------
if systemctl list-unit-files campfire-saga.service --no-legend 2>/dev/null | grep -q campfire-saga; then
  say "Starting the game server…"
  sudo systemctl restart campfire-saga || fail "could not start the service — try INSTALL.sh again"
else
  warn "Background service not installed (INSTALL.sh sets it up) — starting the server directly…"
  nohup node server.js >/dev/null 2>&1 &
  echo $! > logs/server.pid
fi

say "Waiting for the server to answer…"
up=0
for _ in $(seq 1 20); do
  curl -fsS --max-time 1 http://localhost:3000/ >/dev/null 2>&1 && \
  curl -fsS --max-time 1 http://localhost:3001/dm >/dev/null 2>&1 && { up=1; break; }
  sleep 0.5
done
[ "$up" = 1 ] || fail "server did not come up — last lines of logs/server.log:
$(tail -n 20 logs/server.log 2>/dev/null)"
ok "Game server is running"

# --- 2. the network -----------------------------------------------------------
HS_SSID="$(node -p "require('./config').HOTSPOT.SSID")"
HS_PASS="$(node -p "require('./config').HOTSPOT.PASSWORD")"
if ! command -v nmcli >/dev/null; then
  warn "NetworkManager not found — skipping WiFi setup (phones must share a network with the Pi)"
elif nmcli -t -f NAME connection show --active 2>/dev/null | grep -qx "Hotspot"; then
  ok "Campsite hotspot is already on ($HS_SSID)"
elif nmcli -t -f DEVICE,STATE device 2>/dev/null | grep -Eq '^wl.*:connected$'; then
  ok "Pi is on regular WiFi — phones join the same network (no hotspot needed)"
else
  say "No WiFi around — raising the campsite hotspot…"
  if sudo nmcli device wifi hotspot ssid "$HS_SSID" password "$HS_PASS" ifname wlan0; then
    sudo nmcli connection modify Hotspot connection.autoconnect no 2>/dev/null
    ok "Hotspot is ON — network “$HS_SSID”, password “$HS_PASS”"
  else
    warn "Could not raise the hotspot — phones must share a network with the Pi some other way"
  fi
fi

# --- 3. the system window -----------------------------------------------------
STATUS_URL="http://localhost:3001/status"
BROWSER=""
for candidate in chromium-browser chromium firefox; do
  command -v "$candidate" >/dev/null && { BROWSER="$candidate"; break; }
done
if [ -n "$BROWSER" ] && [ -n "$DISPLAY$WAYLAND_DISPLAY" ]; then
  say "Opening the system window…"
  # Launch flags matter here:
  #   --password-store=basic  → no "set a keyring password" popup on first run
  #   --no-first-run          → no welcome wizard
  # setsid -f puts the browser in its own session, so it KEEPS RUNNING after
  # this terminal window closes itself.
  if [ "$BROWSER" = "firefox" ]; then
    BROWSER_CMD=("$BROWSER" "$STATUS_URL")
  else
    BROWSER_CMD=("$BROWSER" --app="$STATUS_URL" --password-store=basic --no-first-run \
      --noerrdialogs --disable-session-crashed-bubble)
  fi
  if command -v setsid >/dev/null; then
    setsid -f "${BROWSER_CMD[@]}" >/dev/null 2>&1
  else
    nohup "${BROWSER_CMD[@]}" >/dev/null 2>&1 &
    disown
  fi
  say "(If the window doesn't appear, open $STATUS_URL in any browser on the Pi.)"
else
  warn "No browser/desktop here — open $STATUS_URL yourself to see the QR codes"
fi

echo
ok "EVERYTHING IS ON. The system window shows the QR codes — then feel free to"
ok "turn this screen off. The game lives on everyone's phones."
print_urls
close_soon
