#!/bin/bash
# 🔥 INSTALL — double-click me ONCE on a fresh Pi, choose "Execute in Terminal".
#   1. makes sure Node.js 18+ and build tools are installed
#   2. installs the app's dependencies ON THIS MACHINE (native modules like
#      better-sqlite3 must be compiled for the Pi's own CPU — never copy
#      node_modules from another computer)
#   3. registers the background service (used by START.sh / STOP.sh — nothing
#      ever starts on boot; this Pi has other jobs)
#   4. runs the self-test and verifies the server actually boots
# After this, day-to-day is just START.sh and STOP.sh in this folder.
# Every line is saved to logs/install-<timestamp>.log.

source "$(dirname "$0")/scripts/_lib.sh" install
banner "Installer"
cd "$APP_DIR" || fail "could not enter $APP_DIR"

# --- 0. If this folder came from a ZIP download, wire it up to git so UPDATE.sh
#        can pull new versions later. ------------------------------------------
REPO_URL="https://github.com/MultiTech-Visions/Camping-D-and-D.git"
if [ ! -d .git ]; then
  warn "No git folder found (ZIP download?). Connecting to GitHub so updates work…"
  if command -v git >/dev/null; then
    git init -b main . && git remote add origin "$REPO_URL" \
      && git fetch origin main && git reset --soft origin/main \
      && ok "Connected to $REPO_URL" \
      || warn "Could not reach GitHub right now — the app will still install; UPDATE.sh needs internet."
  else
    warn "git is not installed; UPDATE.sh won't work until it is."
  fi
fi

# --- 1. Node.js ---------------------------------------------------------------
NEED_NODE=1
if command -v node >/dev/null; then
  NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
    ok "Node.js $(node -v) found"
    NEED_NODE=0
  else
    warn "Node.js $(node -v) is too old (need 18+)"
  fi
fi
if [ "$NEED_NODE" = 1 ]; then
  say "Installing Node.js (this needs internet and may take a few minutes)…"
  sudo apt-get update -y || fail "apt update failed — is the Pi online?"
  sudo apt-get install -y nodejs npm || fail "could not install Node.js"
  NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
    say "Apt's Node is older than 18 — switching to NodeSource Node 20…"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - || fail "NodeSource setup failed"
    sudo apt-get install -y nodejs || fail "could not install Node 20"
  fi
  ok "Node.js $(node -v) installed"
fi

# --- 2. Build tools (better-sqlite3 sometimes compiles from source on ARM) ----
if ! command -v make >/dev/null || ! command -v g++ >/dev/null; then
  say "Installing build tools (needed in case the database module compiles from source)…"
  sudo apt-get install -y build-essential python3 || warn "build tools install failed — npm install may still work via prebuilt binaries"
fi

# --- 2b. Mushroom lamp (optional BLE campfire light on the projector stand) ---
# python3-bleak drives the light. If this fails the app is unaffected; the GM's
# mushroom toggle just reports "no light found" until it's installed.
say "Installing Bluetooth LED support for the mushroom lamp (python3-bleak)…"
sudo apt-get install -y python3-bleak || warn "python3-bleak install failed — the mushroom lamp toggle will report 'no light' until it's installed (sudo apt install python3-bleak)"

# --- 3. App dependencies (ON this machine — never copied from another) --------
say "Installing app dependencies (npm install)…"
npm install --no-audit --no-fund || fail "npm install failed — see the log above. Common fix: make sure the Pi is online, then run INSTALL.sh again."
ok "Dependencies installed"

say "Quick self-test of the rules engine + database…"
node test/smoke.js --quick || fail "self-test failed — see the log above"
ok "Self-test passed"

# --- 4. Background service (for START/STOP; never enabled at boot) ------------
SERVICE_NAME="campfire-saga"
say "Registering the background service (you may be asked for your password)…"
sed -e "s|__USER__|$USER|g" -e "s|__DIR__|$APP_DIR|g" \
  "$APP_DIR/systemd/campfire-saga.service" | sudo tee "/etc/systemd/system/$SERVICE_NAME.service" >/dev/null \
  || fail "could not write the service file"
sudo systemctl daemon-reload || fail "systemctl daemon-reload failed"
# Make sure no old install left boot-autostart behind.
sudo systemctl disable "$SERVICE_NAME" 2>/dev/null

say "Verifying the server boots…"
sudo systemctl restart "$SERVICE_NAME" || fail "could not start the service"
sleep 2
systemctl is-active --quiet "$SERVICE_NAME" || fail "server did not stay running — check logs/server.log"
ok "Server boots fine"
sudo systemctl stop "$SERVICE_NAME"
ok "…and stopped again (nothing runs until you START it)"

echo
ok "INSTALL COMPLETE!"
echo
echo "   Day to day, just double-click in this folder:"
echo "      START.sh   →  server + WiFi + the QR-code system window"
echo "      STOP.sh    →  everything off"
echo "      UPDATE.sh  →  fetch the newest version (at home, with internet)"
hold_open
