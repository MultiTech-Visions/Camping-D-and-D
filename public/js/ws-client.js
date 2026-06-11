'use strict';

// Shared WebSocket client: connect with a role, keep a live snapshot, auto-
// reconnect with backoff (phones at a campsite sleep and wander constantly).
// Usage:
//   const conn = CampfireWS.connect({ role: 'player', charId: 3, onSnapshot: fn, onResult: fn });
//   conn.action('clock.set_filled', { clock_id: 1, filled: 2 });

window.CampfireWS = (function () {
  function connect({ role, charId, onSnapshot, onResult }) {
    let sock = null;
    let retryMs = 500;
    let helloCharId = charId === undefined ? null : charId;

    const dot = document.createElement('div');
    dot.id = 'conn-dot';
    dot.title = 'connection status';
    document.body.appendChild(dot);

    const toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
    let toastTimer = null;

    function showToast(text, ok) {
      toast.textContent = text;
      toast.className = ok ? 'ok' : '';
      toast.style.display = 'block';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.style.display = 'none'; }, ok ? 2500 : 5000);
    }

    function open() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      sock = new WebSocket(`${proto}://${location.host}`);

      sock.onopen = () => {
        retryMs = 500;
        dot.classList.add('on');
        sock.send(JSON.stringify({ type: 'hello', role, char_id: helloCharId }));
      };

      sock.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'snapshot') onSnapshot(msg);
        else if (msg.type === 'error') showToast(`⚠ ${msg.reason}`, false);
        else if (msg.type === 'result' && onResult) onResult(msg);
      };

      sock.onclose = () => {
        dot.classList.remove('on');
        setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 2, 8000);
      };
      sock.onerror = () => sock.close();
    }

    open();

    // Re-sync immediately when the phone wakes back up.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && sock && sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ type: 'hello', role, char_id: helloCharId }));
      }
    });

    return {
      action(op, payload) {
        if (!sock || sock.readyState !== WebSocket.OPEN) {
          showToast('⚠ not connected — change not sent', false);
          return;
        }
        sock.send(JSON.stringify({ type: 'action', op, payload }));
      },
      setCharId(id) {
        helloCharId = id;
        if (sock && sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({ type: 'hello', role, char_id: helloCharId }));
        }
      },
      toast: showToast,
    };
  }

  return { connect };
})();
