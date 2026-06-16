'use strict';

// Mushroom lamp controller: drives the BLE "campfire" light on the projector
// stand. The animation itself lives in a Python helper (scripts/mushroom_flame.py)
// that owns the Bluetooth link; this module just spawns it when the GM toggles
// the lamp on and kills it when off, and reports status to the GM screen.
//
// Why a child process and not a Node BLE library: we already have a proven
// Python/bleak path, and the server shells out to system tools elsewhere
// (nmcli). This keeps Bluetooth out of the Node process entirely — if the light
// is missing or bleak isn't installed, the helper exits and we surface "no
// light" to the GM; the game server is never affected.
//
// status: 'off' (not running) | 'starting' (spawned, not yet connected)
//         | 'on' (helper reported a live connection) | 'error' (helper failed)

const { spawn } = require('child_process');
const path = require('path');
const config = require('./config');

const SCRIPT = path.join(__dirname, 'scripts', 'mushroom_flame.py');

class Mushroom {
  constructor() {
    this.child = null;
    this._on = false;            // what the GM asked for
    this.status = 'off';
    this.detail = '';
    this._onChange = () => {};
    this._log = () => {};
    this.address = config.MUSHROOM_ADDRESS;
  }

  onChange(cb) { this._onChange = cb; }
  setLogger(fn) { this._log = fn; }

  snapshot() {
    return { on: this._on, status: this.status, detail: this.detail };
  }

  _emit() { this._onChange(this.snapshot()); }

  setOn(on) {
    on = !!on;
    this._on = on;
    if (on) this._start();
    else this._stop();
  }

  _start() {
    if (this.child) return;                 // already running
    this.status = 'starting';
    this.detail = '';
    this._emit();

    let child;
    try {
      child = spawn('python3', [SCRIPT, this.address], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.child = null;
      this.status = 'error';
      this.detail = `could not start helper: ${err.message}`;
      this._log(`[mushroom] spawn failed: ${err.message}`);
      this._emit();
      return;
    }
    this.child = child;

    child.stdout.on('data', (d) => {
      const line = d.toString().trim();
      if (line) this._log(`[mushroom] ${line}`);
      // The helper prints 'flame: connected' once the BLE link is live.
      if (line.includes('connected')) {
        this.status = 'on';
        this.detail = '';
        this._emit();
      }
    });
    child.stderr.on('data', (d) => {
      const line = d.toString().trim();
      if (line) this._log(`[mushroom:err] ${line}`);
    });

    // 'error' fires if python3 itself can't be launched (not installed, etc.).
    child.on('error', (err) => {
      this.child = null;
      this.status = 'error';
      this.detail = `helper could not run: ${err.message}`;
      this._log(`[mushroom] child error: ${err.message}`);
      this._emit();
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      if (this._on) {
        // We still wanted it on, so this is an unexpected death (light out of
        // range, bleak missing → exit 3, etc.).
        this.status = 'error';
        this.detail = `flame helper stopped (code ${code == null ? signal : code})`;
        this._log(`[mushroom] helper exited unexpectedly (code ${code}, signal ${signal})`);
      } else {
        this.status = 'off';
        this.detail = '';
      }
      this._emit();
    });
  }

  _stop() {
    // _on is already false (set by setOn) so the exit handler reports 'off'.
    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch (err) { /* already gone */ }
    } else {
      this.status = 'off';
      this.detail = '';
      this._emit();
    }
  }
}

module.exports = new Mushroom();
