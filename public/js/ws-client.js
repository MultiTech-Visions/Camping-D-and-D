'use strict';

// Shared WebSocket client: connect with a role, keep a live snapshot, auto-
// reconnect with backoff (phones at a campsite sleep and wander constantly).
// Usage:
//   const conn = CampfireWS.connect({ role: 'player', charId: 3, onSnapshot: fn, onResult: fn });
//   conn.action('clock.set_filled', { clock_id: 1, filled: 2 });

window.CampfireWS = (function () {
  function genDeviceId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  const _deviceId = localStorage.getItem('campfire_device_id') || (() => {
    const id = genDeviceId();
    localStorage.setItem('campfire_device_id', id);
    return id;
  })();
  let _deviceName = localStorage.getItem('campfire_device_name') || '';

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
        sock.send(JSON.stringify({ type: 'hello', role, char_id: helloCharId, device_id: _deviceId, device_name: _deviceName }));
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
        sock.send(JSON.stringify({ type: 'hello', role, char_id: helloCharId, device_id: _deviceId, device_name: _deviceName }));
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
          sock.send(JSON.stringify({ type: 'hello', role, char_id: helloCharId, device_id: _deviceId, device_name: _deviceName }));
        }
      },
      // Name THIS device. Persists locally and tells the server (so the GM sees it).
      setDeviceName(name) {
        _deviceName = (name || '').trim().slice(0, 60);
        localStorage.setItem('campfire_device_name', _deviceName);
        if (sock && sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({ type: 'action', op: 'device.set_name', payload: { device_id: _deviceId, name: _deviceName } }));
        }
      },
      toast: showToast,
    };
  }

  return {
    connect,
    deviceId: _deviceId,
    get deviceName() { return _deviceName; },
  };
})();

// Shared scroll-lock for full-screen modals/overlays. Pinning <body> while a
// popup is open stops scrolling INSIDE the popup from moving the page behind it,
// so closing the popup lands you exactly where you were (instead of some random
// position). Counter-based so nested overlays each lock/unlock safely.
window.CampfireScrollLock = (function () {
  let depth = 0;
  let savedY = 0;
  return {
    lock() {
      if (depth === 0) {
        savedY = window.scrollY || window.pageYOffset || 0;
        document.body.style.top = `-${savedY}px`;
        document.body.style.position = 'fixed';
        document.body.style.width = '100%';
        document.body.style.overflow = 'hidden';
      }
      depth++;
    },
    unlock() {
      if (depth === 0) return;
      depth--;
      if (depth === 0) {
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.width = '';
        document.body.style.overflow = '';
        window.scrollTo(0, savedY);
      }
    },
  };
})();
