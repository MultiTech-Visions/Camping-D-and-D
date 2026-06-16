'use strict';

// Mushroom lamp controller: drives the BLE "campfire" light on the projector
// stand. The animation lives in a Python helper (scripts/mushroom_flame.py)
// that owns the Bluetooth link; this module is the SUPERVISOR around it — it
// spawns the helper when the GM toggles the lamp on, keeps it alive (respawns
// if it dies while still wanted), absorbs rapid toggles, and turns the helper's
// stdout into a live status the GM screen can show.
//
// Why a child process and not a Node BLE library: we already have a proven
// Python/bleak path, the server shells out to system tools elsewhere (nmcli),
// and this keeps Bluetooth out of the Node process entirely. If the light is
// missing or bleak isn't installed, the helper surfaces it and the game server
// is never affected.
//
// status: 'off'       — not running
//         'starting'  — helper spawned, not yet talking
//         'searching' — helper running but can't reach the light (live, retrying)
//         'on'        — helper has a live BLE link; the flame is burning
//         'error'     — a real failure (e.g. bleak missing); still slow-retrying

const { spawn } = require('child_process');
const path = require('path');
const config = require('./config');

const SCRIPT = path.join(__dirname, 'scripts', 'mushroom_flame.py');
const FAST_EXIT_MS = 4000;     // a helper that dies sooner than this "failed fast"
const MAX_BACKOFF_MS = 15000;

class Mushroom {
  constructor() {
    this.child = null;
    this.desired = false;          // what the GM asked for (on/off)
    this.status = 'off';
    this.detail = '';
    this._onChange = () => {};
    this._log = () => {};
    this.address = config.MUSHROOM_ADDRESS;
    this._startedAt = 0;
    this._failCount = 0;           // consecutive fast failures (for backoff)
    this._respawnTimer = null;
  }

  onChange(cb) { this._onChange = cb; }
  setLogger(fn) { this._log = fn; }

  snapshot() {
    return { on: this.desired, status: this.status, detail: this.detail };
  }

  _emit() { this._onChange(this.snapshot()); }

  // GM toggle. Idempotent and debounced: flipping on/off rapidly just updates
  // `desired`; the supervisor reconciles (a pending respawn checks `desired`
  // before it fires, and the exit handler respawns only if still wanted).
  setOn(on) {
    this.desired = !!on;
    if (this.desired) this._ensureRunning();
    else this._shutdown();
  }

  _ensureRunning() {
    if (this.child || this._respawnTimer) return;   // already running/scheduled
    this._failCount = 0;
    this._spawn();
  }

  _spawn() {
    this.status = 'starting';
    this.detail = '';
    this._emit();

    let child;
    try {
      child = spawn('python3', [SCRIPT, this.address], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this._onSpawnFail(err.message);
      return;
    }
    this.child = child;
    this._startedAt = Date.now();

    child.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n').map((s) => s.trim()).filter(Boolean)) {
        this._log(`[mushroom] ${line}`);
        this._consume(line);
      }
    });
    child.stderr.on('data', (d) => {
      const line = d.toString().trim();
      if (line) this._log(`[mushroom:err] ${line}`);
    });
    child.on('error', (err) => this._onSpawnFail(err.message));   // python3 missing, etc.
    child.on('exit', (code, signal) => this._onExit(code, signal));
  }

  // Map helper output lines to live status.
  _consume(line) {
    if (line.includes('connected')) {
      this._failCount = 0;
      this.status = 'on';
      this.detail = '';
      this._emit();
    } else if (line.includes('bluetooth reset')) {
      this.status = 'searching';
      this.detail = 'recovering Bluetooth…';
      this._emit();
    } else if (line.includes('searching') || line.includes('not found')) {
      if (this.status !== 'on') {
        this.status = 'searching';
        this.detail = 'looking for the light…';
        this._emit();
      }
    } else if (line.includes('link dropped') || line.includes('link error')) {
      if (this.status === 'on') {
        this.status = 'searching';
        this.detail = 'reconnecting…';
        this._emit();
      }
    }
  }

  _onSpawnFail(msg) {
    this.child = null;
    this.status = 'error';
    this.detail = `helper could not run: ${msg}`;
    this._log(`[mushroom] spawn failed: ${msg}`);
    this._emit();
    if (this.desired) this._scheduleRespawn(8000);   // keep trying slowly
  }

  _onExit(code, signal) {
    const ranMs = Date.now() - this._startedAt;
    this.child = null;

    if (!this.desired) {                  // we asked it to stop → done
      this.status = 'off';
      this.detail = '';
      this._emit();
      return;
    }

    // Still wanted, but the helper exited → self-heal by respawning. A helper
    // that dies almost immediately is a real failure (bleak missing → exit 3,
    // etc.); back off and surface it, but keep slow-retrying so it recovers on
    // its own if the cause is fixed (light returns, deps installed).
    const fast = ranMs < FAST_EXIT_MS;
    if (fast) this._failCount++; else this._failCount = 0;

    if (fast && this._failCount >= 3) {
      this.status = 'error';
      this.detail = (code === 3)
        ? 'Bluetooth library missing — run INSTALL.sh (python3-bleak)'
        : 'can’t start the flame — still trying';
    } else {
      this.status = 'searching';
      this.detail = 'looking for the light…';
    }
    const delay = fast ? Math.min(2000 * this._failCount, MAX_BACKOFF_MS) : 500;
    this._log(`[mushroom] helper exited (code ${code}, signal ${signal}); respawn in ${delay}ms (fails ${this._failCount})`);
    this._emit();
    this._scheduleRespawn(delay);
  }

  _scheduleRespawn(delay) {
    if (this._respawnTimer) return;
    this._respawnTimer = setTimeout(() => {
      this._respawnTimer = null;
      if (this.desired && !this.child) this._spawn();
    }, delay);
    if (this._respawnTimer.unref) this._respawnTimer.unref();   // don't hold the event loop
  }

  _shutdown() {
    if (this._respawnTimer) {
      clearTimeout(this._respawnTimer);
      this._respawnTimer = null;
    }
    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch (err) { /* already gone */ }
      // the exit handler reports 'off' since desired is now false
    } else {
      this.status = 'off';
      this.detail = '';
      this._emit();
    }
  }
}

module.exports = new Mushroom();
