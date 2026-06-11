'use strict';

// Campfire Saga server entry: Express (HTTP + static) + ws (WebSockets).
// Logs every line to stdout AND logs/server.log so a closed terminal never
// loses history — open logs/server.log to see what happened on the last run.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const config = require('./config');
const ws = require('./ws');

// --- logging -----------------------------------------------------------------
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const logStream = fs.createWriteStream(path.join(LOG_DIR, 'server.log'), { flags: 'a' });

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  logStream.write(stamped + '\n');
}

// Fail loud: a crash must be visible in the log, then exit so systemd restarts us.
process.on('uncaughtException', (err) => {
  log(`FATAL uncaughtException: ${err.stack}`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log(`FATAL unhandledRejection: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

// --- HTTP --------------------------------------------------------------------
const app = express();
const PUBLIC_DIR = path.join(__dirname, 'public');

const pages = { '/': 'index.html', '/play': 'player.html', '/dm': 'dm.html', '/display': 'display.html', '/learn': 'learn.html', '/status': 'status.html' };
for (const [route, file] of Object.entries(pages)) {
  app.get(route, (req, res) => res.sendFile(path.join(PUBLIC_DIR, file)));
}
app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
const wss = ws.attach(server, log);

// Live system info for the /status screen (the "system window" START.sh opens
// on the Pi): addresses, hotspot state, and who's connected.
const { execFile } = require('child_process');
app.get('/status.json', (req, res) => {
  const clients = { player: 0, dm: 0, display: 0 };
  for (const c of wss.clients) {
    if (c.role && clients[c.role] !== undefined) clients[c.role]++;
  }
  execFile('nmcli', ['-t', '-f', 'NAME', 'connection', 'show', '--active'], (err, stdout) => {
    // null = "couldn't ask NetworkManager" (e.g. dev machine) — shown as unknown.
    const hotspotActive = err ? null : stdout.split('\n').includes('Hotspot');
    res.json({
      port: config.PORT,
      addresses: lanAddresses(),
      hotspot: { ...config.HOTSPOT, active: hotspotActive },
      clients,
      uptime_s: Math.floor(process.uptime()),
    });
  });
});

function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

server.listen(config.PORT, () => {
  log('========================================');
  log(`Campfire Saga is burning bright on port ${config.PORT}`);
  for (const addr of lanAddresses()) {
    log(`  players  → http://${addr}:${config.PORT}/`);
    log(`  GM       → http://${addr}:${config.PORT}/dm`);
    log(`  display  → http://${addr}:${config.PORT}/display`);
    log(`  learn    → http://${addr}:${config.PORT}/learn`);
  }
  log('========================================');
});
