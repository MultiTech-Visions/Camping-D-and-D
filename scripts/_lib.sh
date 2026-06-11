#!/bin/bash
# Shared helpers for every double-click script. Source me first:
#   source "$(dirname "$0")/_lib.sh" <script-name>
#
# Gives you:
#   - APP_DIR        absolute path to the project root
#   - LOG_FILE       logs/<name>-YYYYmmdd-HHMMSS.log (everything is tee'd there,
#                    so if the terminal window gets closed, the log survives —
#                    logs/latest-<name>.log always points at the newest run)
#   - say / ok / warn / fail   pretty, logged output helpers
#   - hold_open      "Press Enter to close" so the window never just vanishes

set -o pipefail

SCRIPT_NAME="${1:?_lib.sh needs a script name}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[1]}")/.." && pwd)"
LOG_DIR="$APP_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${SCRIPT_NAME}-$(date +%Y%m%d-%H%M%S).log"
ln -sf "$(basename "$LOG_FILE")" "$LOG_DIR/latest-${SCRIPT_NAME}.log"

# Everything this script prints — and everything commands it runs print — goes
# to both the terminal AND the log file.
exec > >(tee -a "$LOG_FILE") 2>&1

BOLD='\033[1m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; RESET='\033[0m'

say()  { echo -e "$(date '+%H:%M:%S')  $*"; }
ok()   { echo -e "$(date '+%H:%M:%S')  ${GREEN}✔ $*${RESET}"; }
warn() { echo -e "$(date '+%H:%M:%S')  ${YELLOW}⚠ $*${RESET}"; }
fail() {
  echo -e "$(date '+%H:%M:%S')  ${RED}✖ $*${RESET}"
  echo
  echo -e "${RED}Something went wrong. The full log is saved at:${RESET}"
  echo "  $LOG_FILE"
  hold_open
  exit 1
}

hold_open() {
  echo
  echo -e "${BOLD}(This window is safe to close. Full log: $LOG_FILE)${RESET}"
  # Only wait for a keypress when there is a human at a terminal.
  if [ -t 0 ]; then
    read -r -p "Press Enter to close… " _ || true
  fi
}

banner() {
  echo
  echo -e "${BOLD}🔥 ============================================${RESET}"
  echo -e "${BOLD}   Campfire Saga — $*${RESET}"
  echo -e "${BOLD}   $(date)${RESET}"
  echo -e "${BOLD}   log: $LOG_FILE${RESET}"
  echo -e "${BOLD}🔥 ============================================${RESET}"
  echo
}

# Best-available IPv4 address for telling players where to point their phones.
lan_ip() {
  hostname -I 2>/dev/null | awk '{print $1}'
}

print_urls() {
  local ip; ip="$(lan_ip)"
  [ -n "$ip" ] || ip="<this-pi's-ip>"
  echo
  echo -e "${BOLD}   Point phones (on the same WiFi) at:${RESET}"
  echo -e "      players   ${GREEN}http://$ip:3000/${RESET}"
  echo -e "      GM screen ${GREEN}http://$ip:3000/dm${RESET}"
  echo -e "      learn     ${GREEN}http://$ip:3000/learn${RESET}"
  echo -e "      projector ${GREEN}http://localhost:3000/display${RESET} (on the Pi itself)"
  echo
}
