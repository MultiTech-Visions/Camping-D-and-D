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
      updateTokenMover(); // the mover overlay tracks live state even when render is skipped
      if (mapUI.draggingViewport) return queueRender(s); // don't rebuild the minimap mid-drag
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && ae.dataset.live !== '1') return queueRender(s);
      render();
    },
    onResult(msg) {
      // a fresh token starts selected: the very next minimap tap places it
      if (msg.op === 'token.create' && msg.created_token_id) {
        mapUI.selectedToken = msg.created_token_id;
        render();
      }
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

  // One shared condition editor: freeform names with quick-fill (built-in
  // lists + everything the GM has used before), per-condition visibility,
  // rename, delete. Subject = {char_id} or {entry_id}.
  function conditionEditor(conditions, subject) {
    const wrap = el(`<div></div>`);
    for (const c of conditions) {
      const secret = c.visibility === 'dm_only';
      const row = el(`<div class="attr-row" style="padding:4px 0"></div>`);
      row.appendChild(el(`<span class="small" style="flex:1;${secret ? 'color:var(--gold)' : ''}">${secret ? '🙈 ' : '⚑ '}${esc(c.kind)}</span>`));
      const ctl = el(`<span class="btn-row" style="margin:0"></span>`);
      const eye = el(`<button class="mini ghost" title="${secret ? 'show to players + projector' : 'make GM-only'}">${secret ? '👁' : '🙈'}</button>`);
      eye.onclick = () => conn.action('condition.update', { condition_id: c.id, visibility: secret ? 'visible' : 'dm_only' });
      const edit = el(`<button class="mini ghost" title="rename">✎</button>`);
      edit.onclick = () => {
        const kind = prompt('Condition / note:', c.kind);
        if (kind && kind.trim()) conn.action('condition.update', { condition_id: c.id, kind: kind.trim() });
      };
      const del = el(`<button class="mini danger ghost">✕</button>`);
      del.onclick = () => conn.action('condition.remove', { condition_id: c.id });
      ctl.append(eye, edit, del);
      row.appendChild(ctl);
      wrap.appendChild(row);
    }
    const add = el(`<div class="btn-row"></div>`);
    const input = el(`<input type="text" list="cond-suggestions" placeholder="poisoned, +2 vs goblins, owes Mira…" maxlength="60" style="max-width:210px">`);
    const vis = el(`<select style="max-width:110px"><option value="visible">visible</option><option value="dm_only">GM-only</option></select>`);
    const btn = el(`<button class="mini">+ add</button>`);
    const doAdd = () => {
      if (!input.value.trim()) return;
      conn.action('condition.add', { ...subject, kind: input.value.trim(), visibility: vis.value });
      input.value = '';
    };
    btn.onclick = doAdd;
    input.onkeydown = (ev) => { if (ev.key === 'Enter') doAdd(); };
    add.append(input, vis, btn);
    wrap.appendChild(add);
    return wrap;
  }

  let condOpenEntry = null; // custom initiative entry whose condition editor is expanded

  // --- token mover: fullscreen pinch-zoom map + a big thumbable d-pad, so the
  //     GM can steer a token while watching the projector, not the phone -----
  let tokenMover = null, tokenMoverId = null, tokenMoverInfo = null, tokenMoverTapOn = false;

  function openTokenMover(tokenId) {
    if (tokenMover) tokenMover.close();
    tokenMoverId = tokenId;
    tokenMoverTapOn = false;
    const wrap = el(`<div></div>`);
    tokenMoverInfo = el(`<p class="center" style="margin:0 0 10px;font-size:1.1rem"></p>`);
    wrap.appendChild(tokenMoverInfo);
    const pad = el(`<div class="dpad"></div>`);
    const mv = (sx, sy, txt) => {
      const b = el(`<button>${txt}</button>`);
      b.onclick = () => {
        const t = snap.tokens.find((x) => x.id === tokenMoverId);
        if (!t) return;
        const step = CampfireMap.screenStepToGrid(snap.camera.rotation_deg, sx, sy);
        conn.action('token.move', { token_id: t.id, col: t.col + step.dc, row: t.row + step.dr });
      };
      return b;
    };
    // center button: tap-to-place mode — pan/zoom pauses, taps drop the token
    // there; toggle off and the arrows finish the fine placement
    const tapBtn = el(`<button class="ghost" title="tap-to-place: tap the map to put the token there">🎯</button>`);
    tapBtn.onclick = () => {
      tokenMoverTapOn = !tokenMoverTapOn;
      tapBtn.className = tokenMoverTapOn ? 'primary' : 'ghost';
      tokenMover.setTapMode(!tokenMoverTapOn ? null : (fx, fy) => {
        const t = snap.tokens.find((x) => x.id === tokenMoverId);
        if (!t) return;
        const map = snap.map;
        const g = CampfireMap.imageToGrid(map, fx * map.image_w, fy * map.image_h);
        const dims = CampfireMap.gridDims(map);
        conn.action('token.move', {
          token_id: t.id,
          col: Math.min(Math.max(g.col, 0), dims.cols - t.w),
          row: Math.min(Math.max(g.row, 0), dims.rows - t.h),
        });
      });
      updateTokenMover();
    };
    pad.append(el(`<span></span>`), mv(0, -1, '▲'), el(`<span></span>`),
      mv(-1, 0, '◀'), tapBtn, mv(1, 0, '▶'),
      el(`<span></span>`), mv(0, 1, '▼'), el(`<span></span>`));

    // vertical zoom slider on the right: the whole popup runs on one thumb —
    // pan, zoom, 🎯 place, fine arrows
    const zoomWrap = el(`<div style="display:flex;flex-direction:column;align-items:center;gap:4px"></div>`);
    const zoomSlider = el(`<input type="range" min="1" max="10" step="0.1" value="1"
      style="writing-mode:vertical-lr;direction:rtl;-webkit-appearance:slider-vertical;width:44px;height:180px">`);
    zoomSlider.oninput = () => { if (tokenMover) tokenMover.setZoom(Number(zoomSlider.value)); };
    zoomWrap.append(el(`<span class="muted small">🔎+</span>`), zoomSlider, el(`<span class="muted small">🔎−</span>`));

    const controls = el(`<div style="display:flex;align-items:center;justify-content:center;gap:22px"></div>`);
    controls.append(pad, zoomWrap);
    wrap.appendChild(controls);
    tokenMover = CampfireMapViewer.open({
      bottomEl: wrap,
      fog: false, // the GM places tokens with full sight; fog is for players
      onClose: () => { tokenMover = null; tokenMoverId = null; tokenMoverInfo = null; tokenMoverTapOn = false; },
      onZoomChange: (s) => { zoomSlider.value = s; }, // pinch keeps the slider honest
    });
    updateTokenMover();
  }

  function updateTokenMover() {
    if (!tokenMover) return;
    const t = snap.tokens.find((x) => x.id === tokenMoverId);
    if (!t || !snap.map) { tokenMover.close(); return; }
    tokenMoverInfo.textContent = tokenMoverTapOn
      ? `🎯 tap the map to place ${t.label} — (${t.col}, ${t.row})`
      : `🕹 ${t.label} — (${t.col}, ${t.row})`;
    tokenMover.update(snap, { highlight: tokenMoverId });
  }

  function render() {
    if (!snap) return;
    root.innerHTML = '';
    // quick-fill source for every condition input on the page
    const suggestions = [...new Set([
      ...snap.used_conditions,
      ...snap.config.CONDITIONS.campfire,
      ...snap.config.CONDITIONS.dnd5e,
    ])];
    root.appendChild(el(`<datalist id="cond-suggestions">${suggestions.map((k) => `<option value="${esc(k)}">`).join('')}</datalist>`));
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
      // characters show their portrait (no emoji clutter); customs keep 👹
      const face = c && c.token_art
        ? `<span style="display:inline-block;width:30px;height:30px;border-radius:50%;background-image:url('${c.token_art}');background-size:cover;background-position:center;border:2px solid var(--ember-deep);vertical-align:middle;margin-right:6px"></span>`
        : (c ? '' : '👹 ');
      const isTurn = snap.initiative.turn_id === e.id;
      const hidden = e.visibility === 'dm_only';
      const row = el(`<div class="attr-row ${isTurn ? 'turn-active' : ''}" ${hidden ? 'style="opacity:.65"' : ''}></div>`);
      const condSummary = e.char_id === null && e.conditions.length > 0
        ? ` <span class="muted small">${e.conditions.map((x) => `${x.visibility === 'dm_only' ? '🙈' : ''}${esc(x.kind)}`).join(' · ')}</span>` : '';
      row.appendChild(el(`<span class="attr-name" style="width:auto;flex:1;display:flex;align-items:center;flex-wrap:wrap">${isTurn ? '▶ ' : ''}${face}${esc(name)}${hidden ? ' <span class="small" style="color:var(--gold)">🙈 GM-only</span>' : ''}${condSummary}</span>`));
      const ctl = el(`<span class="btn-row" style="margin:0"></span>`);
      const up = el(`<button class="mini" title="move up">↑</button>`);
      const down = el(`<button class="mini" title="move down">↓</button>`);
      const turn = el(`<button class="mini ${isTurn ? 'primary' : ''}">turn</button>`);
      const eye = el(`<button class="mini ghost" title="${hidden ? 'show on the projector + player phones' : 'hide from the projector + player phones (GM-only reminder)'}">${hidden ? '👁' : '🙈'}</button>`);
      eye.onclick = () => conn.action('initiative.set_visibility', { entry_id: e.id, visibility: hidden ? 'visible' : 'dm_only' });
      const out = el(`<button class="mini ghost" title="remove from initiative">✕</button>`);
      up.disabled = i === 0;
      down.disabled = i === entries.length - 1;
      up.onclick = () => reorder(i, i - 1);
      down.onclick = () => reorder(i, i + 1);
      turn.onclick = () => conn.action('initiative.set_turn', { entry_id: e.id });
      out.onclick = () => conn.action('initiative.remove', { entry_id: e.id });
      if (e.char_id === null) {
        const flag = el(`<button class="mini ${condOpenEntry === e.id ? 'primary' : 'ghost'}" title="conditions / notes on this entry">⚑</button>`);
        flag.onclick = () => { condOpenEntry = condOpenEntry === e.id ? null : e.id; render(); };
        ctl.append(up, down, turn, flag, eye, out);
      } else {
        ctl.append(up, down, turn, eye, out);
      }
      row.appendChild(ctl);
      box.appendChild(row);
      if (e.char_id === null && condOpenEntry === e.id) {
        const condBox = el(`<div style="margin:0 0 6px 24px;border-left:2px solid var(--line);padding-left:10px"></div>`);
        condBox.appendChild(conditionEditor(e.conditions, { entry_id: e.id }));
        box.appendChild(condBox);
      }
    }

    const foot = el(`<div class="btn-row"></div>`);
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

    // the big one lives at the very bottom, out of the way and easy to thumb
    if (entries.length > 0) {
      const next = el(`<button style="width:100%;margin-top:10px">⏭ Next turn</button>`);
      next.onclick = () => {
        const idx = entries.findIndex((e) => e.id === snap.initiative.turn_id);
        conn.action('initiative.set_turn', { entry_id: entries[(idx + 1) % entries.length].id });
      };
      box.appendChild(next);
    }
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
    draggingViewport: false, // suppress re-renders while dragging the minimap box
    recoloring: null,        // token id whose color picker is open
    resizing: null,          // token id whose size editor is open
    newLabel: '',            // create-form state that must survive re-renders
    newKind: 'monster',
    newColor: '#c43c34',
    newShape: 'circle',
    newW: 1,
    newH: 1,
  };

  // Broad starter colors; the GM's own colors live in snap.custom_colors.
  const BASIC_COLORS = ['#c43c34', '#e2701a', '#e7c52a', '#3f9b4f', '#3e8ed0', '#7b4fa6', '#d957a8', '#f3e9d8', '#8a8a8a', '#2b2b2e'];

  // ONE color picker: basic swatches, the saved palette (gold ring), a custom
  // color input, ⭐ to save the current color, 🗑 to unsave it.
  function colorPicker(current, onPick) {
    const wrap = el(`<div class="btn-row" style="gap:4px;align-items:center"></div>`);
    const swatch = (color, saved) => {
      const sel = color === current;
      const b = el(`<button class="mini" title="${color}${saved ? ' (saved)' : ''}" style="width:30px;height:30px;min-height:30px;padding:0;border-radius:50%;background:${color};border:2px solid ${sel ? 'var(--ember)' : saved ? 'var(--gold)' : 'var(--line)'};${sel ? 'box-shadow:0 0 6px var(--ember)' : ''}"></button>`);
      b.onclick = () => onPick(color);
      return b;
    };
    for (const c of BASIC_COLORS) wrap.appendChild(swatch(c, false));
    for (const c of snap.custom_colors) wrap.appendChild(swatch(c, true));
    const custom = el(`<input type="color" value="${current}" title="custom color" style="width:38px;height:30px;padding:1px;border-radius:6px;flex:none">`);
    custom.onchange = () => onPick(custom.value.toLowerCase());
    wrap.appendChild(custom);
    if (snap.custom_colors.includes(current)) {
      const unsave = el(`<button class="mini ghost" title="remove this color from the saved palette">🗑</button>`);
      unsave.onclick = () => conn.action('palette.delete_color', { color: current });
      wrap.appendChild(unsave);
    } else {
      const save = el(`<button class="mini ghost" title="save this color to the palette">⭐</button>`);
      save.onclick = () => conn.action('palette.save_color', { color: current });
      wrap.appendChild(save);
    }
    return wrap;
  }

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
      box.appendChild(mapSetupControls());
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

    for (const t of snap.tokens) {
      const selected = mapUI.selectedToken === t.id;
      const dotColor = t.kind === 'glow' ? t.glow_color : t.color;
      // draw the actual footprint (w×h cells), shape-matched; tiny ones keep a visible minimum
      const left = ((map.offset_x + t.col * map.cell_size) / map.image_w) * 100;
      const top = ((map.offset_y + t.row * map.cell_size) / map.image_h) * 100;
      const wPct = ((t.w * map.cell_size) / map.image_w) * 100;
      const hPct = ((t.h * map.cell_size) / map.image_h) * 100;
      const miniFill = t.art
        ? `background-image:url('${t.art}');background-size:cover;background-position:center`
        : `background:${dotColor}`;
      mini.appendChild(el(`<div title="${esc(t.label)}" style="position:absolute;left:${left}%;top:${top}%;width:${wPct}%;height:${hPct}%;min-width:8px;min-height:8px;border-radius:${t.shape === 'square' ? '15%' : '50%'};${miniFill};border:2px solid ${selected ? 'var(--ember)' : '#000'};${selected ? 'box-shadow:0 0 8px var(--ember);' : ''}opacity:.92;pointer-events:none;z-index:2"></div>`));
    }

    // What the projector is actually showing: the real viewport rectangle,
    // sized from the display's reported screen ÷ zoom, rotated with the
    // camera. Falls back to a small frame if no display is connected yet.
    const vp = snap.display_viewport;
    let vpBox;
    if (vp) {
      const wPct = (vp.width / cam.zoom / map.image_w) * 100;
      const hPct = (vp.height / cam.zoom / map.image_h) * 100;
      mini.style.overflow = 'hidden';
      vpBox = el(`<div style="position:absolute;left:${(cam.center_x / map.image_w) * 100}%;top:${(cam.center_y / map.image_h) * 100}%;width:${wPct}%;height:${hPct}%;transform:translate(-50%,-50%) rotate(${-cam.rotation_deg}deg);border:2px solid var(--ember);box-shadow:0 0 10px rgba(255,140,46,.5), inset 0 0 30px rgba(255,140,46,.12);pointer-events:none;z-index:1"></div>`);
    } else {
      vpBox = el(`<div style="position:absolute;left:${(cam.center_x / map.image_w) * 100}%;top:${(cam.center_y / map.image_h) * 100}%;width:26px;height:26px;margin:-13px;border:2px solid var(--ember);border-radius:5px;box-shadow:0 0 8px rgba(255,140,46,.6);pointer-events:none;z-index:1"></div>`);
    }
    mini.appendChild(vpBox);

    // Minimap gestures:
    //   tap (token selected)  → teleport that token to the tapped cell
    //   tap (nothing selected) → jump the camera there
    //   drag the box / drag anywhere → pan the camera, projector follows live
    mini.style.touchAction = 'none';
    let grabDX = 0, grabDY = 0, lastLiveSend = 0;
    let dragX = cam.center_x, dragY = cam.center_y;
    let gestureMode = null; // 'camera' | 'tap'
    let downClient = null;
    const toImage = (ev) => {
      const r = miniImg.getBoundingClientRect();
      return {
        x: Math.min(Math.max(((ev.clientX - r.left) / r.width) * map.image_w, 0), map.image_w),
        y: Math.min(Math.max(((ev.clientY - r.top) / r.height) * map.image_h, 0), map.image_h),
      };
    };
    const toCell = (p) => {
      const g = CampfireMap.imageToGrid(map, p.x, p.y);
      return CampfireMap.clampToGrid(map, g.col, g.row);
    };
    const placeBox = (x, y) => {
      vpBox.style.left = `${(x / map.image_w) * 100}%`;
      vpBox.style.top = `${(y / map.image_h) * 100}%`;
    };
    // While a token is selected, the minimap belongs to TOKEN PLACEMENT:
    // camera drag and the viewport box are suspended so a tap (or
    // drag-and-release) always places the token. Deselecting the token in
    // the list hands the minimap back to the camera.
    const tokenPlacementMode = () => snap.tokens.some((t) => t.id === mapUI.selectedToken);
    mini.onpointerdown = (ev) => {
      ev.preventDefault();
      const p = toImage(ev);
      downClient = { x: ev.clientX, y: ev.clientY };
      const halfW = vp ? vp.width / cam.zoom / 2 : map.image_w * 0.04;
      const halfH = vp ? vp.height / cam.zoom / 2 : map.image_h * 0.04;
      if (!tokenPlacementMode()
          && Math.abs(p.x - dragX) <= halfW && Math.abs(p.y - dragY) <= halfH) {
        gestureMode = 'camera'; // grabbed the box — keep the grip point
        grabDX = dragX - p.x;
        grabDY = dragY - p.y;
        mapUI.draggingViewport = true;
      } else {
        gestureMode = 'tap';
        grabDX = 0;
        grabDY = 0;
      }
      mini.setPointerCapture(ev.pointerId);
    };
    mini.onpointermove = (ev) => {
      if (gestureMode === 'tap'
          && Math.hypot(ev.clientX - downClient.x, ev.clientY - downClient.y) > 10) {
        if (tokenPlacementMode()) return; // stay in tap mode: place where the finger releases
        gestureMode = 'camera';
        mapUI.draggingViewport = true;
        const p = toImage(ev);
        dragX = p.x;
        dragY = p.y;
        placeBox(dragX, dragY);
      }
      if (gestureMode === 'camera' && mapUI.draggingViewport) {
        const p = toImage(ev);
        dragX = Math.min(Math.max(p.x + grabDX, 0), map.image_w);
        dragY = Math.min(Math.max(p.y + grabDY, 0), map.image_h);
        placeBox(dragX, dragY);
        const now = Date.now();
        if (now - lastLiveSend > 120) { // live-follow on the projector
          lastLiveSend = now;
          send({ ...cam, center_x: dragX, center_y: dragY });
        }
      }
    };
    const endDrag = () => {
      if (!mapUI.draggingViewport) return;
      mapUI.draggingViewport = false;
      snap.camera.center_x = dragX; // optimistic — the server echo confirms
      snap.camera.center_y = dragY;
      send({ ...cam, center_x: dragX, center_y: dragY });
    };
    mini.onpointerup = (ev) => {
      if (gestureMode === 'camera') {
        endDrag();
      } else if (gestureMode === 'tap') {
        const p = toImage(ev);
        const sel = snap.tokens.find((t) => t.id === mapUI.selectedToken);
        if (sel) {
          // teleport the selected token; keep its whole footprint on the map
          const dims = CampfireMap.gridDims(map);
          const cell = toCell(p);
          conn.action('token.move', {
            token_id: sel.id,
            col: Math.min(cell.col, dims.cols - sel.w),
            row: Math.min(cell.row, dims.rows - sel.h),
          });
        } else {
          dragX = p.x;
          dragY = p.y;
          snap.camera.center_x = p.x;
          snap.camera.center_y = p.y;
          send({ ...cam, center_x: p.x, center_y: p.y });
        }
      }
      gestureMode = null;
    };
    mini.onpointercancel = () => {
      if (gestureMode === 'camera') endDrag();
      gestureMode = null;
    };
    if (tokenPlacementMode()) vpBox.style.opacity = '0.35'; // camera control is on hold
    box.appendChild(mini);
    const sel = snap.tokens.find((t) => t.id === mapUI.selectedToken);
    box.appendChild(el(`<p class="small" style="margin:4px 0;${sel ? 'color:var(--gold)' : ''}">${sel
      ? `♟ Tap the minimap to move <strong>${esc(sel.label)}</strong> there (arrows fine-tune).`
      : 'Tap = aim camera · drag = pan. Select a token below to place it by tapping.'}</p>`));
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

  // Map orientation + fog-of-war setup, surfaced right under the map header so
  // the GM lands here straight after calibrating. Orientation seeds how the map
  // opens on the projector; fog hides everything until the GM reveals it.
  function mapSetupControls() {
    const map = snap.map;
    const box = el(`<div style="border-bottom:1px dashed var(--line);padding-bottom:10px;margin-bottom:10px"></div>`);
    box.appendChild(el(`<h3 style="margin:4px 0">🧭 Orientation &amp; fog</h3>`));

    const oriRow = el(`<div class="btn-row" style="align-items:center"></div>`);
    oriRow.appendChild(el(`<span class="small">opens facing:</span>`));
    for (const deg of snap.config.MAP_ROTATIONS) {
      const on = (map.base_rotation || 0) === deg;
      const b = el(`<button class="mini ${on ? '' : 'ghost'}" title="primary orientation on the projector">${deg}°</button>`);
      b.onclick = () => conn.action('map.set_base_rotation', { map_id: map.id, rotation_deg: deg });
      oriRow.appendChild(b);
    }
    box.appendChild(oriRow);

    const fogRow = el(`<div class="btn-row"></div>`);
    const fogBtn = el(`<button class="mini ${map.fog_enabled ? '' : 'ghost'}" title="hide the map until you reveal it">🌫 Fog ${map.fog_enabled ? 'on' : 'off'}</button>`);
    fogBtn.onclick = () => conn.action('map.set_fog_enabled', { map_id: map.id, enabled: !map.fog_enabled });
    fogRow.appendChild(fogBtn);
    if (map.fog_enabled) {
      const edit = el(`<button class="mini primary">✏️ Edit fog</button>`);
      edit.onclick = openFogEditor;
      fogRow.appendChild(edit);
    }
    box.appendChild(fogRow);

    if (map.fog_enabled) {
      const dark = map.fog_darkness == null ? 0.85 : map.fog_darkness;
      const darkRow = el(`<div class="btn-row" style="align-items:center"></div>`);
      darkRow.appendChild(el(`<span class="small">darkness:</span>`));
      const dial = el(`<input type="range" data-live="1" min="0" max="100" style="flex:1;max-width:170px">`);
      dial.value = Math.round(dark * 100);
      const lbl = el(`<span class="muted small">${dial.value}%</span>`);
      dial.oninput = () => { lbl.textContent = `${dial.value}%`; };
      dial.onchange = () => conn.action('map.set_fog_darkness', { map_id: map.id, darkness: Number(dial.value) / 100 });
      darkRow.append(dial, lbl);
      box.appendChild(darkRow);
      box.appendChild(el(`<p class="muted small" style="margin:2px 0">Light gray fog → pitch black. Players &amp; the projector only see revealed squares (and any tokens standing in them).</p>`));
    }
    return box;
  }

  // =========================================================================
  // Fog-of-war editor: fullscreen, like the players' map view (pinch to zoom,
  // drag to pan) but it paints visibility. 🔒 locks navigation so one finger
  // paints cells; two fingers always still pinch/pan. Green = revealed, red =
  // hidden, both translucent so the map shows through. Edits commit to the
  // server when a stroke ends.
  // =========================================================================
  let fog = null;

  function openFogEditor() {
    if (fog || !snap.map || !snap.map.fog_enabled) return;
    const map = { ...snap.map };
    const dims = CampfireMap.gridDims(map);
    const len = dims.cols * dims.rows;
    const work = (map.fog && map.fog.length === len ? map.fog : CampfireMap.fogAllHidden(map)).split('');

    const overlay = el(`<div style="position:fixed;inset:0;background:#0c0906;z-index:60;overflow:hidden;touch-action:none"></div>`);
    const holder = el(`<div style="position:absolute;left:0;top:0;transform-origin:0 0"></div>`);
    const img = el(`<img draggable="false" style="display:block;width:100%;user-select:none">`);
    const cv = el(`<canvas style="position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none"></canvas>`);
    holder.append(img, cv);
    overlay.appendChild(holder);

    // toolbar
    const bar = el(`<div style="position:absolute;left:0;right:0;top:0;display:flex;flex-wrap:wrap;gap:6px;padding:8px;background:linear-gradient(#0c0906ee,#0c090600);z-index:2"></div>`);
    const lockBtn = el(`<button></button>`);
    const revealBtn = el(`<button class="mini">🟢 Reveal</button>`);
    const hideBtn = el(`<button class="mini">🔴 Hide</button>`);
    const lassoBtn = el(`<button class="mini" title="draw a loop to fill the area inside">⭕ Lasso</button>`);
    const allOn = el(`<button class="mini ghost" title="reveal the whole map">reveal all</button>`);
    const allOff = el(`<button class="mini ghost" title="hide the whole map">hide all</button>`);
    const doneBtn = el(`<button class="mini primary">✓ Done</button>`);
    bar.append(lockBtn, revealBtn, hideBtn, lassoBtn, allOn, allOff, doneBtn);
    overlay.appendChild(bar);
    const hint = el(`<div style="position:absolute;left:0;right:0;bottom:0;padding:8px;text-align:center;font-size:12px;color:#f3e9d8;background:linear-gradient(#0c090600,#0c0906dd);z-index:2"></div>`);
    overlay.appendChild(hint);
    document.body.appendChild(overlay);

    fog = {
      overlay, holder, img, cv, ctx: cv.getContext('2d'), map,
      cols: dims.cols, rows: dims.rows, work,
      scale: 1, tx: 0, ty: 0,
      mode: 'nav', brush: 'reveal', tool: 'brush',
      lassoPts: null, lastPaint: null, dirty: false,
    };
    fog.apply = () => { holder.style.transform = `translate(${fog.tx}px, ${fog.ty}px) scale(${fog.scale})`; };

    const baseW = overlay.clientWidth;
    holder.style.width = `${baseW}px`;
    cv.width = Math.max(1, Math.round(baseW));
    cv.height = Math.max(1, Math.round(baseW * (map.image_h / map.image_w)));
    img.onload = drawFogEditor;
    img.src = map.image_path;
    fog.ty = (overlay.clientHeight - baseW * (map.image_h / map.image_w)) / 2;
    fog.apply();

    const clampView = () => {
      const vw = overlay.clientWidth, vh = overlay.clientHeight;
      const cw = holder.offsetWidth * fog.scale, ch = holder.offsetHeight * fog.scale;
      fog.tx = cw <= vw ? (vw - cw) / 2 : Math.min(0, Math.max(vw - cw, fog.tx));
      fog.ty = ch <= vh ? (vh - ch) / 2 : Math.min(0, Math.max(vh - ch, fog.ty));
    };

    const toImage = (ev) => {
      const r = img.getBoundingClientRect();
      return {
        x: ((ev.clientX - r.left) / r.width) * map.image_w,
        y: ((ev.clientY - r.top) / r.height) * map.image_h,
      };
    };

    const setCell = (col, row) => {
      if (col < 0 || row < 0 || col >= fog.cols || row >= fog.rows) return;
      fog.work[row * fog.cols + col] = fog.brush === 'reveal' ? '1' : '0';
    };
    // paint every cell on the segment from the last point to here, so a fast
    // drag doesn't leave gaps
    const paintTo = (p) => {
      const cell = CampfireMap.imageToGrid(map, p.x, p.y);
      if (fog.lastPaint) {
        const a = fog.lastPaint, steps = Math.max(1, Math.ceil(Math.hypot(p.x - a.x, p.y - a.y) / (map.cell_size / 2)));
        for (let i = 1; i <= steps; i++) {
          const x = a.x + ((p.x - a.x) * i) / steps, y = a.y + ((p.y - a.y) * i) / steps;
          const g = CampfireMap.imageToGrid(map, x, y);
          setCell(g.col, g.row);
        }
      } else {
        setCell(cell.col, cell.row);
      }
      fog.lastPaint = p;
      fog.dirty = true;
      drawFogEditor();
    };

    const commit = () => {
      if (!fog.dirty) return;
      fog.dirty = false;
      conn.action('map.set_fog', { map_id: map.id, fog: fog.work.join('') });
    };

    // --- gestures: pinch/pan always on two fingers; one finger paints when
    //     locked, pans when not -------------------------------------------
    const pointers = new Map();
    let pinchStart = null;
    overlay.onpointerdown = (ev) => {
      overlay.setPointerCapture(ev.pointerId);
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pointers.size === 2) {
        // a second finger cancels any in-progress stroke and starts a pinch
        fog.lastPaint = null; fog.lassoPts = null; drawFogEditor();
        const [a, b] = [...pointers.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: fog.scale, world: { x: (mid.x - fog.tx) / fog.scale, y: (mid.y - fog.ty) / fog.scale } };
      } else if (pointers.size === 1 && fog.mode === 'paint') {
        const p = toImage(ev);
        if (fog.tool === 'lasso') { fog.lassoPts = [p]; }
        else { fog.lastPaint = null; paintTo(p); }
      }
    };
    overlay.onpointermove = (ev) => {
      const prev = pointers.get(ev.pointerId);
      if (!prev) return;
      const cur = { x: ev.clientX, y: ev.clientY };
      if (pointers.size === 2 && pinchStart) {
        pointers.set(ev.pointerId, cur);
        const [a, b] = [...pointers.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        fog.scale = Math.min(12, Math.max(1, pinchStart.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.dist)));
        fog.tx = mid.x - pinchStart.world.x * fog.scale;
        fog.ty = mid.y - pinchStart.world.y * fog.scale;
        clampView(); fog.apply();
      } else if (pointers.size === 1) {
        if (fog.mode === 'paint' && fog.tool === 'lasso' && fog.lassoPts) {
          fog.lassoPts.push(toImage(ev)); drawFogEditor();
        } else if (fog.mode === 'paint') {
          paintTo(toImage(ev));
        } else {
          fog.tx += cur.x - prev.x; fog.ty += cur.y - prev.y;
          pointers.set(ev.pointerId, cur);
          clampView(); fog.apply();
        }
      }
    };
    const lift = (ev) => {
      const wasOne = pointers.size === 1;
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinchStart = null;
      if (wasOne && fog.mode === 'paint') {
        if (fog.tool === 'lasso' && fog.lassoPts) { fillLasso(fog.lassoPts); fog.lassoPts = null; }
        fog.lastPaint = null;
        commit();
      }
    };
    overlay.onpointerup = lift;
    overlay.onpointercancel = lift;

    function fillLasso(pts) {
      if (pts.length < 3) { drawFogEditor(); return; }
      // every cell whose center falls inside the drawn loop flips to the brush
      let minC = fog.cols, maxC = 0, minR = fog.rows, maxR = 0;
      for (const p of pts) {
        const g = CampfireMap.imageToGrid(map, p.x, p.y);
        minC = Math.min(minC, g.col); maxC = Math.max(maxC, g.col);
        minR = Math.min(minR, g.row); maxR = Math.max(maxR, g.row);
      }
      for (let r = Math.max(0, minR); r <= Math.min(fog.rows - 1, maxR); r++) {
        for (let c = Math.max(0, minC); c <= Math.min(fog.cols - 1, maxC); c++) {
          const ctr = CampfireMap.cellCenter(map, c, r);
          if (pointInPolygon(ctr.x, ctr.y, pts)) setCell(c, r);
        }
      }
      fog.dirty = true;
      drawFogEditor();
    }

    function pointInPolygon(x, y, pts) {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
        if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
      }
      return inside;
    }

    // --- toolbar wiring -----------------------------------------------------
    const refreshBar = () => {
      lockBtn.textContent = fog.mode === 'paint' ? '🖐 Move map' : '🔒 Lock & paint';
      lockBtn.className = fog.mode === 'paint' ? 'mini primary' : 'mini';
      revealBtn.className = `mini ${fog.brush === 'reveal' ? '' : 'ghost'}`;
      hideBtn.className = `mini ${fog.brush === 'hide' ? '' : 'ghost'}`;
      lassoBtn.className = `mini ${fog.tool === 'lasso' ? '' : 'ghost'}`;
      hint.innerHTML = fog.mode === 'paint'
        ? `Painting <strong style="color:${fog.brush === 'reveal' ? '#5fe07a' : '#ff6b5e'}">${fog.brush}</strong> with the ${fog.tool === 'lasso' ? 'lasso (draw a loop)' : 'brush (drag across cells)'} · two fingers still zoom &amp; pan`
        : 'Drag to pan · pinch to zoom · tap 🔒 to start painting fog';
    };
    lockBtn.onclick = () => { fog.mode = fog.mode === 'paint' ? 'nav' : 'paint'; fog.lassoPts = null; fog.lastPaint = null; refreshBar(); drawFogEditor(); };
    revealBtn.onclick = () => { fog.brush = 'reveal'; if (fog.mode === 'nav') fog.mode = 'paint'; refreshBar(); };
    hideBtn.onclick = () => { fog.brush = 'hide'; if (fog.mode === 'nav') fog.mode = 'paint'; refreshBar(); };
    lassoBtn.onclick = () => { fog.tool = fog.tool === 'lasso' ? 'brush' : 'lasso'; if (fog.mode === 'nav') fog.mode = 'paint'; refreshBar(); };
    allOn.onclick = () => { fog.work = new Array(len).fill('1'); fog.dirty = true; drawFogEditor(); commit(); };
    allOff.onclick = () => { fog.work = new Array(len).fill('0'); fog.dirty = true; drawFogEditor(); commit(); };
    doneBtn.onclick = closeFogEditor;
    refreshBar();
  }

  function drawFogEditor() {
    if (!fog) return;
    const { ctx, cv, map, cols, rows } = fog;
    const sc = cv.width / map.image_w;
    const cs = map.cell_size * sc;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    // green/red cells, horizontal runs merged to keep fills cheap
    for (let r = 0; r < rows; r++) {
      let run = -1, runVal = null;
      for (let c = 0; c <= cols; c++) {
        const v = c < cols ? fog.work[r * cols + c] : null;
        if (v !== runVal) {
          if (run >= 0) {
            ctx.fillStyle = runVal === '1' ? 'rgba(60,200,90,0.38)' : 'rgba(210,55,45,0.42)';
            ctx.fillRect((map.offset_x + run * map.cell_size) * sc, (map.offset_y + r * map.cell_size) * sc, (c - run) * cs, cs);
          }
          run = c; runVal = v;
        }
      }
    }
    // grid lines for orientation
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 0; c <= cols; c++) {
      const x = (map.offset_x + c * map.cell_size) * sc;
      ctx.moveTo(x, map.offset_y * sc); ctx.lineTo(x, (map.offset_y + rows * map.cell_size) * sc);
    }
    for (let r = 0; r <= rows; r++) {
      const y = (map.offset_y + r * map.cell_size) * sc;
      ctx.moveTo(map.offset_x * sc, y); ctx.lineTo((map.offset_x + cols * map.cell_size) * sc, y);
    }
    ctx.stroke();
    // live lasso outline
    if (fog.lassoPts && fog.lassoPts.length > 1) {
      ctx.strokeStyle = fog.brush === 'reveal' ? '#5fe07a' : '#ff6b5e';
      ctx.lineWidth = 2; ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ctx.moveTo(fog.lassoPts[0].x * sc, fog.lassoPts[0].y * sc);
      for (const p of fog.lassoPts) ctx.lineTo(p.x * sc, p.y * sc);
      ctx.stroke(); ctx.setLineDash([]);
    }
  }

  function closeFogEditor() {
    if (!fog) return;
    fog.overlay.remove();
    fog = null;
  }

  function tokenManager() {
    const map = snap.map;
    const dims = CampfireMap.gridDims(map);
    const box = el(`<div></div>`);
    box.appendChild(el(`<h3 style="margin:4px 0">♟ Tokens <span class="muted small">(${dims.cols}×${dims.rows} grid)</span></h3>`));

    const atCamera = () => CampfireMap.clampToGrid(map,
      CampfireMap.imageToGrid(map, snap.camera.center_x, snap.camera.center_y).col,
      CampfireMap.imageToGrid(map, snap.camera.center_x, snap.camera.center_y).row);

    // create form — new tokens land at the camera center, then select + tap
    // the minimap to put them exactly where you want
    const form = el(`<div></div>`);
    const row1 = el(`<div class="btn-row"></div>`);
    const label = el(`<input type="text" placeholder="Ogre" style="max-width:130px" maxlength="30">`);
    label.value = mapUI.newLabel;
    label.oninput = () => { mapUI.newLabel = label.value; };
    const kind = el(`<select style="max-width:110px">
      <option value="monster">monster</option><option value="pc">player</option>
      <option value="terrain">terrain</option><option value="glow">glow</option></select>`);
    kind.value = mapUI.newKind;
    const charSel = el(`<select style="max-width:140px;${mapUI.newKind === 'pc' ? '' : 'display:none'}"></select>`);
    for (const c of snap.characters) {
      if (!snap.tokens.some((t) => t.char_id === c.id)) {
        charSel.appendChild(el(`<option value="${c.id}">${esc(c.name)}</option>`));
      }
    }
    kind.onchange = () => {
      mapUI.newKind = kind.value;
      mapUI.newColor = snap.config.TOKEN_DEFAULT_COLORS[kind.value];
      mapUI.newShape = snap.config.TOKEN_DEFAULT_SHAPES[kind.value];
      render();
    };
    const addBtn = el(`<button class="mini primary">+ add token</button>`);
    addBtn.onclick = () => {
      const at = atCamera();
      const payload = {
        kind: mapUI.newKind, col: at.col, row: at.row, color: mapUI.newColor,
        shape: mapUI.newShape, w: mapUI.newW, h: mapUI.newH,
      };
      if (mapUI.newKind === 'pc') {
        if (!charSel.value) { conn.toast('every character already has a token', false); return; }
        payload.char_id = Number(charSel.value);
        payload.label = snap.characters.find((c) => c.id === payload.char_id).name;
      } else {
        payload.label = mapUI.newLabel.trim() || mapUI.newKind;
      }
      if (mapUI.newKind === 'glow') {
        payload.glow_radius = 3;
        payload.glow_pulse = 0.5;
      }
      conn.action('token.create', payload);
      mapUI.newLabel = '';
    };
    row1.append(label, kind, charSel, addBtn);
    form.appendChild(row1);
    const sizeRow = el(`<div class="btn-row" style="align-items:center"></div>`);
    const shapeSel = el(`<select style="max-width:110px"><option value="circle">● round</option><option value="square">■ square</option></select>`);
    shapeSel.value = mapUI.newShape;
    shapeSel.onchange = () => { mapUI.newShape = shapeSel.value; };
    const wIn = el(`<input type="number" min="1" max="50" style="width:62px;text-align:center">`);
    const hIn = el(`<input type="number" min="1" max="50" style="width:62px;text-align:center">`);
    wIn.value = mapUI.newW;
    hIn.value = mapUI.newH;
    wIn.onchange = () => { mapUI.newW = Math.max(1, Number(wIn.value) || 1); };
    hIn.onchange = () => { mapUI.newH = Math.max(1, Number(hIn.value) || 1); };
    sizeRow.append(shapeSel, el(`<span class="small">size:</span>`), wIn, el(`<span class="small">×</span>`), hIn, el(`<span class="muted small">cells</span>`));
    form.appendChild(sizeRow);
    form.appendChild(colorPicker(mapUI.newColor, (c) => { mapUI.newColor = c; render(); }));
    box.appendChild(form);

    // one-tap tokens for initiative entries that aren't on the map yet
    // (matched by name) — spawns at the camera, pre-selected for tap-placement
    const unmade = snap.initiative.entries.filter((e) =>
      e.char_id === null && !snap.tokens.some((t) => t.label.toLowerCase() === e.label.toLowerCase()));
    if (unmade.length > 0) {
      const quick = el(`<div class="btn-row"></div>`);
      quick.appendChild(el(`<span class="muted small">from initiative:</span>`));
      for (const e of unmade) {
        const b = el(`<button class="mini ghost">♟ ${esc(e.label)}</button>`);
        b.onclick = () => {
          const at = atCamera();
          conn.action('token.create', {
            kind: 'monster', label: e.label, col: at.col, row: at.row,
            shape: 'circle', w: 1, h: 1,
          });
        };
        quick.appendChild(b);
      }
      box.appendChild(quick);
    }

    // token list; tap to select → d-pad + 🎨 recolor (and minimap tap-to-move)
    for (const t of snap.tokens) {
      const icons = { pc: '🧝', monster: '👹', terrain: '🪨', glow: '✨' };
      const selected = mapUI.selectedToken === t.id;
      const dotColor = t.kind === 'glow' ? t.glow_color : t.color;
      const row = el(`<div class="attr-row" style="cursor:pointer${selected ? ';background:rgba(255,140,46,.08)' : ''}"></div>`);
      const dotFill = t.art
        ? `background-image:url('${t.art}');background-size:cover;background-position:center`
        : `background:${dotColor}`;
      row.appendChild(el(`<span class="attr-name" style="width:auto;flex:1">
        <span style="display:inline-block;width:18px;height:18px;border-radius:${t.shape === 'square' ? '3px' : '50%'};${dotFill};border:1px solid #000;vertical-align:middle"></span>
        ${icons[t.kind]} ${esc(t.label)} <span class="muted small">(${t.col},${t.row})${t.w > 1 || t.h > 1 ? ` ${t.w}×${t.h}` : ''}</span></span>`));
      row.onclick = () => {
        mapUI.selectedToken = selected ? null : t.id;
        if (mapUI.recoloring !== t.id) mapUI.recoloring = null;
        if (mapUI.resizing !== t.id) mapUI.resizing = null;
        render();
      };
      if (selected) {
        const pad = el(`<span class="btn-row" style="margin:0"></span>`);
        // big-screen mover: pinch-zoom map + a giant d-pad in a popup, so the
        // GM can steer while watching the projector
        const mover = el(`<button class="mini primary" title="move ${esc(t.label)} — big arrows + map view">🕹 move</button>`);
        mover.onclick = (ev) => { ev.stopPropagation(); openTokenMover(t.id); };
        const paint = el(`<button class="mini ${mapUI.recoloring === t.id ? 'primary' : 'ghost'}">🎨</button>`);
        paint.onclick = (ev) => {
          ev.stopPropagation();
          mapUI.recoloring = mapUI.recoloring === t.id ? null : t.id;
          mapUI.resizing = null;
          render();
        };
        const resize = el(`<button class="mini ${mapUI.resizing === t.id ? 'primary' : 'ghost'}">📐</button>`);
        resize.onclick = (ev) => {
          ev.stopPropagation();
          mapUI.resizing = mapUI.resizing === t.id ? null : t.id;
          mapUI.recoloring = null;
          render();
        };
        const del = el(`<button class="mini danger ghost">✕</button>`);
        del.onclick = (ev) => { ev.stopPropagation(); mapUI.selectedToken = null; conn.action('token.delete', { token_id: t.id }); };
        pad.append(mover, paint, resize);
        // one tap into the turn order: characters via their entry, others by name
        if (t.kind !== 'glow') {
          const inInitiative = t.char_id !== null
            ? snap.initiative.entries.some((e) => e.char_id === t.char_id)
            : snap.initiative.entries.some((e) => e.char_id === null && e.label.toLowerCase() === t.label.toLowerCase());
          if (!inInitiative) {
            const init = el(`<button class="mini ghost" title="add ${esc(t.label)} to the initiative order">⚔</button>`);
            init.onclick = (ev) => {
              ev.stopPropagation();
              if (t.char_id !== null) conn.action('initiative.add', { char_id: t.char_id });
              else conn.action('initiative.add_custom', { label: t.label });
            };
            pad.appendChild(init);
          }
        }
        if (t.kind !== 'glow') {
          const artFile = el(`<input type="file" accept="image/png,image/jpeg,image/webp" style="display:none">`);
          const artBtn = el(`<button class="mini ghost" title="${t.art ? 'replace this token’s image' : 'use an image for this token (a 3x3 dragon deserves a dragon)'}">🖼</button>`);
          artBtn.onclick = (ev) => { ev.stopPropagation(); artFile.click(); };
          artFile.onclick = (ev) => ev.stopPropagation();
          artFile.onchange = async () => {
            const file = artFile.files[0];
            if (!file) return;
            conn.toast('Uploading token art…', true);
            const res = await fetch('/upload/token', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
            if (!res.ok) {
              conn.toast(`upload failed: ${(await res.json()).error}`, false);
              return;
            }
            conn.action('token.set_art', { token_id: t.id, art: (await res.json()).art });
          };
          pad.append(artBtn, artFile);
          if (t.art) {
            const clearArt = el(`<button class="mini ghost" title="remove the image (back to a colored shape)">🚫</button>`);
            clearArt.onclick = (ev) => { ev.stopPropagation(); conn.action('token.set_art', { token_id: t.id, art: null }); };
            pad.appendChild(clearArt);
          }
        }
        pad.appendChild(del);
        row.appendChild(pad);
      }
      box.appendChild(row);
      if (selected && mapUI.recoloring === t.id) {
        const paintRow = el(`<div style="padding:4px 0 8px"></div>`);
        paintRow.onclick = (ev) => ev.stopPropagation();
        paintRow.appendChild(colorPicker(dotColor, (c) => conn.action('token.set_color', { token_id: t.id, color: c })));
        box.appendChild(paintRow);
      }
      if (selected && mapUI.resizing === t.id) {
        const sizeEdit = el(`<div class="btn-row" style="padding:4px 0 8px;align-items:center"></div>`);
        sizeEdit.onclick = (ev) => ev.stopPropagation();
        const shapeSel2 = el(`<select style="max-width:110px"><option value="circle">● round</option><option value="square">■ square</option></select>`);
        shapeSel2.value = t.shape;
        const w2 = el(`<input type="number" min="1" max="50" value="${t.w}" style="width:62px;text-align:center">`);
        const h2 = el(`<input type="number" min="1" max="50" value="${t.h}" style="width:62px;text-align:center">`);
        const apply = el(`<button class="mini primary">apply</button>`);
        apply.onclick = () => conn.action('token.set_size', {
          token_id: t.id, shape: shapeSel2.value,
          w: Math.max(1, Number(w2.value) || 1), h: Math.max(1, Number(h2.value) || 1),
        });
        sizeEdit.append(shapeSel2, el(`<span class="small">size:</span>`), w2, el(`<span class="small">×</span>`), h2, apply);
        box.appendChild(sizeEdit);
      }
    }
    if (snap.tokens.length === 0) box.appendChild(el(`<p class="muted small">No tokens yet — add one above, then select it and tap the minimap to place it.</p>`));
    return box;
  }

  // --- character cards ---------------------------------------------------------
  function charCard(c) {
    const dead = c.conditions.some((x) => x.kind === 'dead');
    const isTurn = snap.initiative.turn_id === `char:${c.id}`;
    const card = el(`<div class="card ${dead ? 'is-dead' : ''} ${isTurn ? 'turn-active' : ''}"></div>`);
    const face = c.token_art
      ? `<span style="display:inline-block;width:38px;height:38px;border-radius:50%;background-image:url('${c.token_art}');background-size:cover;background-position:center;border:2px solid var(--ember-deep);vertical-align:middle;margin-right:6px"></span>`
      : '';
    card.appendChild(el(`<div class="card-head"><h3 style="display:flex;align-items:center">${face}${esc(c.name)}</h3><span class="muted small">${esc(c.concept)}</span></div>`));
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

    // conditions / GM notes — freeform, per-entry visibility
    card.appendChild(conditionEditor(c.conditions, { char_id: c.id }));

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
