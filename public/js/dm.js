'use strict';

// GM dashboard: every character (including hidden desires), drain/condition/blue
// controls, encounter refill + live reward rate, initiative board, clock manager.

(function () {
  const root = document.getElementById('root');
  let snap = null;

  const conn = CampfireWS.connect({
    role: 'dm',
    onSnapshot(s) {
      snap = s;
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && ae.dataset.live !== '1') return queueRender(s);
      render();
    },
  });

  let pendingSnap = null;
  function queueRender(s) { pendingSnap = s; }
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (pendingSnap) { snap = pendingSnap; pendingSnap = null; render(); }
    }, 120);
  });

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

  function render() {
    if (!snap) return;
    root.innerHTML = '';
    root.appendChild(encounterBar());
    root.appendChild(initiativeBoard());
    root.appendChild(clocksManager());
    root.appendChild(mapManager());
    root.appendChild(el(`<h2>The party</h2>`));
    const grid = el(`<div class="card-grid"></div>`);
    for (const c of snap.characters) grid.appendChild(charCard(c));
    if (snap.characters.length === 0) grid.appendChild(el(`<p class="muted">No characters yet — players join at the site address and forge heroes.</p>`));
    root.appendChild(grid);
  }

  // --- encounter / settings bar ---------------------------------------------
  function encounterBar() {
    const box = el(`<div class="banner"></div>`);
    const row = el(`<div class="btn-row"></div>`);
    const refill = el(`<button class="primary">🌅 End encounter — refill everyone</button>`);
    refill.onclick = () => {
      if (confirm('End the encounter? All drain refills, blue dice clear, and progression ticks.')) {
        conn.action('character.end_encounter_refill', {});
      }
    };
    row.appendChild(refill);
    const rateWrap = el(`<span style="display:inline-flex;align-items:center;gap:6px">⭐ +1 point every
      <input type="number" data-live="1" min="1" max="99" value="${snap.game.reward_every_n_encounters}" style="width:64px;text-align:center"> encounters</span>`);
    const rateIn = rateWrap.querySelector('input');
    rateIn.onchange = () => conn.action('game.set_reward_rate', { reward_every_n_encounters: Number(rateIn.value) });
    row.appendChild(rateWrap);
    box.appendChild(row);
    return box;
  }

  // --- initiative board: characters AND anything the GM types in -------------
  function initiativeBoard() {
    const box = el(`<div class="card"><h3>⚔ Initiative</h3></div>`);
    const entries = snap.initiative.entries;

    if (entries.length === 0) {
      box.appendChild(el(`<p class="muted small">Empty — add party members or type in monsters, hazards, lair actions…</p>`));
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const c = e.char_id === null ? null : snap.characters.find((x) => x.id === e.char_id);
      const name = c ? c.name : e.label;
      const icon = c ? (c.system === 'campfire' ? '🔥' : '🐉') : '👹';
      const isTurn = snap.initiative.turn_id === e.id;
      const row = el(`<div class="attr-row ${isTurn ? 'turn-active' : ''}"></div>`);
      row.appendChild(el(`<span class="attr-name" style="width:auto;flex:1">${isTurn ? '▶ ' : ''}${icon} ${esc(name)}</span>`));
      const ctl = el(`<span class="btn-row" style="margin:0"></span>`);
      const up = el(`<button class="mini" title="move up">↑</button>`);
      const down = el(`<button class="mini" title="move down">↓</button>`);
      const turn = el(`<button class="mini ${isTurn ? 'primary' : ''}">turn</button>`);
      const out = el(`<button class="mini ghost" title="remove from initiative">✕</button>`);
      up.disabled = i === 0;
      down.disabled = i === entries.length - 1;
      up.onclick = () => reorder(i, i - 1);
      down.onclick = () => reorder(i, i + 1);
      turn.onclick = () => conn.action('initiative.set_turn', { entry_id: e.id });
      out.onclick = () => conn.action('initiative.remove', { entry_id: e.id });
      ctl.append(up, down, turn, out);
      row.appendChild(ctl);
      box.appendChild(row);
    }

    const foot = el(`<div class="btn-row"></div>`);
    if (entries.length > 0) {
      const next = el(`<button>⏭ Next turn</button>`);
      next.onclick = () => {
        const idx = entries.findIndex((e) => e.id === snap.initiative.turn_id);
        conn.action('initiative.set_turn', { entry_id: entries[(idx + 1) % entries.length].id });
      };
      foot.appendChild(next);
    }
    const addSel = el(`<select style="max-width:170px"></select>`);
    for (const c of snap.characters) {
      if (!entries.some((e) => e.char_id === c.id)) {
        addSel.appendChild(el(`<option value="${c.id}">${esc(c.name)}</option>`));
      }
    }
    if (addSel.children.length > 0) {
      const addBtn = el(`<button class="mini">+ add</button>`);
      addBtn.onclick = () => conn.action('initiative.add', { char_id: Number(addSel.value) });
      foot.append(addSel, addBtn);
    }
    box.appendChild(foot);

    const customRow = el(`<div class="btn-row"></div>`);
    const customIn = el(`<input type="text" placeholder="Goblin Pack, Rockslide, The Ritual…" style="max-width:240px" maxlength="40">`);
    const customBtn = el(`<button class="mini">👹 + anything</button>`);
    const addCustom = () => {
      if (customIn.value.trim()) {
        conn.action('initiative.add_custom', { label: customIn.value.trim() });
        customIn.value = '';
      }
    };
    customBtn.onclick = addCustom;
    customIn.onkeydown = (ev) => { if (ev.key === 'Enter') addCustom(); };
    customRow.append(customIn, customBtn);
    box.appendChild(customRow);
    return box;

    function reorder(from, to) {
      const ids = entries.map((e) => e.id);
      const [moved] = ids.splice(from, 1);
      ids.splice(to, 0, moved);
      conn.action('initiative.reorder', { ordered_entry_ids: ids });
    }
  }

  // --- clocks manager ---------------------------------------------------------
  function clocksManager() {
    const box = el(`<div class="card"><h3>🕗 Clocks</h3></div>`);
    const row = el(`<div style="display:flex;flex-wrap:wrap"></div>`);
    for (const clock of snap.clocks) {
      const cell = el(`<div style="text-align:center"></div>`);
      cell.appendChild(CampfireDice.renderClock(clock, {
        onSegmentTap: (filled) => conn.action('clock.set_filled', { clock_id: clock.id, filled }),
      }));
      const ctl = el(`<div class="btn-row" style="justify-content:center"></div>`);
      const vis = el(`<button class="mini ${clock.visibility === 'dm_only' ? '' : 'ghost'}">${clock.visibility === 'dm_only' ? '👁 reveal' : '🙈 hide'}</button>`);
      vis.onclick = () => conn.action('clock.set_visibility', {
        clock_id: clock.id,
        visibility: clock.visibility === 'dm_only' ? 'visible' : 'dm_only',
      });
      const del = el(`<button class="mini danger">✕</button>`);
      del.onclick = () => { if (confirm(`Delete clock “${clock.label}”?`)) conn.action('clock.delete', { clock_id: clock.id }); };
      ctl.append(vis, del);
      cell.appendChild(ctl);
      row.appendChild(cell);
    }
    box.appendChild(row);

    const form = el(`<div class="btn-row"></div>`);
    const label = el(`<input type="text" placeholder="Collapse the bridge" style="max-width:200px" maxlength="60">`);
    const segs = el(`<select style="max-width:80px">${snap.config.CLOCK_SEGMENT_CHOICES.map((n) => `<option ${n === 6 ? 'selected' : ''}>${n}</option>`).join('')}</select>`);
    const kind = el(`<select style="max-width:120px"><option value="progress">progress</option><option value="danger">danger</option></select>`);
    const vis = el(`<select style="max-width:110px"><option value="visible">visible</option><option value="dm_only">secret</option></select>`);
    const add = el(`<button class="mini primary">+ clock</button>`);
    add.onclick = () => {
      conn.action('clock.create', { label: label.value.trim(), segments: Number(segs.value), kind: kind.value, visibility: vis.value });
      label.value = '';
    };
    form.append(label, segs, kind, vis, add);
    box.appendChild(form);
    return box;
  }

  // --- battle map manager (Phase 3) -------------------------------------------
  // Calibration + token + camera state that must survive re-renders:
  const mapUI = {
    upload: null,        // {image_path, image_w, image_h} awaiting calibration
    editingMapId: null,  // set when re-calibrating an existing map
    name: '',            // map name being typed
    taps: [],            // calibration taps in image pixels
    viewScale: 0.25,     // calibration preview zoom
    scroll: { left: 0, top: 0 }, // preview scroll position, preserved across re-renders
    cellsAcross: 5,
    cellsDown: 5,
    selectedToken: null,
  };

  function mapManager() {
    const box = el(`<div class="card"><h3>🗺 Battle map</h3></div>`);
    if (mapUI.upload) {
      box.appendChild(calibrationUI());
    } else if (snap.map) {
      const head = el(`<div class="btn-row"></div>`);
      head.appendChild(el(`<strong style="flex:1">🗺 ${esc(snap.map.name)}</strong>`));
      const rename = el(`<button class="mini ghost" title="rename this map">✎ rename</button>`);
      rename.onclick = () => {
        const name = prompt('Map name:', snap.map.name);
        if (name && name.trim()) conn.action('map.rename', { map_id: snap.map.id, name: name.trim() });
      };
      const recal = el(`<button class="mini ghost" title="re-do the two-tap grid calibration">📐 fix grid</button>`);
      recal.onclick = () => {
        mapUI.upload = { image_path: snap.map.image_path, image_w: snap.map.image_w, image_h: snap.map.image_h };
        mapUI.editingMapId = snap.map.id;
        mapUI.name = snap.map.name;
        mapUI.taps = [];
        mapUI.viewScale = Math.min(1, 700 / snap.map.image_w);
        mapUI.scroll = { left: 0, top: 0 };
        render();
      };
      head.append(rename, recal);
      box.appendChild(head);
      box.appendChild(cameraRemote());
      box.appendChild(tokenManager());
      const foot = el(`<div class="btn-row"></div>`);
      const off = el(`<button class="mini ghost">🌙 Map off (back to campfire display)</button>`);
      off.onclick = () => conn.action('map.set_active', { map_id: null });
      foot.appendChild(off);
      foot.appendChild(uploadButton('upload a different map'));
      box.appendChild(foot);
    } else {
      box.appendChild(el(`<p class="muted small">No map active — the projector shows the campfire roster. Upload a battle map to switch.</p>`));
      box.appendChild(uploadButton('📤 Upload map image'));
      for (const m of snap.maps) {
        const row = el(`<div class="attr-row" style="padding:6px 0"></div>`);
        const use = el(`<button class="mini" style="flex:1;text-align:left">🗺 ${esc(m.name)}</button>`);
        use.onclick = () => conn.action('map.set_active', { map_id: m.id });
        const rename = el(`<button class="mini ghost" title="rename">✎</button>`);
        rename.onclick = () => {
          const name = prompt('Map name:', m.name);
          if (name && name.trim()) conn.action('map.rename', { map_id: m.id, name: name.trim() });
        };
        const del = el(`<button class="mini danger ghost">✕</button>`);
        del.onclick = () => { if (confirm(`Delete “${m.name}”?`)) conn.action('map.delete', { map_id: m.id }); };
        row.append(use, rename, del);
        box.appendChild(row);
      }
    }
    return box;
  }

  function uploadButton(label) {
    const wrap = el(`<span></span>`);
    const file = el(`<input type="file" accept="image/png,image/jpeg,image/webp" style="display:none">`);
    const btn = el(`<button class="mini">${label}</button>`);
    btn.onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files[0];
      if (!f) return;
      conn.toast('Uploading map…', true);
      const dims = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => reject(new Error('not a readable image'));
        img.src = URL.createObjectURL(f);
      });
      const res = await fetch(`/upload/map?w=${dims.w}&h=${dims.h}`, {
        method: 'POST', headers: { 'Content-Type': f.type }, body: f,
      });
      if (!res.ok) {
        conn.toast(`upload failed: ${(await res.json()).error}`, false);
        return;
      }
      mapUI.upload = await res.json();
      mapUI.editingMapId = null;
      mapUI.name = f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'New map';
      mapUI.taps = [];
      mapUI.viewScale = Math.min(1, 700 / mapUI.upload.image_w);
      mapUI.scroll = { left: 0, top: 0 };
      render();
    };
    wrap.append(btn, file);
    return wrap;
  }

  function calibrationUI() {
    const u = mapUI.upload;
    const editing = mapUI.editingMapId !== null;
    const box = el(`<div></div>`);
    box.appendChild(el(`<div class="banner small">
      <strong>${editing ? `Re-calibrating “${esc(mapUI.name)}”` : 'Calibrate the grid'}</strong> — find a clean span of map squares.
      Tap its <strong>top-left corner</strong>, then the <strong>bottom-right corner</strong>.
      The wider the span, the more accurate. Set how many cells the span covers below.</div>`));

    if (!editing) {
      const nameRow = el(`<div class="btn-row"></div>`);
      const nameIn = el(`<input type="text" placeholder="map name" maxlength="40" style="max-width:240px">`);
      nameIn.value = mapUI.name;
      nameIn.oninput = () => { mapUI.name = nameIn.value; };
      nameRow.append(el(`<span class="small">name:</span>`), nameIn);
      box.appendChild(nameRow);
    }

    const sizeRow = el(`<div class="btn-row"></div>`);
    const across = el(`<input type="number" data-live="1" min="1" max="100" style="width:70px;text-align:center">`);
    const down = el(`<input type="number" data-live="1" min="1" max="100" style="width:70px;text-align:center">`);
    across.value = mapUI.cellsAcross;
    down.value = mapUI.cellsDown;
    across.onchange = () => { mapUI.cellsAcross = Number(across.value); };
    down.onchange = () => { mapUI.cellsDown = Number(down.value); };
    sizeRow.append(el(`<span class="small">cells across:</span>`), across, el(`<span class="small">cells down:</span>`), down);
    const zoomOut = el(`<button class="mini">−🔎</button>`);
    const zoomIn = el(`<button class="mini">+🔎</button>`);
    sizeRow.append(zoomOut, zoomIn);
    const cancel = el(`<button class="mini ghost">cancel</button>`);
    cancel.onclick = () => { mapUI.upload = null; mapUI.editingMapId = null; mapUI.taps = []; render(); };
    sizeRow.appendChild(cancel);
    box.appendChild(sizeRow);

    const scroller = el(`<div style="overflow:auto;max-height:60vh;border:1px solid var(--line);border-radius:8px"></div>`);
    const holder = el(`<div style="position:relative;width:${u.image_w * mapUI.viewScale}px;height:${u.image_h * mapUI.viewScale}px"></div>`);
    const img = el(`<img src="${u.image_path}" style="width:100%;height:100%;display:block" draggable="false">`);
    holder.appendChild(img);
    for (const t of mapUI.taps) {
      holder.appendChild(el(`<div style="position:absolute;left:${t.x * mapUI.viewScale - 7}px;top:${t.y * mapUI.viewScale - 7}px;width:14px;height:14px;border-radius:50%;border:3px solid var(--ember);pointer-events:none"></div>`));
    }

    // Keep the view where the GM left it: remember scrolling continuously and
    // restore after every re-render (taps and zooms used to bounce the view
    // back to the top-left corner — maddening on a big map).
    scroller.addEventListener('scroll', () => {
      mapUI.scroll = { left: scroller.scrollLeft, top: scroller.scrollTop };
    }, { passive: true });
    requestAnimationFrame(() => {
      scroller.scrollLeft = mapUI.scroll.left;
      scroller.scrollTop = mapUI.scroll.top;
    });

    // Zoom around the center of what's currently on screen, not the corner.
    const zoomBy = (factor) => {
      const oldScale = mapUI.viewScale;
      const newScale = Math.min(3, Math.max(0.05, oldScale * factor));
      const cx = scroller.scrollLeft + scroller.clientWidth / 2;
      const cy = scroller.scrollTop + scroller.clientHeight / 2;
      mapUI.scroll = {
        left: Math.max(0, (cx * newScale) / oldScale - scroller.clientWidth / 2),
        top: Math.max(0, (cy * newScale) / oldScale - scroller.clientHeight / 2),
      };
      mapUI.viewScale = newScale;
      render();
    };
    zoomOut.onclick = () => zoomBy(1 / 1.4);
    zoomIn.onclick = () => zoomBy(1.4);

    img.onclick = (ev) => {
      const r = img.getBoundingClientRect();
      const x = (ev.clientX - r.left) / mapUI.viewScale;
      const y = (ev.clientY - r.top) / mapUI.viewScale;
      mapUI.taps.push({ x, y });
      if (mapUI.taps.length === 2) {
        finishCalibration(mapUI.cellsAcross, mapUI.cellsDown);
      } else {
        render();
      }
    };
    scroller.appendChild(holder);
    box.appendChild(scroller);
    box.appendChild(el(`<p class="muted small">${mapUI.taps.length === 0 ? 'Waiting for the TOP-LEFT tap…' : 'Now tap the BOTTOM-RIGHT corner of the span.'}</p>`));
    return box;
  }

  function finishCalibration(cellsAcross, cellsDown) {
    const u = mapUI.upload;
    const [a, b] = mapUI.taps;
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    const cell = ((x1 - x0) / cellsAcross + (y1 - y0) / cellsDown) / 2;
    if (!(cell >= 4)) {
      conn.toast('Those taps are too close together — zoom in and try a wider span.', false);
      mapUI.taps = [];
      render();
      return;
    }
    if (mapUI.editingMapId !== null) {
      conn.action('map.update_calibration', {
        map_id: mapUI.editingMapId,
        cell_size: cell, offset_x: x0 % cell, offset_y: y0 % cell,
      });
      conn.toast('Grid re-calibrated! Check it with ▦ grid on.', true);
    } else {
      conn.action('map.calibrate', {
        name: mapUI.name.trim() || 'New map',
        image_path: u.image_path, image_w: u.image_w, image_h: u.image_h,
        cell_size: cell, offset_x: x0 % cell, offset_y: y0 % cell,
      });
      conn.toast('Map calibrated and live on the projector! 🗺', true);
    }
    mapUI.upload = null;
    mapUI.editingMapId = null;
    mapUI.taps = [];
  }

  function cameraRemote() {
    const map = snap.map;
    const cam = snap.camera;
    const box = el(`<div style="border-bottom:1px dashed var(--line);padding-bottom:10px;margin-bottom:10px"></div>`);
    box.appendChild(el(`<h3 style="margin:4px 0">🎥 Camera</h3>`));

    const send = (next) => {
      conn.action('camera.update', {
        center_x: Math.min(Math.max(next.center_x, 0), map.image_w),
        center_y: Math.min(Math.max(next.center_y, 0), map.image_h),
        zoom: Math.min(Math.max(next.zoom, 0.05), 20),
        rotation_deg: next.rotation_deg,
      });
    };

    // minimap: tap anywhere to point the camera there; shows every token so
    // the GM sees the whole board at a glance (the full render is /display)
    const mini = el(`<div style="position:relative;max-width:300px;cursor:crosshair"></div>`);
    const miniImg = el(`<img src="${map.image_path}" style="width:100%;display:block;border:1px solid var(--line);border-radius:8px" draggable="false">`);
    mini.appendChild(miniImg);

    const TOKEN_DOT = { pc: '#3e8ed0', monster: '#c43c34', terrain: '#8a8a8a', glow: '#f0b429' };
    for (const t of snap.tokens) {
      const c = CampfireMap.cellCenter(map, t.col, t.row);
      const selected = mapUI.selectedToken === t.id;
      mini.appendChild(el(`<div title="${esc(t.label)}" style="position:absolute;left:${(c.x / map.image_w) * 100}%;top:${(c.y / map.image_h) * 100}%;width:10px;height:10px;margin:-5px;border-radius:50%;background:${TOKEN_DOT[t.kind]};border:2px solid ${selected ? 'var(--ember)' : '#000'};pointer-events:none;z-index:2"></div>`));
    }

    // What the projector is actually showing: the real viewport rectangle,
    // sized from the display's reported screen ÷ zoom, rotated with the
    // camera. Falls back to a small frame if no display is connected yet.
    const vp = snap.display_viewport;
    if (vp) {
      const wPct = (vp.width / cam.zoom / map.image_w) * 100;
      const hPct = (vp.height / cam.zoom / map.image_h) * 100;
      mini.style.overflow = 'hidden';
      mini.appendChild(el(`<div style="position:absolute;left:${(cam.center_x / map.image_w) * 100}%;top:${(cam.center_y / map.image_h) * 100}%;width:${wPct}%;height:${hPct}%;transform:translate(-50%,-50%) rotate(${-cam.rotation_deg}deg);border:2px solid var(--ember);box-shadow:0 0 10px rgba(255,140,46,.5), inset 0 0 30px rgba(255,140,46,.12);pointer-events:none;z-index:1"></div>`));
    } else {
      mini.appendChild(el(`<div style="position:absolute;left:${(cam.center_x / map.image_w) * 100}%;top:${(cam.center_y / map.image_h) * 100}%;width:26px;height:26px;margin:-13px;border:2px solid var(--ember);border-radius:5px;box-shadow:0 0 8px rgba(255,140,46,.6);pointer-events:none;z-index:1"></div>`));
    }

    miniImg.onclick = (ev) => {
      const r = miniImg.getBoundingClientRect();
      send({ ...cam, center_x: ((ev.clientX - r.left) / r.width) * map.image_w, center_y: ((ev.clientY - r.top) / r.height) * map.image_h });
    };
    box.appendChild(mini);
    box.appendChild(el(`<p class="muted small" style="margin:4px 0">Dots = tokens (blue players, red monsters) · orange frame = where the camera points.
      The full battle map renders on the <a href="/display" target="_blank">projector page</a>.</p>`));

    const pan = map.cell_size * 2;
    const ctl = el(`<div class="btn-row"></div>`);
    const mk = (txt, fn, title) => {
      const b = el(`<button class="mini" title="${title}">${txt}</button>`);
      b.onclick = fn;
      return b;
    };
    // Nudges are SCREEN-relative: with the map rotated 90°, "up" means up on
    // the projector, not up in image pixels — so rotate the pan vector by the
    // inverse of the camera rotation before applying it in image space.
    const nudge = (sx, sy) => {
      const th = (cam.rotation_deg * Math.PI) / 180;
      send({
        ...cam,
        center_x: cam.center_x + (sx * Math.cos(th) + sy * Math.sin(th)) * pan,
        center_y: cam.center_y + (-sx * Math.sin(th) + sy * Math.cos(th)) * pan,
      });
    };
    ctl.append(
      mk('◀', () => nudge(-1, 0), 'nudge left (as seen on the projector)'),
      mk('▲', () => nudge(0, -1), 'nudge up (as seen on the projector)'),
      mk('▼', () => nudge(0, 1), 'nudge down (as seen on the projector)'),
      mk('▶', () => nudge(1, 0), 'nudge right (as seen on the projector)'),
      mk('+🔎', () => send({ ...cam, zoom: cam.zoom * 1.3 }), 'zoom in'),
      mk('−🔎', () => send({ ...cam, zoom: cam.zoom / 1.3 }), 'zoom out'),
      mk('⟲', () => send({ ...cam, rotation_deg: cam.rotation_deg - 15 }), 'rotate left'),
      mk('⟳', () => send({ ...cam, rotation_deg: cam.rotation_deg + 15 }), 'rotate right'),
      mk('🎯', () => send({ center_x: map.image_w / 2, center_y: map.image_h / 2, zoom: 1, rotation_deg: 0 }), 'reset view'),
    );
    ctl.appendChild(el(`<span class="muted small">zoom ${Math.round(cam.zoom * 100)}%${cam.rotation_deg ? ` · ${cam.rotation_deg}°` : ''}</span>`));
    const gridBtn = el(`<button class="mini ${map.grid_visible ? '' : 'ghost'}" title="overlay the calibrated grid on the projector">▦ grid ${map.grid_visible ? 'on' : 'off'}</button>`);
    gridBtn.onclick = () => conn.action('map.set_grid_visible', { map_id: map.id, visible: !map.grid_visible });
    ctl.appendChild(gridBtn);
    box.appendChild(ctl);

    // bookmarks: saved views to snap to mid-session — save field on top,
    // the list of saved views rendered underneath it
    const bm = el(`<div class="btn-row"></div>`);
    const bmName = el(`<input type="text" placeholder="view name (e.g. ambush)" style="max-width:180px" maxlength="20">`);
    const bmSave = el(`<button class="mini">📌 save this view</button>`);
    const saveView = () => {
      if (bmName.value.trim()) {
        conn.action('camera.save_bookmark', { name: bmName.value.trim() });
        bmName.value = '';
      }
    };
    bmSave.onclick = saveView;
    bmName.onkeydown = (ev) => { if (ev.key === 'Enter') saveView(); };
    bm.append(bmName, bmSave);
    box.appendChild(bm);

    if (snap.camera_bookmarks.length > 0) {
      const list = el(`<div style="margin-top:4px"></div>`);
      list.appendChild(el(`<div class="muted small">Saved views — tap to jump:</div>`));
      for (const b of snap.camera_bookmarks) {
        const row = el(`<div class="attr-row" style="padding:6px 0"></div>`);
        const go = el(`<button class="mini" style="flex:1;text-align:left">🎥 ${esc(b.name)} <span class="muted small">(${Math.round(b.zoom * 100)}%${b.rotation_deg ? ` · ${b.rotation_deg}°` : ''})</span></button>`);
        go.onclick = () => send(b);
        const overwrite = el(`<button class="mini ghost" title="re-save this view as the current camera">update</button>`);
        overwrite.onclick = () => conn.action('camera.save_bookmark', { name: b.name });
        const del = el(`<button class="mini danger ghost" title="delete this view">✕</button>`);
        del.onclick = () => conn.action('camera.delete_bookmark', { name: b.name });
        row.append(go, overwrite, del);
        list.appendChild(row);
      }
      box.appendChild(list);
    }
    return box;
  }

  function tokenManager() {
    const map = snap.map;
    const dims = CampfireMap.gridDims(map);
    const box = el(`<div></div>`);
    box.appendChild(el(`<h3 style="margin:4px 0">♟ Tokens <span class="muted small">(${dims.cols}×${dims.rows} grid)</span></h3>`));

    // create form
    const form = el(`<div class="btn-row"></div>`);
    const label = el(`<input type="text" placeholder="Ogre" style="max-width:130px" maxlength="30">`);
    const kind = el(`<select style="max-width:110px">
      <option value="monster">monster</option><option value="pc">player</option>
      <option value="terrain">terrain</option><option value="glow">glow</option></select>`);
    const charSel = el(`<select style="max-width:140px;display:none"></select>`);
    for (const c of snap.characters) {
      if (!snap.tokens.some((t) => t.char_id === c.id)) {
        charSel.appendChild(el(`<option value="${c.id}">${esc(c.name)}</option>`));
      }
    }
    kind.onchange = () => { charSel.style.display = kind.value === 'pc' ? '' : 'none'; };
    const addBtn = el(`<button class="mini primary">+ place</button>`);
    addBtn.onclick = () => {
      const cam = snap.camera;
      const at = CampfireMap.clampToGrid(map, ...Object.values(CampfireMap.imageToGrid(map, cam.center_x, cam.center_y)));
      const payload = { kind: kind.value, col: at.col, row: at.row };
      if (kind.value === 'pc') {
        if (!charSel.value) { conn.toast('every character already has a token', false); return; }
        payload.char_id = Number(charSel.value);
        payload.label = snap.characters.find((c) => c.id === payload.char_id).name;
      } else {
        payload.label = label.value.trim() || kind.value;
      }
      if (kind.value === 'glow') {
        payload.glow_color = '#ff8c2e';
        payload.glow_radius = 3;
        payload.glow_pulse = 0.5;
      }
      conn.action('token.create', payload);
      label.value = '';
    };
    form.append(label, kind, charSel, addBtn);
    box.appendChild(form);

    // token list; tap to select, selected gets a d-pad
    for (const t of snap.tokens) {
      const icons = { pc: '🧝', monster: '👹', terrain: '🪨', glow: '✨' };
      const selected = mapUI.selectedToken === t.id;
      const row = el(`<div class="attr-row" style="cursor:pointer${selected ? ';background:rgba(255,140,46,.08)' : ''}"></div>`);
      row.appendChild(el(`<span class="attr-name" style="width:auto;flex:1">${icons[t.kind]} ${esc(t.label)} <span class="muted small">(${t.col},${t.row})</span></span>`));
      row.onclick = () => { mapUI.selectedToken = selected ? null : t.id; render(); };
      if (selected) {
        const pad = el(`<span class="btn-row" style="margin:0"></span>`);
        const mv = (dc, dr, txt) => {
          const b = el(`<button class="mini">${txt}</button>`);
          b.onclick = (ev) => {
            ev.stopPropagation();
            conn.action('token.move', { token_id: t.id, col: t.col + dc, row: t.row + dr });
          };
          return b;
        };
        const del = el(`<button class="mini danger ghost">✕</button>`);
        del.onclick = (ev) => { ev.stopPropagation(); mapUI.selectedToken = null; conn.action('token.delete', { token_id: t.id }); };
        pad.append(mv(-1, 0, '◀'), mv(0, -1, '▲'), mv(0, 1, '▼'), mv(1, 0, '▶'), del);
        row.appendChild(pad);
      }
      box.appendChild(row);
    }
    if (snap.tokens.length === 0) box.appendChild(el(`<p class="muted small">No tokens yet — place the party!</p>`));
    return box;
  }

  // --- character cards ---------------------------------------------------------
  function charCard(c) {
    const dead = c.conditions.some((x) => x.kind === 'dead');
    const isTurn = snap.initiative.turn_id === `char:${c.id}`;
    const card = el(`<div class="card ${dead ? 'is-dead' : ''} ${isTurn ? 'turn-active' : ''}"></div>`);
    const sys = c.system === 'campfire' ? '🔥' : '🐉';
    card.appendChild(el(`<div class="card-head"><h3>${sys} ${esc(c.name)}</h3><span class="muted small">${esc(c.concept)}</span></div>`));
    if (c.hidden_desire) {
      card.appendChild(el(`<p class="small" style="color:var(--gold)">🤫 ${esc(c.hidden_desire)}</p>`));
    }

    if (c.system === 'campfire') {
      for (const attr of snap.config.ATTRIBUTES) {
        const eff = c.effective[attr];
        const row = el(`<div class="attr-row"></div>`);
        row.appendChild(el(`<span class="attr-name small">${attr}</span>`));
        row.appendChild(el(`<span class="attr-rank">${eff < c[attr] ? `<span class="drained">${eff}</span>` : eff}<span class="muted small">/${c[attr]}</span></span>`));
        const dr = el(`<span class="btn-row" style="margin:0"></span>`);
        const dPlus = el(`<button class="mini" title="drain">−</button>`);
        const dMinus = el(`<button class="mini ghost" title="undo drain">+</button>`);
        dPlus.disabled = eff <= 0;
        dMinus.disabled = c.drain[attr] <= 0;
        dPlus.onclick = () => conn.action('character.set_drain', { char_id: c.id, attr, amount: c.drain[attr] + 1 });
        dMinus.onclick = () => conn.action('character.set_drain', { char_id: c.id, attr, amount: c.drain[attr] - 1 });
        dr.append(dPlus, dMinus);
        row.appendChild(dr);
        attachPool(row, c.dice[attr]);
        card.appendChild(row);
      }
      const ctl = el(`<div class="btn-row"></div>`);
      const absorb = el(`<button class="mini">🛡 Con absorb</button>`);
      absorb.disabled = c.effective.constitution <= 0;
      absorb.onclick = () => conn.action('character.absorb_with_con', { char_id: c.id });
      const blueMinus = el(`<button class="mini ghost">−🔷</button>`);
      blueMinus.disabled = c.granted_blue <= 0;
      blueMinus.onclick = () => conn.action('character.grant_blue', { char_id: c.id, amount: -1 });
      const bluePlus = el(`<button class="mini">+🔷 blue (${c.granted_blue})</button>`);
      bluePlus.onclick = () => conn.action('character.grant_blue', { char_id: c.id, amount: 1 });
      const refillOne = el(`<button class="mini ghost" title="refill just this character">refill</button>`);
      refillOne.onclick = () => conn.action('character.end_encounter_refill', { char_id: c.id });
      ctl.append(absorb, bluePlus, blueMinus, refillOne);
      card.appendChild(ctl);
      card.appendChild(el(`<p class="muted small">encounters: ${c.encounters_done}${c.pending_points > 0 ? ` · <strong style="color:var(--gold)">⭐ ${c.pending_points} point(s) to place</strong>` : ''}</p>`));
    } else {
      const s = c.dnd_sheet;
      const pct = Math.round((s.hp / s.hp_max) * 100);
      card.appendChild(el(`<p class="muted small">Lv ${s.level} ${esc(s.race)} ${esc(s.class_name)} · AC ${s.ac} · spd ${s.speed}</p>`));
      card.appendChild(el(`<div class="hp-bar"><div class="fill" style="width:${pct}%"></div><div class="txt">${s.hp}/${s.hp_max}${s.temp_hp > 0 ? ` +${s.temp_hp}t` : ''}</div></div>`));
      const ctl = el(`<div class="btn-row" style="margin-top:8px"></div>`);
      const amt = el(`<input type="number" data-live="1" value="1" min="1" max="999" style="width:64px;text-align:center">`);
      const dmg = el(`<button class="mini danger">💥</button>`);
      const heal = el(`<button class="mini">💚</button>`);
      const send = (mutate) => {
        const next = JSON.parse(JSON.stringify(s));
        mutate(next);
        conn.action('character.update_dnd', { char_id: c.id, sheet: next });
      };
      dmg.onclick = () => send((n) => {
        let d = Number(amt.value);
        const fromTemp = Math.min(d, n.temp_hp);
        n.temp_hp -= fromTemp; d -= fromTemp;
        n.hp = Math.max(0, n.hp - d);
      });
      heal.onclick = () => send((n) => { n.hp = Math.min(n.hp_max, n.hp + Number(amt.value)); });
      const fullHeal = el(`<button class="mini" title="full HP, death saves cleared, spell slots restored — like the campfire refill">🌙 full heal</button>`);
      fullHeal.onclick = () => send((n) => {
        n.hp = n.hp_max;
        n.temp_hp = 0;
        n.death_successes = 0;
        n.death_failures = 0;
        for (const slot of n.spell_slots) slot.used = 0;
      });
      ctl.append(amt, dmg, heal, fullHeal);
      card.appendChild(ctl);
    }

    // conditions
    const chips = el(`<div class="chips"></div>`);
    for (const kind of snap.config.CONDITIONS[c.system]) {
      const existing = c.conditions.find((x) => x.kind === kind);
      const chip = el(`<span class="chip ${existing ? 'on' : ''} ${kind === 'dead' ? 'chip-dead' : ''}">${kind}</span>`);
      chip.onclick = () => {
        existing
          ? conn.action('condition.remove', { condition_id: existing.id })
          : conn.action('condition.add', { char_id: c.id, kind });
      };
      chips.appendChild(chip);
    }
    card.appendChild(chips);

    const foot = el(`<div class="btn-row"></div>`);
    if (!snap.initiative.entries.some((e) => e.char_id === c.id)) {
      const init = el(`<button class="mini ghost">+ initiative</button>`);
      init.onclick = () => conn.action('initiative.add', { char_id: c.id });
      foot.appendChild(init);
    }
    const del = el(`<button class="mini danger ghost">delete</button>`);
    del.onclick = () => {
      if (confirm(`Permanently delete ${c.name}? This cannot be undone.`)) {
        conn.action('character.delete', { char_id: c.id });
      }
    };
    foot.appendChild(del);
    card.appendChild(foot);
    return card;
  }

  function attachPool(row, dice) {
    row.appendChild(CampfireDice.renderPool(dice));
  }
})();
