'use strict';

// Campfire Saga server entry: Express (HTTP + static) + ws (WebSockets).
// Two separate HTTP servers share one WebSocket broadcast pool:
//   PORT     (3000) — player-facing: /, /play, /learn, /display, /upload/token
//   GM_PORT  (3001) — GM-only:       /dm, /status, /upload/map, /learn, /display
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

// --- shared helpers ----------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function page(file) {
  return (req, res) => res.sendFile(path.join(PUBLIC_DIR, file));
}

function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

// --- player app (port 3000) --------------------------------------------------
const playerApp = express();

playerApp.get('/', page('index.html'));
playerApp.get('/play', page('player.html'));
playerApp.get('/learn', page('learn.html'));
playerApp.get('/display', page('display.html'));

// Token art upload: players and GM both use this endpoint on the player port.
playerApp.post('/upload/token',
  express.raw({ type: Object.keys(UPLOAD_TYPES), limit: 10 * 1024 * 1024 }),
  (req, res) => {
    const ext = UPLOAD_TYPES[req.headers['content-type']];
    if (!ext) return res.status(400).json({ error: `unsupported image type ${req.headers['content-type']}` });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'empty upload' });
    const name = `token-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(PUBLIC_DIR, 'assets', 'tokens', name), req.body);
    log(`token art uploaded: ${name} (${req.body.length} bytes)`);
    res.json({ art: `/assets/tokens/${name}` });
  });

playerApp.use(express.static(PUBLIC_DIR));

// --- GM app (port 3001) ------------------------------------------------------
const gmApp = express();
const { execFile } = require('child_process');

gmApp.get('/dm', page('dm.html'));
gmApp.get('/display', page('display.html'));
gmApp.get('/learn', page('learn.html'));
gmApp.get('/status', page('status.html'));

// Token art upload: also available on the GM port so the GM can upload token art
// from port 3001 without needing to switch to the player port.
gmApp.post('/upload/token',
  express.raw({ type: Object.keys(UPLOAD_TYPES), limit: 10 * 1024 * 1024 }),
  (req, res) => {
    const ext = UPLOAD_TYPES[req.headers['content-type']];
    if (!ext) return res.status(400).json({ error: `unsupported image type ${req.headers['content-type']}` });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'empty upload' });
    const name = `token-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(PUBLIC_DIR, 'assets', 'tokens', name), req.body);
    log(`token art uploaded (GM port): ${name} (${req.body.length} bytes)`);
    res.json({ art: `/assets/tokens/${name}` });
  });

// Map upload (GM only). The GM's browser measures the image dimensions and
// sends the raw bytes; calibration follows over WebSocket (map.calibrate).
gmApp.post('/upload/map',
  express.raw({ type: Object.keys(UPLOAD_TYPES), limit: config.MAP_MAX_BYTES }),
  (req, res) => {
    const ext = UPLOAD_TYPES[req.headers['content-type']];
    const w = Number(req.query.w);
    const h = Number(req.query.h);
    if (!ext) return res.status(400).json({ error: `unsupported image type ${req.headers['content-type']}` });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'empty upload' });
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
      return res.status(400).json({ error: 'w and h query params must be the image pixel dimensions' });
    }
    const name = `map-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(PUBLIC_DIR, 'assets', 'maps', name), req.body);
    log(`map uploaded: ${name} (${w}x${h}, ${req.body.length} bytes)`);
    res.json({ image_path: `/assets/maps/${name}`, image_w: w, image_h: h });
  });

gmApp.use(express.static(PUBLIC_DIR, { index: false }));

// --- HTTP servers + WebSockets -----------------------------------------------
const playerServer = http.createServer(playerApp);
const gmServer = http.createServer(gmApp);

// Both servers share the same allClients pool inside ws.js so a GM action
// on port 3001 immediately pushes snapshots to players on port 3000.
ws.attach(playerServer, log);
const wssGM = ws.attach(gmServer, log);

// Live system info for the /status screen.
gmApp.get('/status.json', (req, res) => {
  const clients = { player: 0, dm: 0, display: 0 };
  for (const c of ws.allClients) {
    if (c.role && clients[c.role] !== undefined) clients[c.role]++;
  }
  execFile('nmcli', ['-t', '-f', 'NAME', 'connection', 'show', '--active'], (err, stdout) => {
    const hotspotActive = err ? null : stdout.split('\n').includes('Hotspot');
    res.json({
      port: config.PORT,
      gm_port: config.GM_PORT,
      addresses: lanAddresses(),
      hotspot: { ...config.HOTSPOT, active: hotspotActive },
      clients,
      uptime_s: Math.floor(process.uptime()),
    });
  });
});

// --- start -------------------------------------------------------------------
playerServer.listen(config.PORT, () => {
  log('========================================');
  log(`Campfire Saga is burning bright`);
  for (const addr of lanAddresses()) {
    log(`  players  → http://${addr}:${config.PORT}/`);
    log(`  GM       → http://${addr}:${config.GM_PORT}/dm`);
    log(`  display  → http://${addr}:${config.PORT}/display`);
    log(`  learn    → http://${addr}:${config.PORT}/learn`);
  }
  log('========================================');
});

gmServer.listen(config.GM_PORT, () => {
  log(`GM server listening on port ${config.GM_PORT}`);
});
