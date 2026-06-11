#!/bin/bash
# 🔥 Campfire Saga — INSTALLER (double-click me, choose "Execute in Terminal")
#
# Does everything needed on a fresh Raspberry Pi:
#   1. Makes sure Node.js 18+ is installed (and build tools for native modules)
#   2. Installs the app's dependencies ON THIS MACHINE (important: native
#      modules like better-sqlite3 must be compiled for the Pi's own CPU)
#   3. Sets the server up as a background service that starts on every boot
#   4. Puts double-click icons on the Desktop (Start / Stop / Update / Hotspot /
#      Projector)
# Every line of output is also saved to logs/install-<timestamp>.log.

source "$(dirname "$0")/_lib.sh" install
banner "Installer"
cd "$APP_DIR" || fail "could not enter $APP_DIR"

# --- 0. If this folder came from a ZIP download, wire it up to git so the
#        Update icon can pull new versions later. -----------------------------
REPO_URL="https://github.com/MultiTech-Visions/Camping-D-and-D.git"
if [ ! -d .git ]; then
  warn "No git folder found (ZIP download?). Connecting to GitHub so updates work…"
  if command -v git >/dev/null; then
    git init -b main . && git remote add origin "$REPO_URL" \
      && git fetch origin main && git reset --soft origin/main \
      && ok "Connected to $REPO_URL" \
      || warn "Could not reach GitHub right now — the app will still install; the Update icon needs internet."
  else
    warn "git is not installed; the Update icon won't work until it is."
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

# --- 3. App dependencies (ON this machine — never copied from another) --------
say "Installing app dependencies (npm install)…"
npm install --no-audit --no-fund || fail "npm install failed — see the log above. Common fix: make sure the Pi is online, then run Install again."
ok "Dependencies installed"

say "Quick self-test of the rules engine + database…"
node test/smoke.js --quick || fail "self-test failed — see the log above"
ok "Self-test passed"

# --- 4. systemd service (managed by the Start/Stop icons; restart on crash) ---
# Deliberately NOT enabled at boot — this Pi does other jobs too. The server
# only runs when you double-click 🔥 Start, and stays off after a reboot.
SERVICE_NAME="campfire-saga"
say "Setting up the background service (you may be asked for your password)…"
sed -e "s|__USER__|$USER|g" -e "s|__DIR__|$APP_DIR|g" \
  "$APP_DIR/systemd/campfire-saga.service" | sudo tee "/etc/systemd/system/$SERVICE_NAME.service" >/dev/null \
  || fail "could not write the service file"
sudo systemctl daemon-reload || fail "systemctl daemon-reload failed"
# Undo any boot-autostart left behind by an older install.
sudo systemctl disable "$SERVICE_NAME" 2>/dev/null
sudo systemctl restart "$SERVICE_NAME" || fail "could not start the service"
sleep 2
systemctl is-active --quiet "$SERVICE_NAME" \
  && ok "Server is running NOW (it will NOT auto-start on boot — use the 🔥 Start icon)" \
  || fail "service did not stay running — check logs/server.log"

# --- 5. Desktop icons ----------------------------------------------------------
DESKTOP_DIR="$HOME/Desktop"
mkdir -p "$DESKTOP_DIR"
make_icon() { # name, script, icon, comment
  local file="$DESKTOP_DIR/$1.desktop"
  cat > "$file" <<EOF
[Desktop Entry]
Type=Application
Name=$1
Comment=$4
Exec=bash "$APP_DIR/scripts/$2"
Icon=$3
Terminal=true
Categories=Game;
EOF
  chmod +x "$file"
  # Tell the file manager this launcher is trusted (no "untrusted" prompt).
  command -v gio >/dev/null && gio set "$file" metadata::trusted true 2>/dev/null
}
say "Creating Desktop icons…"
make_icon "🔥 Start Campfire Saga"   start.sh          applications-games "Start the game server and show the address for phones"
make_icon "🛑 Stop Campfire Saga"    stop.sh           process-stop       "Stop the game server"
make_icon "⬇ Update Campfire Saga"  update.sh         system-software-update "Download the newest version from GitHub and restart"
make_icon "📶 Campsite WiFi Hotspot" hotspot.sh        network-wireless   "Toggle the Pi's own WiFi hotspot for the campsite"
make_icon "📽 Projector Display"     projector.sh      video-display      "Open the shared display full-screen for the projector"
ok "Desktop icons created"

echo
ok "INSTALL COMPLETE!"
print_urls
echo "   At the campsite (no internet), double-click “📶 Campsite WiFi Hotspot”"
echo "   first — phones join the CampfireSaga network, then use the address above."
hold_open
