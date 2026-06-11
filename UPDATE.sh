#!/bin/bash
# ⬇ UPDATE — double-click me (needs internet, so do this at home).
# Pulls the newest version from the main branch on GitHub, refreshes
# dependencies, runs the self-test, and restarts the server only if it was
# already running. Your game data (data/ folder) is never touched.
# Logged to logs/update-<timestamp>.log.

# The whole script runs from a function so that bash finishes reading this file
# BEFORE git replaces it mid-update (the classic self-update trap).
main() {
  source "$(dirname "$0")/scripts/_lib.sh" update
  banner "Update"
  cd "$APP_DIR" || fail "could not enter $APP_DIR"

  [ -d .git ] || fail "this folder is not connected to GitHub — run INSTALL.sh once first"

  say "Version before update: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

  say "Checking GitHub for the newest version…"
  local fetched=0 wait
  for wait in 0 2 4 8 16; do
    [ "$wait" -gt 0 ] && { warn "retrying in ${wait}s…"; sleep "$wait"; }
    if git fetch origin main; then fetched=1; break; fi
  done
  [ "$fetched" = 1 ] || fail "could not reach GitHub — are you online? (Updates need internet; playing does not.)"

  if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then
    ok "Already up to date — nothing to do."
    close_soon
    exit 0
  fi

  say "Updating files to match the main branch…"
  git checkout -B main origin/main -f || fail "could not switch to the newest version"
  git reset --hard origin/main || fail "could not apply the newest version"
  ok "Now at version: $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"

  say "Refreshing dependencies…"
  npm install --no-audit --no-fund || fail "npm install failed — see log above"

  say "Running self-test…"
  node test/smoke.js --quick || fail "self-test failed after update — see log above"

  if systemctl is-active --quiet campfire-saga 2>/dev/null; then
    say "Server was running — restarting it on the new version…"
    sudo systemctl restart campfire-saga || fail "could not restart the service"
    sleep 2
    systemctl is-active --quiet campfire-saga || fail "server did not come back up — check logs/server.log"
    ok "Server restarted on the new version"
  else
    say "Server is not running — leaving it off. Double-click START.sh when you want it."
  fi

  ok "UPDATE COMPLETE"
  hold_open
}
main "$@"
