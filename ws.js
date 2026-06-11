'use strict';

// WebSocket layer: hello → role-scoped snapshot; action → validate/mutate/persist
// via state.ops, then broadcast fresh role-scoped snapshots to every client.
// Validation failures go back to the requester as {type:"error"} — never ignored.

const { WebSocketServer } = require('ws');
const { load, ops, snapshotFor } = require('./state');

function attach(httpServer, log) {
  load();
  const wss = new WebSocketServer({ server: httpServer });

  function sendSnapshot(client) {
    if (client.readyState !== 1 || !client.role) return;
    client.send(JSON.stringify({ type: 'snapshot', ...snapshotFor(client.role, client.charId) }));
  }

  function broadcastSnapshots() {
    for (const client of wss.clients) sendSnapshot(client);
  }

  wss.on('connection', (sock, req) => {
    sock.role = null;
    sock.charId = null;
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
          sendSnapshot(sock);
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
          // Unexpected = a bug. Log loudly with stack; tell the client; keep serving.
          log(`UNEXPECTED ERROR in op ${msg.op || msg.type}: ${err.stack}`);
          sock.send(JSON.stringify({ type: 'error', op: msg.op || msg.type, reason: `server bug: ${err.message}` }));
        }
      }
    });

    sock.on('close', () => log(`ws disconnect (${sock.role || 'no role'})`));
    sock.on('error', (err) => log(`ws socket error: ${err.message}`));
  });

  return wss;
}

module.exports = { attach };
