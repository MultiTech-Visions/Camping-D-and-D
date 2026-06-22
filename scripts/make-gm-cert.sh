#!/usr/bin/env bash
# Generate a self-signed TLS cert for the GM port (3001) so the campaign
# assistant's VOICE feature works from phones over the LAN. Browsers only allow
# microphone access on https:// (or localhost), so the GM server needs a cert.
#
# The cert covers localhost + every current LAN IP. If the Pi's IP changes
# (new network / DHCP lease), just re-run this script and restart the server.
#
# Self-signed means each phone shows a one-time "Not secure — proceed anyway"
# prompt; tap through it once and voice works. The player port (3000) stays HTTP.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$ROOT/data/certs"
mkdir -p "$CERT_DIR"

# Build the subjectAltName list: localhost, loopback, and every LAN IPv4.
SAN="DNS:localhost,IP:127.0.0.1"
while read -r ip; do
  [ -n "$ip" ] && SAN="$SAN,IP:$ip"
done < <(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1)

echo "Generating self-signed GM cert covering: $SAN"
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$CERT_DIR/gm-key.pem" \
  -out "$CERT_DIR/gm-cert.pem" \
  -days 3650 \
  -subj "/CN=Campfire Saga GM" \
  -addext "subjectAltName=$SAN" 2>/dev/null

chmod 600 "$CERT_DIR/gm-key.pem"
echo "Wrote $CERT_DIR/gm-cert.pem and gm-key.pem"
echo "Restart the server (./STOP.sh && ./START.sh), then open https://<pi-ip>:3001/assist"
