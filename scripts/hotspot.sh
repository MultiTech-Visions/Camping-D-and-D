#!/bin/bash
# 📶 Campfire Saga — CAMPSITE WIFI HOTSPOT (double-click me)
# Toggles the Pi's own WiFi network so phones can connect with zero internet.
# First click turns it ON, next click turns it OFF.
# Network name: CampfireSaga   Password: tellmeastory
# Logged to logs/hotspot-<timestamp>.log.

source "$(dirname "$0")/_lib.sh" hotspot
banner "Campsite WiFi Hotspot"

SSID="CampfireSaga"
PASSWORD="tellmeastory"

command -v nmcli >/dev/null || fail "NetworkManager (nmcli) not found — is this Raspberry Pi OS Bookworm?"

if nmcli -t -f NAME connection show --active 2>/dev/null | grep -qx "Hotspot"; then
  say "Hotspot is ON — turning it OFF and reconnecting to normal WiFi…"
  sudo nmcli connection down Hotspot || fail "could not stop the hotspot"
  ok "Hotspot is OFF. The Pi will rejoin its usual WiFi."
else
  say "Turning the hotspot ON…"
  warn "The Pi will drop off normal WiFi while the hotspot runs (that's fine at camp)."
  sudo nmcli device wifi hotspot ssid "$SSID" password "$PASSWORD" ifname wlan0 \
    || fail "could not start the hotspot"
  sudo nmcli connection modify Hotspot connection.autoconnect no 2>/dev/null
  sleep 2
  IP="$(lan_ip)"
  ok "Hotspot is ON!"
  echo
  echo "   📶 WiFi network:  $SSID"
  echo "   🔑 Password:      $PASSWORD"
  echo "   🌐 Players go to: http://${IP:-10.42.0.1}:3000/"
  echo
  echo "   Double-click this icon again to turn the hotspot off."
fi
hold_open
