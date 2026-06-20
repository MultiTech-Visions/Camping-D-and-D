'use strict';

// The Pi's system screen: WiFi join QR + player QR + GM QR + live connection counts.
// Polls /status.json; only re-renders the QR codes when something changed.

(function () {
  const wifiArea = document.getElementById('wifi-area');
  const playerArea = document.getElementById('player-area');
  const gmArea = document.getElementById('gm-area');
  const who = document.getElementById('who');
  let lastKey = '';

  function qrInto(parent, text, size) {
    const holder = document.createElement('div');
    holder.className = 'qr';
    parent.appendChild(holder);
    new QRCode(holder, { text, width: size, height: size, correctLevel: QRCode.CorrectLevel.M });
  }

  function bestAddress(st) {
    // On the hotspot, NetworkManager gives the Pi a 10.42.x.x gateway address.
    const hotspotAddr = st.addresses.find((a) => a.startsWith('10.42.'));
    if (st.hotspot.active && hotspotAddr) return hotspotAddr;
    if (st.addresses.length > 0) return st.addresses[0];
    return null;
  }

  function render(st) {
    const addr = bestAddress(st);
    const key = JSON.stringify([st.hotspot.active, addr]);
    if (key !== lastKey) {
      lastKey = key;

      // --- WiFi panel ---
      wifiArea.innerHTML = '';
      if (st.hotspot.active === true) {
        wifiArea.insertAdjacentHTML('beforeend',
          `<p class="big">Scan with your phone's camera:</p>`);
        qrInto(wifiArea, `WIFI:T:WPA;S:${st.hotspot.SSID};P:${st.hotspot.PASSWORD};;`, 200);
        wifiArea.insertAdjacentHTML('beforeend',
          `<p>or join by hand — network <strong class="url-line">${st.hotspot.SSID}</strong><br>password <strong class="url-line">${st.hotspot.PASSWORD}</strong></p>`);
      } else if (st.hotspot.active === false) {
        wifiArea.insertAdjacentHTML('beforeend',
          `<p class="big">✓ The Pi is on the regular WiFi.</p>
           <p class="muted">Phones just join the same WiFi network as always — then scan step 2.</p>`);
      } else {
        wifiArea.insertAdjacentHTML('beforeend',
          `<p class="muted">Couldn't read the WiFi state — phones need to be on the same network as this machine.</p>`);
      }

      // --- player panel ---
      playerArea.innerHTML = '';
      if (addr) {
        const url = `${location.protocol}//${addr}:${st.port}/`;
        playerArea.insertAdjacentHTML('beforeend', `<p class="big">Scan to open the game:</p>`);
        qrInto(playerArea, url, 200);
        playerArea.insertAdjacentHTML('beforeend', `<p class="url-line">${url}</p>`);
      } else {
        playerArea.insertAdjacentHTML('beforeend', `<p class="muted">No network address yet — waiting for WiFi…</p>`);
      }

      // --- GM panel ---
      gmArea.innerHTML = '';
      if (addr) {
        const gmPort = st.gm_port || (st.port + 1);
        const url = `${location.protocol}//${addr}:${gmPort}/dm`;
        gmArea.insertAdjacentHTML('beforeend', `<p class="big">Scan to open GM screen:</p>`);
        qrInto(gmArea, url, 200);
        gmArea.insertAdjacentHTML('beforeend', `<p class="url-line">${url}</p>`);
      } else {
        gmArea.insertAdjacentHTML('beforeend', `<p class="muted">No network address yet — waiting for WiFi…</p>`);
      }
    }

    const up = st.uptime_s;
    const mins = Math.floor(up / 60);
    who.innerHTML =
      `<span>🧝 players connected: <strong>${st.clients.player}</strong></span>` +
      `<span>🜲 GM screens: <strong>${st.clients.dm}</strong></span>` +
      `<span>📽 displays: <strong>${st.clients.display}</strong></span>` +
      `<span class="muted">server up ${mins >= 60 ? Math.floor(mins / 60) + 'h ' : ''}${mins % 60}m</span>`;
  }

  async function poll() {
    try {
      const res = await fetch('/status.json');
      if (res.ok) render(await res.json());
    } catch {
      who.innerHTML = '<span style="color:var(--danger)">server not answering…</span>';
      lastKey = '';
    }
  }

  poll();
  setInterval(poll, 4000);
})();
