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
  // Screen transition: a quick splash that fades over the moment the projector
  // swaps between screens (reveal ↔ map ↔ home, or one reveal to another), like
  // a broadcast bumper. Uses the GM's uploaded image, or a branded default.
  // ------------------------------------------------------------------------
  let transitionEl = null;
  let transitionImg = null;
  let transitionTimer = null;
  let lastScreenKey = null;
  // Warm the bumper splash images into the decoded-texture cache as soon as a
  // snapshot names them, so when a screen swap actually fires the fade never
  // stalls decoding a cold 4K image on the main thread (the visible hitch).
  const transitionImgCache = new Map();
  function preloadTransitionImages(snap) {
    const imgs = (snap.settings && snap.settings.transition_images) || {};
    for (const k in imgs) {
      const url = imgs[k];
      if (!url || transitionImgCache.has(url)) continue;
      const im = new Image();
      im.decoding = 'async';
      im.src = url;
      if (im.decode) im.decode().catch(() => {});
      transitionImgCache.set(url, im);
    }
  }
  function screenKeyOf(snap) {
    if (snap.revealed_card) return 'reveal:' + snap.revealed_card.id;
    if (snap.map) return 'map:' + snap.map.id;
    return 'home';
  }
  function ensureTransitionEl() {
    if (transitionEl) return;
    transitionEl = el(`<div id="screen-transition"><div class="screen-transition-inner"></div></div>`);
    transitionImg = transitionEl.firstChild;
    document.body.appendChild(transitionEl);
  }
  function playTransition(snap) {
    ensureTransitionEl();
    // the splash image is chosen by the kind of reveal we're moving TO; map/home
    // (or a kind with no uploaded image) gets a soft direct fade instead.
    const imgs = (snap.settings && snap.settings.transition_images) || {};
    const kind = snap.revealed_card ? snap.revealed_card.kind : null;
    const img = (kind && imgs[kind]) || '';
    if (img) {
      transitionEl.classList.remove('blank');
      transitionImg.className = 'screen-transition-inner has-image';
      transitionImg.style.backgroundImage = `url('${img}')`;
      transitionImg.textContent = '';
    } else {
      transitionEl.classList.add('blank'); // soft dim crossfade, no splash
      transitionImg.className = 'screen-transition-inner';
      transitionImg.style.backgroundImage = '';
      transitionImg.textContent = '';
    }
    // force a reflow so re-triggering mid-fade restarts cleanly
    void transitionEl.offsetWidth;
    transitionEl.classList.add('show');
    clearTimeout(transitionTimer);
    const ms = (snap.settings && snap.settings.transition_ms) || 520;
    transitionTimer = setTimeout(() => transitionEl.classList.remove('show'), ms);
  }

  // ------------------------------------------------------------------------
  // PixiJS map renderer (created lazily; torn down when the map turns off)
  // ------------------------------------------------------------------------
  const pixi = {
    app: null, world: null, mapSprite: null, gridLayer: null, tokenLayer: null,
    imagePath: null, glows: [],
    // fog of war: a cloud layer clipped to the hidden cells (see renderMap)
    fogLayer: null, fogMask: null, fogFill: null, cloudA: null, cloudB: null, fogKey: null,
  };

  // PIXI texture wrapping the shared tileable cloud canvas (built once).
  let cloudTex = null;
  function ensureCloudTexture() {
    if (!cloudTex) cloudTex = PIXI.Texture.from(CampfireMap.cloudCanvas());
    return cloudTex;
  }

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

    // glow pulse + fog drift animation — cheap, display client only
    pixi.app.ticker.add(() => {
      const t = performance.now() / 1000;
      for (const g of pixi.glows) {
        const wave = g.pulse === 0 ? 1 : 0.75 + 0.25 * Math.sin(2 * Math.PI * g.pulse * t);
        g.sprite.alpha = 0.55 * wave;
        g.sprite.scale.set(wave);
      }
      // two cloud layers crawl in different directions → slow billowing fog
      if (pixi.fogLayer && pixi.fogLayer.visible) {
        pixi.cloudA.tilePosition.set(t * 6, t * 2.5);
        pixi.cloudB.tilePosition.set(-t * 3.5, t * 4);
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
    pixi.fogLayer = pixi.fogMask = pixi.fogFill = pixi.cloudA = pixi.cloudB = null;
    pixi.fogKey = null;
    pixi.imagePath = null;
    pixi.glows = [];
    mapRoot.innerHTML = '';
  }

  function hexToNum(color) {
    return Number(`0x${color.replace('#', '')}`);
  }

  // Rebuild the fog clip-mask from the visibility bitmask: the mask is the union
  // of hidden cells (horizontal runs merged so it stays a handful of rects), and
  // the cloud fill spans the whole image — the mask is what reveals it only over
  // the fog. Cheap and only re-run when the bitmask or calibration changes.
  function rebuildFog(map) {
    pixi.fogMask.clear();
    pixi.fogFill.clear();
    const on = !!map.fog_enabled && !!map.fog;
    pixi.fogLayer.visible = on;
    if (!on) return;
    const { cols, rows } = CampfireMap.gridDims(map);
    pixi.fogMask.beginFill(0xffffff);
    for (let r = 0; r < rows; r++) {
      let run = -1;
      for (let c = 0; c <= cols; c++) {
        const hidden = c < cols && map.fog[r * cols + c] === '0';
        if (hidden && run < 0) run = c;
        else if (!hidden && run >= 0) {
          pixi.fogMask.drawRect(
            map.offset_x + run * map.cell_size, map.offset_y + r * map.cell_size,
            (c - run) * map.cell_size, map.cell_size,
          );
          run = -1;
        }
      }
    }
    pixi.fogMask.endFill();
    pixi.fogFill.beginFill(0xffffff).drawRect(0, 0, map.image_w, map.image_h).endFill();
    pixi.cloudA.width = pixi.cloudB.width = map.image_w;
    pixi.cloudA.height = pixi.cloudB.height = map.image_h;
    pixi.cloudA.tileScale.set((map.cell_size * 4) / 256);
    pixi.cloudB.tileScale.set((map.cell_size * 7) / 256);
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
      // fog layer: an opaque cloud fill clipped to the hidden cells, drawn over
      // the map + grid but UNDER the tokens (revealed tokens always stay crisp).
      pixi.fogLayer = new PIXI.Container();
      pixi.fogMask = new PIXI.Graphics();
      pixi.fogFill = new PIXI.Graphics();
      const tex = ensureCloudTexture();
      pixi.cloudA = new PIXI.TilingSprite(tex, map.image_w, map.image_h);
      pixi.cloudB = new PIXI.TilingSprite(tex, map.image_w, map.image_h);
      pixi.fogLayer.addChild(pixi.fogFill, pixi.cloudA, pixi.cloudB, pixi.fogMask);
      pixi.fogLayer.mask = pixi.fogMask;
      pixi.fogKey = null;
      pixi.world.addChild(pixi.mapSprite);
      pixi.world.addChild(pixi.gridLayer);
      pixi.world.addChild(pixi.fogLayer);
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

    // --- fog of war: cloud layer clipped to the hidden cells ----------------
    // Re-stamp the mask only when the bitmask/calibration changed; the darkness
    // dial is cheap (tint + alpha) so it rides every snapshot. The clouds drift
    // forever via the ticker; darkness fades them out toward pitch black so a
    // "dark room" reads as flat black while light gray stays billowy.
    const fogKey = `${map.fog_enabled}|${map.fog}|${map.cell_size}|${map.offset_x}|${map.offset_y}|${map.image_w}|${map.image_h}`;
    if (pixi.fogKey !== fogKey) { rebuildFog(map); pixi.fogKey = fogKey; }
    if (pixi.fogLayer.visible) {
      const d = Math.min(Math.max(map.fog_darkness == null ? 0.85 : map.fog_darkness, 0), 1);
      pixi.fogFill.tint = CampfireMap.lerpHex(0x9aa1ad, 0x050608, d); // light gray → near black
      pixi.fogFill.alpha = 0.5 + 0.5 * d;                 // translucent fog → opaque dark
      const cloudVis = 1 - d;
      pixi.cloudA.tint = 0xd6dae3;
      pixi.cloudB.tint = 0xb8bdc8;
      pixi.cloudA.alpha = 0.45 * cloudVis;
      pixi.cloudB.alpha = 0.3 * cloudVis;
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
      preloadTransitionImages(snap);

      // Bump a splash over the swap when the projected screen changes. Fire it
      // BEFORE applying the new content so the cover rises as things change (no
      // first-frame flash of the new screen). Skipped on the very first snapshot.
      const screenKey = screenKeyOf(snap);
      if (lastScreenKey !== null && screenKey !== lastScreenKey
          && snap.settings && snap.settings.transitions_enabled !== false) {
        playTransition(snap);
      }
      lastScreenKey = screenKey;

      // Full-screen NPC reveal sits above everything; the GM toggles entries
      // live and this re-renders in place (same id) without restarting slides.
      if (snap.revealed_card) CampfireNPCReveal.show(snap.revealed_card, { dismissible: false });
      else CampfireNPCReveal.hide();

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
        const face = c.token_art
          ? `<span style="display:inline-block;width:34px;height:34px;border-radius:50%;background-image:url('${c.token_art}');background-size:cover;background-position:center;border:2px solid var(--ember-deep);vertical-align:middle;margin-right:6px"></span>`
          : '';
        card.appendChild(el(`<strong style="display:flex;align-items:center">${face}${isTurn ? '▶ ' : ''}${esc(c.name)}</strong>`));
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
        const card = el(`<div class="card ${isTurn ? 'turn-active' : ''}" style="background:#33343a"></div>`);
        const face = e.art
          ? `<span style="display:inline-block;width:34px;height:34px;border-radius:50%;background-image:url('${e.art}');background-size:cover;background-position:center;border:2px solid var(--ember-deep);vertical-align:middle;margin-right:6px"></span>`
          : '';
        card.appendChild(el(`<strong style="color:#fff;display:flex;align-items:center">${face}${isTurn ? '▶ ' : ''}${esc(e.label)}</strong>`));
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

  // Cap the ember BUFFER and let CSS stretch it to fill the screen: a 4K
  // projector would otherwise clear an 8.3-megapixel canvas every frame for a
  // 40-particle field. ~1080p backing is plenty; the GPU scales it up for free.
  const EMBER_MAX_DIM = 1920;
  function resize() {
    const scale = Math.min(1, EMBER_MAX_DIM / Math.max(innerWidth, innerHeight));
    canvas.width = Math.max(1, Math.round(innerWidth * scale));
    canvas.height = Math.max(1, Math.round(innerHeight * scale));
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
    // Skip the field in map mode and while a full-screen reveal is open — both
    // fully occlude the embers, so drawing them is wasted frame budget right
    // when the transition needs it most.
    const occluded = CampfireNPCReveal.isOpen();
    if (!document.body.classList.contains('map-mode') && !occluded) {
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
