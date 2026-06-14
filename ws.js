'use strict';

// WebSocket layer: hello → role-scoped snapshot; action → validate/mutate/persist
// via state.ops, then broadcast fresh role-scoped snapshots to every client.
// Validation failures go back to the requester as {type:"error"} — never ignored.
//
// attach() may be called multiple times (once per HTTP server / port). All WS
// servers share allClients so a GM action on port 3001 immediately pushes
// snapshots to players connected on port 3000.

const { WebSocketServer } = require('ws');
const { load, ops, snapshotFor, registerDevice } = require('./state');

const allClients = new Set();
let stateLoaded = false;

function sendSnapshot(client) {
  if (client.readyState !== 1 || !client.role) return;
  const connectedDeviceIds = client.role === 'dm'
    ? [...new Set([...allClients].filter(c => c.deviceId).map(c => c.deviceId))]
    : [];
  client.send(JSON.stringify({ type: 'snapshot', ...snapshotFor(client.role, client.charId, client.deviceId, connectedDeviceIds) }));
}

function broadcastSnapshots() {
  for (const client of allClients) sendSnapshot(client);
}

function attach(httpServer, log) {
  if (!stateLoaded) { load(); stateLoaded = true; }
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (sock, req) => {
    sock.role = null;
    sock.charId = null;
    allClients.add(sock);
    log(`ws connect from ${req.socket.remoteAddress}`);

    sock.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        sock.send(JSON.stringify({ type: 'error', op: null, reason: `malformed JSON: ${err.message}` }));
        return;
      }
      try {
        if (msg.type === 'hello') {
          if (!['player', 'dm', 'display'].includes(msg.role)) {
            throw Object.assign(new Error(`unknown role ${JSON.stringify(msg.role)}`), { expected: true });
          }
          sock.role = msg.role;
          sock.charId = Number.isInteger(msg.char_id) ? msg.char_id : null;
          sock.deviceId = (typeof msg.device_id === 'string' && msg.device_id.length > 0) ? msg.device_id : null;
          registerDevice(sock.deviceId, msg.device_name);
          // Broadcast so any open GM screen sees this device come online (and its name).
          broadcastSnapshots();
          return;
        }
        if (msg.type === 'action') {
          if (!sock.role) {
            throw Object.assign(new Error('say hello (with a role) before sending actions'), { expected: true });
          }
          const op = ops[msg.op];
          if (!op) throw Object.assign(new Error(`unknown op '${msg.op}'`), { expected: true });
          const result = op(msg.payload === undefined ? {} : msg.payload);
          log(`op ${msg.op} by ${sock.role}${sock.charId ? `#${sock.charId}` : ''} ok`);
          if (result !== undefined) {
            sock.send(JSON.stringify({ type: 'result', op: msg.op, ...result }));
          }
          broadcastSnapshots();
          return;
        }
        throw Object.assign(new Error(`unknown message type '${msg.type}'`), { expected: true });
      } catch (err) {
        if (err.expected) {
          log(`op ${msg.op || msg.type} rejected: ${err.message}`);
          sock.send(JSON.stringify({ type: 'error', op: msg.op || msg.type, reason: err.message }));
        } else {
          log(`UNEXPECTED ERROR in op ${msg.op || msg.type}: ${err.stack}`);
          sock.send(JSON.stringify({ type: 'error', op: msg.op || msg.type, reason: `server bug: ${err.message}` }));
        }
      }
    });

    sock.on('close', () => {
      allClients.delete(sock);
      log(`ws disconnect (${sock.role || 'no role'})`);
      // Refresh GM device lists so the just-left device flips to offline.
      broadcastSnapshots();
    });
    sock.on('error', (err) => log(`ws socket error: ${err.message}`));
  });

  return wss;
}

module.exports = { attach, allClients };
