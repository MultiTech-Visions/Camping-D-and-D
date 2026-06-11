#!/bin/bash
# 📽 Campfire Saga — PROJECTOR DISPLAY (double-click me)
# Opens the shared display full-screen in kiosk mode for the HDMI projector.
# Press Alt+F4 (or unplug the keyboard and just enjoy) to leave.
# Logged to logs/projector-<timestamp>.log.

source "$(dirname "$0")/_lib.sh" projector
banner "Projector Display"

URL="http://localhost:3000/display"

# Make sure the server is up first.
if ! curl -fsS --max-time 3 "$URL" >/dev/null 2>&1; then
  warn "Server not answering — trying to start it…"
  sudo systemctl restart campfire-saga 2>/dev/null
  sleep 3
  curl -fsS --max-time 3 "$URL" >/dev/null 2>&1 || fail "server still not answering — double-click “🔥 Start Campfire Saga” first"
fi

BROWSER=""
for candidate in chromium-browser chromium firefox; do
  command -v "$candidate" >/dev/null && { BROWSER="$candidate"; break; }
done
[ -n "$BROWSER" ] || fail "no browser found (expected chromium on Raspberry Pi OS)"

ok "Opening $URL full-screen with $BROWSER (Alt+F4 to exit)…"
if [ "$BROWSER" = "firefox" ]; then
  "$BROWSER" --kiosk "$URL"
else
  "$BROWSER" --kiosk --noerrdialogs --disable-session-crashed-bubble --app="$URL"
fi
hold_open
