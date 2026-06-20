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
const https = require('https');
const net = require('net');
const { execFileSync } = require('child_process');
const express = require('express');
const config = require('./config');
const ws = require('./ws');
const assistant = require('./assistant');

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

// --- HTTPS certificate -------------------------------------------------------
// Only the GM port (3001) serves HTTPS, and only because the prep-time voice
// assistant on /assist needs the microphone — phones expose getUserMedia solely
// in a "secure context" (https, or http://localhost), and the GM reaches /assist
// from another device over WiFi. The player port (3000) stays plain HTTP so
// nobody at the campsite ever meets a certificate warning for features that
// never touch the mic. There's no public domain at a campsite, so we generate a
// self-signed certificate (kept in the gitignored data/ dir) covering the Pi's
// current addresses; the GM's device accepts a one-time browser warning, then the
// mic works. Regenerated automatically if the Pi's IPs change. openssl ships with
// Pi OS; if it's somehow missing we fall back to plain HTTP and say so loudly.
const CERT_DIR = path.join(process.env.CAMPFIRE_DATA_DIR || path.join(__dirname, 'data'), 'tls');
function ensureCert() {
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  const sansFile = path.join(CERT_DIR, 'sans.txt');
  try {
    const ips = [...new Set(['127.0.0.1', '10.42.0.1', ...lanAddresses()])];
    const dns = [...new Set(['localhost', os.hostname()].filter(Boolean))];
    const san = 'subjectAltName=' + [...dns.map((d) => `DNS:${d}`), ...ips.map((i) => `IP:${i}`)].join(',');
    const haveAll = fs.existsSync(keyFile) && fs.existsSync(certFile) && fs.existsSync(sansFile);
    if (!haveAll || fs.readFileSync(sansFile, 'utf8') !== san) {
      fs.mkdirSync(CERT_DIR, { recursive: true });
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyFile, '-out', certFile, '-days', '3650',
        '-subj', '/CN=Campfire Saga', '-addext', san], { stdio: 'ignore' });
      fs.writeFileSync(sansFile, san);
      log(`generated self-signed TLS certificate (${san})`);
    }
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  } catch (err) {
    log(`WARNING: HTTPS unavailable (${err.message}). Serving the GM port as plain HTTP — the microphone/voice on /assist will only work from http://localhost.`);
    return null;
  }
}

// Serve HTTPS on `port`, and answer plain HTTP on that SAME port with a 301 to
// https, so the GM typing http://pi:3001 still lands safely. We peek the first
// byte of each connection — a TLS handshake starts with 0x16 — and route it to
// the secure server or the redirect accordingly. Passing tls=null serves plain
// HTTP (used for the player port, and as the fallback if no cert could be made).
function serve(tls, app, port) {
  if (!tls) { const s = http.createServer(app); ws.attach(s, log); return s; }
  const secure = https.createServer({ key: tls.key, cert: tls.cert }, app);
  ws.attach(secure, log);
  const redirect = http.createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0] || 'localhost';
    res.writeHead(301, { Location: `https://${host}:${port}${req.url}` });
    res.end('Redirecting to HTTPS…');
  });
  return net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', (buf) => {
      socket.pause();
      socket.unshift(buf);
      (buf[0] === 0x16 ? secure : redirect).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
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
gmApp.get('/assist', page('assist.html')); // prep-time AI campaign assistant (GM only, needs internet)

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

// --- servers + WebSockets ----------------------------------------------------
// HTTPS only on the GM port (for the /assist microphone); plain HTTP for players.
const TLS = ensureCert();
const PLAYER_SCHEME = 'http';
const GM_SCHEME = TLS ? 'https' : 'http';

// Both servers share the same allClients pool inside ws.js so a GM action
// on port 3001 immediately pushes snapshots to players on port 3000. serve()
// attaches the WebSocket layer to each server internally.
const playerServer = serve(null, playerApp, config.PORT);
const gmServer = serve(TLS, gmApp, config.GM_PORT);

// Prep-time AI campaign assistant: mounts /assist/session, /assist/tool,
// /assist/chat on the GM port. Tool writes reuse the live snapshot broadcast so
// content shows up on /dm and /display instantly.
assistant.mount(gmApp, { broadcast: ws.broadcastSnapshots, log });

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
      scheme: { player: PLAYER_SCHEME, gm: GM_SCHEME },
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
  log('Campfire Saga is burning bright');
  for (const addr of lanAddresses()) {
    log(`  players  → ${PLAYER_SCHEME}://${addr}:${config.PORT}/`);
    log(`  GM       → ${GM_SCHEME}://${addr}:${config.GM_PORT}/dm`);
    log(`  display  → ${PLAYER_SCHEME}://${addr}:${config.PORT}/display`);
    log(`  learn    → ${PLAYER_SCHEME}://${addr}:${config.PORT}/learn`);
  }
  if (GM_SCHEME === 'https') log('  (the GM port is HTTPS for the /assist mic — first visit on the GM device shows a one-time "not secure" warning; tap through. Player/display links are plain HTTP, no warning.)');
  log('========================================');
});

gmServer.listen(config.GM_PORT, () => {
  log(`GM server listening on port ${config.GM_PORT}`);
});
