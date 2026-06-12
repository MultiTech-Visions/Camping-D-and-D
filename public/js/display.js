'use strict';

// Projector display client.
//
// THE THREE COORDINATE SPACES (handoff §7 — state of law for this renderer):
//   1. IMAGE space  — raw pixels of the uploaded map; fixed; calibration
//      (cell_size, offset_x/y) lives here.
//   2. GRID space   — (col,row) integers derived from calibration. TOKEN
//      POSITIONS ARE STORED HERE AND ONLY HERE.
//   3. SCREEN space — what the projector shows; derived at render time from
//      the camera object only. The camera is a pure view transform: panning,
//      zooming, or rotating it NEVER changes a token's stored position.
//
// Two modes: campfire mode (roster + clocks + embers, no map) and map mode
// (PixiJS WebGL: map sprite + tokens + glows, camera-driven).

(function () {
  const turnEl = document.getElementById('d-turn');
  const clocksEl = document.getElementById('d-clocks');
  const rosterEl = document.getElementById('d-roster');
  const mapRoot = document.getElementById('map-root');

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  // ------------------------------------------------------------------------
  // PixiJS map renderer (created lazily; torn down when the map turns off)
  // ------------------------------------------------------------------------
  const pixi = {
    app: null, world: null, mapSprite: null, gridLayer: null, tokenLayer: null,
    imagePath: null, glows: [],
  };

  function ensurePixi() {
    if (pixi.app) return;
    pixi.app = new PIXI.Application({
      resizeTo: window,
      backgroundColor: 0x14100d,
      antialias: true,
    });
    mapRoot.appendChild(pixi.app.view);
    pixi.world = new PIXI.Container();
    pixi.app.stage.addChild(pixi.world);
    pixi.tokenLayer = new PIXI.Container();

    // glow pulse animation — cheap sine on alpha/scale, display client only
    pixi.app.ticker.add(() => {
      const t = performance.now() / 1000;
      for (const g of pixi.glows) {
        const wave = g.pulse === 0 ? 1 : 0.75 + 0.25 * Math.sin(2 * Math.PI * g.pulse * t);
        g.sprite.alpha = 0.55 * wave;
        g.sprite.scale.set(wave);
      }
    });
  }

  function teardownPixi() {
    if (!pixi.app) return;
    pixi.app.destroy(true, { children: true, texture: false });
    pixi.app = null;
    pixi.world = null;
    pixi.mapSprite = null;
    pixi.gridLayer = null;
    pixi.tokenLayer = null;
    pixi.imagePath = null;
    pixi.glows = [];
    mapRoot.innerHTML = '';
  }

  function hexToNum(color) {
    return Number(`0x${color.replace('#', '')}`);
  }

  function renderMap(snap) {
    ensurePixi();
    const map = snap.map;

    if (pixi.imagePath !== map.image_path) {
      pixi.world.removeChildren();
      pixi.mapSprite = PIXI.Sprite.from(map.image_path);
      // Size the sprite only once its real texture exists — sizing against the
      // 1x1 loading placeholder bakes in a garbage scale (the "zoom does
      // nothing" bug: the map rendered at nonsense size).
      const fitSprite = () => {
        pixi.mapSprite.width = map.image_w;
        pixi.mapSprite.height = map.image_h;
      };
      if (pixi.mapSprite.texture.baseTexture.valid) fitSprite();
      else pixi.mapSprite.texture.baseTexture.once('loaded', fitSprite);
      pixi.gridLayer = new PIXI.Graphics();
      pixi.world.addChild(pixi.mapSprite);
      pixi.world.addChild(pixi.gridLayer);
      pixi.world.addChild(pixi.tokenLayer);
      pixi.imagePath = map.image_path;
    }

    // --- calibrated grid overlay (GM-toggleable; off for pre-gridded art) ---
    pixi.gridLayer.clear();
    if (map.grid_visible) {
      const dims = CampfireMap.gridDims(map);
      const x1 = map.offset_x + dims.cols * map.cell_size;
      const y1 = map.offset_y + dims.rows * map.cell_size;
      pixi.gridLayer.lineStyle(Math.max(map.cell_size * 0.025, 1), 0xffffff, 0.28);
      for (let i = 0; i <= dims.cols; i++) {
        const x = map.offset_x + i * map.cell_size;
        pixi.gridLayer.moveTo(x, map.offset_y);
        pixi.gridLayer.lineTo(x, y1);
      }
      for (let j = 0; j <= dims.rows; j++) {
        const y = map.offset_y + j * map.cell_size;
        pixi.gridLayer.moveTo(map.offset_x, y);
        pixi.gridLayer.lineTo(x1, y);
      }
    }

    // --- tokens: rebuilt each snapshot (dozens at most — cheap) -------------
    pixi.tokenLayer.removeChildren();
    pixi.glows = [];
    const turnEntry = snap.initiative.entries.find((e) => e.id === snap.initiative.turn_id);
    const camTheta = (snap.camera.rotation_deg * Math.PI) / 180;

    for (const tok of snap.tokens) {
      // footprint: (col,row) is the top-left cell; w×h cells; render from its center
      const fw = tok.w * map.cell_size;
      const fh = tok.h * map.cell_size;
      const x = map.offset_x + tok.col * map.cell_size + fw / 2;
      const y = map.offset_y + tok.row * map.cell_size + fh / 2;

      if (tok.kind === 'glow') {
        const g = new PIXI.Graphics();
        const color = hexToNum(tok.glow_color);
        const radius = tok.glow_radius * map.cell_size;
        for (let i = 5; i >= 1; i--) {
          g.beginFill(color, 0.18);
          g.drawCircle(0, 0, (radius * i) / 5);
          g.endFill();
        }
        g.position.set(x, y);
        g.blendMode = PIXI.BLEND_MODES.ADD;
        pixi.tokenLayer.addChild(g);
        pixi.glows.push({ sprite: g, pulse: tok.glow_pulse });
        continue;
      }

      const holder = new PIXI.Container();
      holder.position.set(x, y);
      const isTurn = turnEntry && turnEntry.char_id !== null && turnEntry.char_id === tok.char_id;
      const char = tok.char_id === null ? null : snap.characters.find((c) => c.id === tok.char_id);
      const dead = char ? char.conditions.some((c) => c.kind === 'dead') : false;

      const disc = new PIXI.Graphics();
      if (isTurn) {
        disc.lineStyle(map.cell_size * 0.08, 0xff8c2e, 1);
      } else {
        disc.lineStyle(2, 0x000000, 0.8);
      }
      if (tok.art) {
        // uploaded art: cover-fit the footprint, masked to the token's shape,
        // with the ring (turn highlight / outline) drawn on top
        const spr = PIXI.Sprite.from(tok.art);
        spr.anchor.set(0.5);
        const fitArt = () => {
          const tw = spr.texture.width, th = spr.texture.height;
          const sc = Math.max(fw / tw, fh / th);
          spr.width = tw * sc;
          spr.height = th * sc;
        };
        if (spr.texture.baseTexture.valid) fitArt();
        else spr.texture.baseTexture.once('loaded', fitArt);
        const mask = new PIXI.Graphics();
        mask.beginFill(0xffffff);
        if (tok.shape === 'square') mask.drawRoundedRect(-fw / 2, -fh / 2, fw, fh, map.cell_size * 0.12);
        else mask.drawEllipse(0, 0, fw * 0.48, fh * 0.48);
        mask.endFill();
        spr.mask = mask;
        if (dead) spr.tint = 0x666666;
        holder.addChild(spr, mask);
        if (tok.shape === 'square') disc.drawRoundedRect(-fw / 2, -fh / 2, fw, fh, map.cell_size * 0.12);
        else disc.drawEllipse(0, 0, fw * 0.48, fh * 0.48);
      } else if (tok.shape === 'square') {
        // squares fill their cells (terrain): edge-to-edge, slightly translucent
        disc.beginFill(hexToNum(tok.color), dead ? 0.35 : 0.8);
        disc.drawRoundedRect(-fw / 2, -fh / 2, fw, fh, map.cell_size * 0.12);
        disc.endFill();
      } else {
        // circles sit inside the footprint (creatures); 1x1 stays the classic disc
        disc.beginFill(hexToNum(tok.color), dead ? 0.35 : 0.95);
        disc.drawEllipse(0, 0, fw * 0.4, fh * 0.4);
        disc.endFill();
      }
      holder.addChild(disc);

      const label = new PIXI.Text(dead ? '✕ ' + tok.label : tok.label, {
        fontFamily: 'Georgia, serif',
        fontSize: Math.max(map.cell_size * 0.28, 11),
        fill: 0xf3e9d8,
        stroke: 0x000000,
        strokeThickness: 3,
        align: 'center',
      });
      label.anchor.set(0.5, 0);
      // Labels stay readable whatever the camera rotation: a wrapper counter-
      // rotates against the world so the text is always upright and hangs
      // below the token IN SCREEN TERMS. The hang distance is the footprint's
      // extent along the screen-down axis at this rotation, so the text
      // clears the shape's edge instead of overlapping it.
      const ext = tok.shape === 'square'
        ? (fw / 2) * Math.abs(Math.sin(camTheta)) + (fh / 2) * Math.abs(Math.cos(camTheta))
        : Math.sqrt((fw * 0.4 * Math.sin(camTheta)) ** 2 + (fh * 0.4 * Math.cos(camTheta)) ** 2);
      const labelWrap = new PIXI.Container();
      labelWrap.rotation = -camTheta;
      label.position.set(0, ext + map.cell_size * 0.05);
      labelWrap.addChild(label);
      holder.addChild(labelWrap);

      if (dead) holder.alpha = 0.55;
      pixi.tokenLayer.addChild(holder);
    }

    // --- camera: pure view transform, applied to the world container only ---
    const cam = snap.camera;
    pixi.world.pivot.set(cam.center_x, cam.center_y);
    pixi.world.position.set(pixi.app.screen.width / 2, pixi.app.screen.height / 2);
    pixi.world.scale.set(cam.zoom);
    pixi.world.rotation = (cam.rotation_deg * Math.PI) / 180;
  }

  // ------------------------------------------------------------------------
  // Shared DOM chrome (both modes): turn banner, clocks, roster sidebar
  // ------------------------------------------------------------------------
  // Tell the server our screen size so the GM minimap can outline exactly
  // what the projector shows. Local guard prevents report ping-pong if two
  // displays of different sizes are connected (last reporter wins).
  let reportedViewport = '';
  function reportViewport() {
    const key = `${innerWidth}x${innerHeight}`;
    if (key === reportedViewport) return;
    reportedViewport = key;
    conn.action('display.report_viewport', { width: innerWidth, height: innerHeight });
  }
  addEventListener('resize', () => setTimeout(reportViewport, 200));

  const conn = CampfireWS.connect({
    role: 'display',
    onSnapshot(snap) {
      reportViewport();
      const mapMode = snap.map !== null;
      document.body.classList.toggle('map-mode', mapMode);
      mapRoot.classList.toggle('on', mapMode);
      if (mapMode) renderMap(snap);
      else teardownPixi();

      // whose turn (characters or custom entries like "Goblin Pack")
      const turnEntry = snap.initiative.entries.find((e) => e.id === snap.initiative.turn_id);
      if (!turnEntry) {
        turnEl.textContent = '';
      } else if (turnEntry.char_id !== null) {
        const c = snap.characters.find((x) => x.id === turnEntry.char_id);
        turnEl.textContent = `▶ ${c.name}'s turn`;
      } else {
        turnEl.textContent = `▶ ${turnEntry.label}`;
      }

      // visible clocks
      clocksEl.innerHTML = '';
      for (const clock of snap.clocks) {
        clocksEl.appendChild(CampfireDice.renderClock(clock, { size: mapMode ? 120 : 170 }));
      }

      // ONE sidebar = the initiative stack: character cards and plain gray
      // boxes for custom entries (Ogre, hazards…), in turn order, then any
      // characters who aren't in the order yet.
      const inInitiative = snap.initiative.entries.length > 0;
      rosterEl.innerHTML = `<h2 style="margin-top:0">${inInitiative ? 'Turn Order' : 'The Party'}</h2>`;

      function charCard(c, isTurn) {
        const dead = c.conditions.some((x) => x.kind === 'dead');
        const card = el(`<div class="card ${dead ? 'is-dead' : ''} ${isTurn ? 'turn-active' : ''}"></div>`);
        card.appendChild(el(`<strong>${isTurn ? '▶ ' : ''}${esc(c.name)}</strong>`));
        if (c.system === 'campfire') {
          const dice = el(`<div></div>`);
          const total = { green: 0, yellow: 0, blue: c.granted_blue };
          for (const attr of snap.config.ATTRIBUTES) {
            if (attr === 'constitution') continue;
            total.green = Math.max(total.green, c.dice[attr].green);
            total.yellow = Math.max(total.yellow, c.dice[attr].yellow);
          }
          dice.appendChild(CampfireDice.renderPool(total));
          card.appendChild(dice);
          const conDrained = c.effective.constitution < c.constitution;
          card.appendChild(el(`<div class="small ${conDrained ? '' : 'muted'}">con ${c.effective.constitution}/${c.constitution}</div>`));
        } else {
          const s = c.dnd_sheet;
          const pct = Math.round((s.hp / s.hp_max) * 100);
          card.appendChild(el(`<div class="hp-bar" style="margin-top:6px"><div class="fill" style="width:${pct}%"></div><div class="txt">${s.hp}/${s.hp_max}</div></div>`));
        }
        if (c.conditions.length > 0) {
          card.appendChild(el(`<div class="small muted">${c.conditions.map((x) => esc(x.kind)).join(' · ')}</div>`));
        }
        return card;
      }

      // simple gray box for non-character entries: name (+ visible conditions),
      // same turn highlight
      function customCard(e, isTurn) {
        const card = el(`<div class="card ${isTurn ? 'turn-active' : ''}" style="background:#33343a">
          <strong style="color:#fff">${isTurn ? '▶ ' : ''}${esc(e.label)}</strong></div>`);
        if (e.conditions.length > 0) {
          card.appendChild(el(`<div class="small muted">${e.conditions.map((x) => esc(x.kind)).join(' · ')}</div>`));
        }
        return card;
      }

      const seenCharIds = new Set();
      for (const e of snap.initiative.entries) {
        const isTurn = snap.initiative.turn_id === e.id;
        if (e.char_id !== null) {
          const c = snap.characters.find((x) => x.id === e.char_id);
          if (!c) continue;
          seenCharIds.add(c.id);
          rosterEl.appendChild(charCard(c, isTurn));
        } else {
          rosterEl.appendChild(customCard(e, isTurn));
        }
      }
      for (const c of snap.characters) {
        if (!seenCharIds.has(c.id)) rosterEl.appendChild(charCard(c, false));
      }
    },
  });

  // --- ember particles: campfire mode only; cheap 2D canvas ------------------
  const canvas = document.getElementById('embers');
  const ctx = canvas.getContext('2d');
  let embers = [];

  function resize() {
    canvas.width = innerWidth;
    canvas.height = innerHeight;
  }
  addEventListener('resize', resize);
  resize();

  function spawn() {
    return {
      x: Math.random() * canvas.width,
      y: canvas.height + 10,
      vy: 0.4 + Math.random() * 1.2,
      vx: (Math.random() - 0.5) * 0.6,
      r: 1 + Math.random() * 2.5,
      life: 1,
      decay: 0.002 + Math.random() * 0.004,
      hue: 20 + Math.random() * 25,
    };
  }
  for (let i = 0; i < 40; i++) {
    const e = spawn();
    e.y = Math.random() * canvas.height;
    embers.push(e);
  }

  function tick() {
    if (!document.body.classList.contains('map-mode')) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const e of embers) {
        e.y -= e.vy;
        e.x += e.vx + Math.sin(e.y / 40) * 0.3;
        e.life -= e.decay;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${e.hue}, 100%, 60%, ${Math.max(e.life, 0) * 0.7})`;
        ctx.fill();
      }
      embers = embers.filter((e) => e.life > 0 && e.y > -10);
      while (embers.length < 40) embers.push(spawn());
    }
    requestAnimationFrame(tick);
  }
  tick();
})();
