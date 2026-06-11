#!/bin/bash
# 🔥 CAMPFIRE SAGA — FIRST-TIME INSTALL
#
# Double-click this file and choose "Execute in Terminal".
# It runs the real installer in scripts/install.sh, which:
#   • installs everything the app needs
#   • puts Start / Stop / Update / Hotspot / Projector icons on your Desktop
#     (the server only runs when you click 🔥 Start — nothing starts on boot)
# Everything is logged to the logs/ folder, so even if this window closes you
# can open logs/latest-install.log to see exactly what happened.

exec bash "$(dirname "$0")/scripts/install.sh"
