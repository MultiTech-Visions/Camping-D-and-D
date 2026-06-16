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
      updateCardViewer();  // the NPC reading view tracks live toggles even when render is skipped
      if (mapUI.draggingViewport) return queueRender(); // don't rebuild the minimap mid-drag
      const ae = document.activeElement;
      // Don't rebuild the screen out from under an open field/dropdown — that
      // would slam a <select> shut or wipe what's being typed. SELECT included
      // so the NPC shape/effect pickers stay usable.
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT') && ae.dataset.live !== '1') return queueRender();
      render();
    },
    onResult(msg) {
      // a fresh token starts selected: the very next minimap tap places it
      if (msg.op === 'token.create' && msg.created_token_id) {
        mapUI.selectedToken = msg.created_token_id;
        // "place on map" from the NPC library carries the creature's token art
        if (cardUI.placingArt) {
          conn.action('token.set_art', { token_id: msg.created_token_id, art: cardUI.placingArt });
          cardUI.placingArt = null;
        }
        render();
      }
      // a freshly-created NPC opens straight into its editor
      if (msg.op === 'card.create' && msg.created_card_id) {
        cardUI.editing = msg.created_card_id;
        render();
      }
    },
  });

  // While a field/dropdown is focused we defer the rebuild so we don't wipe what's
  // being typed; pendingSnap just flags that a render is owed. `snap` itself is
  // ALWAYS the latest (set in onSnapshot before the defer check), so on focusout we
  // render from `snap` — never roll back to the stashed snapshot, which may now be
  // older than one that already rendered (that rollback was eating fresh edits).
  let pendingSnap = null;
  function queueRender() { pendingSnap = true; }
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (pendingSnap) { pendingSnap = null; render(); }
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
    const oldSticky = document.getElementById('gm-sticky');
    if (oldSticky) oldSticky.remove();

    const suggestions = [...new Set([
      ...snap.used_conditions,
      ...snap.config.CONDITIONS.campfire,
      ...snap.config.CONDITIONS.dnd5e,
    ])];
    root.appendChild(el(`<datalist id="cond-suggestions">${suggestions.map((k) => `<option value="${esc(k)}">`).join('')}</datalist>`));

    const jumps = el(`<div class="section-jumps"></div>`);
    const jumpData = [
      ['initiative', '⚔', snap.initiative.entries.length],
      ['clocks', '🕗', snap.clocks.length],
      ['map', '🗺', snap.map ? 1 : 0],
      ['npc', '🐲', (snap.cards || []).filter((c) => c.kind === 'npc').length],
      ['location', '🌍', (snap.cards || []).filter((c) => c.kind === 'location').length],
      ['story', '📖', (snap.cards || []).filter((c) => c.kind === 'story').length],
      ['party', '👥', snap.characters.length],
      ['devices', '📱', (snap.devices || []).filter((d) => d.online).length],
      ['settings', '⚙', 0],
    ];
    for (const [key, icon, count] of jumpData) {
      const pill = el(`<button class="section-pill ${gmSections[key] ? 'active' : ''}">${icon}<span class="section-pill-count">${count || ''}</span></button>`);
      pill.onclick = () => {
        gmSections[key] = !gmSections[key];
        render();
        if (gmSections[key]) {
          const target = document.getElementById('gm-' + key);
          if (target) setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
        }
      };
      jumps.appendChild(pill);
    }
    root.appendChild(jumps);

    root.appendChild(initiativeBoard());
    root.appendChild(clocksManager());
    root.appendChild(mapManager());
    root.appendChild(cardSection('npc'));
    root.appendChild(cardSection('location'));
    root.appendChild(cardSection('story'));
    root.appendChild(partySection());
    root.appendChild(devicesSection());
    root.appendChild(settingsSection());

    if (snap.initiative.entries.length > 0) {
      const bar = el(`<div class="gm-sticky" id="gm-sticky"></div>`);
      const entries = snap.initiative.entries;
      const current = entries.find((e) => e.id === snap.initiative.turn_id);
      if (current) {
        const c = current.char_id !== null ? snap.characters.find((x) => x.id === current.char_id) : null;
        bar.appendChild(el(`<span class="gm-sticky-turn">▶ ${esc(c ? c.name : current.label)}</span>`));
      }
      const next = el(`<button class="primary">⏭ Next</button>`);
      next.onclick = () => {
        const idx = entries.findIndex((e) => e.id === snap.initiative.turn_id);
        conn.action('initiative.set_turn', { entry_id: entries[(idx + 1) % entries.length].id });
      };
      bar.appendChild(next);
      document.body.appendChild(bar);
    }
  }

  function partySection() {
    const box = el(`<div class="card" id="gm-party"></div>`);
    const toggle = el(`<div class="section-toggle">
      <span class="section-arrow" style="transform:rotate(${gmSections.party ? 90 : 0}deg)">▶</span>
      <h3 style="margin:0;flex:1">👥 The party</h3>
      <span class="muted small">${snap.characters.length} character${snap.characters.length !== 1 ? 's' : ''}</span>
    </div>`);
    toggle.onclick = () => { gmSections.party = !gmSections.party; render(); };
    box.appendChild(toggle);
    if (!gmSections.party) return box;
    const grid = el(`<div class="card-grid" style="margin-top:10px"></div>`);
    for (const c of snap.characters) grid.appendChild(charCard(c));
    if (snap.characters.length === 0) grid.appendChild(el(`<p class="muted">No characters yet — players join at the site address and forge heroes.</p>`));
    box.appendChild(grid);
    return box;
  }

  function devicesSection() {
    const box = el(`<div class="card" id="gm-devices"></div>`);
    const toggle = el(`<div class="section-toggle">
      <span class="section-arrow" style="transform:rotate(${gmSections.devices ? 90 : 0}deg)">▶</span>
      <h3 style="margin:0;flex:1">📱 Devices</h3>
    </div>`);
    toggle.onclick = () => { gmSections.devices = !gmSections.devices; render(); };
    box.appendChild(toggle);
    if (!gmSections.devices) return box;

    // Device metadata (name + online) from the server.
    const devices = snap.devices || [];
    const devInfo = new Map(devices.map((d) => [d.id, d]));
    const labelFor = (did) => {
      const d = devInfo.get(did);
      return (d && d.name) ? d.name : `unnamed · ${did.slice(0, 8)}`;
    };

    // Group characters by device_id
    const byDevice = new Map(); // device_id -> [char, ...]
    const unassigned = [];
    for (const c of snap.characters) {
      if (!c.device_id) { unassigned.push(c); continue; }
      if (!byDevice.has(c.device_id)) byDevice.set(c.device_id, []);
      byDevice.get(c.device_id).push(c);
    }
    // Include every known/connected device even if it has no characters yet.
    for (const d of devices) {
      if (!byDevice.has(d.id)) byDevice.set(d.id, []);
    }

    // All known device IDs (for the "link" dropdown)
    const allDeviceIds = [...byDevice.keys()];

    function charChip(c, deviceId) {
      const row = el(`<div class="attr-row" style="padding:3px 0"></div>`);
      row.appendChild(el(`<span style="flex:1">${esc(c.name)}</span>`));
      if (deviceId) {
        const unlink = el(`<button class="mini ghost danger">unlink</button>`);
        unlink.onclick = () => conn.action('character.set_device', { char_id: c.id, device_id: null });
        row.appendChild(unlink);
      } else {
        // Unassigned: show link dropdown labelled by device name
        const sel = el(`<select style="max-width:170px;font-size:0.8rem"></select>`);
        sel.appendChild(el(`<option value="">— assign to —</option>`));
        for (const did of allDeviceIds) {
          const online = devInfo.get(did) && devInfo.get(did).online;
          sel.appendChild(el(`<option value="${esc(did)}">${esc(labelFor(did))}${online ? ' 🟢' : ''}</option>`));
        }
        const link = el(`<button class="mini">link</button>`);
        link.onclick = () => {
          if (sel.value) conn.action('character.set_device', { char_id: c.id, device_id: sel.value });
        };
        row.append(sel, link);
      }
      const del = el(`<button class="mini ghost danger" title="delete character">🗑</button>`);
      del.onclick = () => {
        if (confirm(`Delete "${c.name}"? This removes the character permanently.`)) {
          conn.action('character.delete', { char_id: c.id });
        }
      };
      row.appendChild(del);
      return row;
    }

    if (byDevice.size === 0 && unassigned.length === 0) {
      box.appendChild(el(`<p class="muted small">No devices connected yet.</p>`));
      return box;
    }

    for (const [did, chars] of byDevice) {
      const d = devInfo.get(did) || {};
      const online = !!d.online;
      const panel = el(`<div style="margin:10px 0;padding:8px;border:1px solid var(--line);border-radius:8px"></div>`);
      const head = el(`<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px"></div>`);
      head.appendChild(el(`<span title="${esc(did)}">${online ? '🟢' : '⚫'}</span>`));
      const nameIn = el(`<input type="text" maxlength="60" value="${esc(d.name || '')}" placeholder="name this device (e.g. Sara's phone)" style="flex:1;font-size:0.85rem">`);
      const saveBtn = el(`<button class="mini">rename</button>`);
      saveBtn.onclick = () => conn.action('device.set_name', { device_id: did, name: nameIn.value.trim() });
      nameIn.onkeydown = (ev) => { if (ev.key === 'Enter') saveBtn.onclick(); };
      const delDev = el(`<button class="mini ghost danger" title="forget this device">🗑</button>`);
      delDev.onclick = () => {
        const n = chars.length;
        const warn = n > 0 ? ` Its ${n} character${n !== 1 ? 's' : ''} will become Unassigned (not deleted).` : '';
        if (confirm(`Forget device "${labelFor(did)}"?${warn}`)) {
          conn.action('device.delete', { device_id: did });
        }
      };
      head.append(nameIn, saveBtn, delDev);
      panel.appendChild(head);
      panel.appendChild(el(`<div class="muted small" style="margin:-2px 0 6px">${online ? 'online' : 'offline'} · ${did.slice(0, 8)}</div>`));
      if (chars.length === 0) {
        panel.appendChild(el(`<p class="muted small" style="margin:0">No characters linked.</p>`));
      }
      for (const c of chars) panel.appendChild(charChip(c, did));
      box.appendChild(panel);
    }

    if (unassigned.length > 0) {
      const panel = el(`<div style="margin:10px 0;padding:8px;border:1px dashed var(--line);border-radius:8px"></div>`);
      panel.appendChild(el(`<div class="muted small" style="margin-bottom:6px">📭 Unassigned characters</div>`));
      for (const c of unassigned) panel.appendChild(charChip(c, null));
      box.appendChild(panel);
    }

    box.appendChild(el(`<p class="muted small" style="margin-top:8px">Players name their own device on the character-pick screen; you can rename any device here.</p>`));
    return box;
  }

  // --- GM settings: global UX/feel knobs (persisted) -------------------------
  function settingsSection() {
    const box = el(`<div class="card" id="gm-settings"></div>`);
    const toggle = el(`<div class="section-toggle">
      <span class="section-arrow" style="transform:rotate(${gmSections.settings ? 90 : 0}deg)">▶</span>
      <h3 style="margin:0;flex:1">⚙ Settings</h3>
      <span class="muted small">fine-tune the feel</span>
    </div>`);
    toggle.onclick = () => { gmSections.settings = !gmSections.settings; render(); };
    box.appendChild(toggle);
    if (!gmSections.settings) return box;

    const s = Object.assign({ transition_image: '', transitions_enabled: true, transition_ms: 520, scroll_speed: 1, particles_enabled: true }, snap.settings || {});
    const set = (patch) => conn.action('settings.update', patch);

    // --- Projector screen transitions ---
    box.appendChild(el(`<h4 style="margin:12px 0 4px">🎬 Projector transitions</h4>`));
    box.appendChild(el(`<p class="muted small" style="margin:0 0 8px">A fullscreen splash plays on the projector when it swaps to a reveal — like a broadcast bumper. Set a different image per reveal kind; any kind without an image just does a soft direct fade instead.</p>`));

    const enRow = el(`<div class="btn-row" style="align-items:center"></div>`);
    const enBtn = el(`<button class="mini ${s.transitions_enabled ? 'primary' : 'ghost'}">${s.transitions_enabled ? '✓ Transitions on' : 'Transitions off'}</button>`);
    enBtn.onclick = () => set({ transitions_enabled: !s.transitions_enabled });
    enRow.appendChild(enBtn);
    box.appendChild(enRow);

    // transition duration slider (commit on release so we don't spam the server)
    const durRow = el(`<div class="btn-row" style="align-items:center;margin-top:8px"></div>`);
    durRow.appendChild(el(`<span class="small" style="min-width:130px">Splash duration: <strong>${(s.transition_ms / 1000).toFixed(2)}s</strong></span>`));
    const durIn = el(`<input type="range" min="200" max="2000" step="50" value="${s.transition_ms}" style="flex:1;min-width:120px">`);
    durIn.oninput = () => { durRow.querySelector('strong').textContent = `${(durIn.value / 1000).toFixed(2)}s`; };
    durIn.onchange = () => set({ transition_ms: Number(durIn.value) });
    durRow.appendChild(durIn);
    box.appendChild(durRow);

    // one fullscreen splash image per reveal kind
    const tImgs = s.transition_images || { npc: '', location: '', story: '' };
    const KIND_LABELS = { npc: '🐲 NPC', location: '🌍 Location', story: '📖 Story' };
    for (const kind of ['npc', 'location', 'story']) {
      const cur = tImgs[kind] || '';
      const row = el(`<div class="btn-row" style="align-items:center;margin-top:8px"></div>`);
      row.appendChild(el(`<span class="small" style="min-width:96px">${KIND_LABELS[kind]}</span>`));
      if (cur) row.appendChild(el(`<span class="npc-thumb" style="background-image:url('${cur}')"></span>`));
      const file = el(`<input type="file" accept="image/png,image/jpeg,image/webp" style="display:none">`);
      const btn = el(`<button class="mini">🖼 ${cur ? 'change' : 'add'}</button>`);
      btn.onclick = () => file.click();
      file.onchange = async () => {
        const f = file.files[0];
        if (!f) return;
        try {
          conn.toast('Uploading splash…', true);
          const art = await cardUploadImage(f);
          set({ transition_images: { [kind]: art } });
        } catch (err) { conn.toast(`upload failed: ${err.message}`, false); }
      };
      row.append(btn, file);
      if (cur) {
        const clr = el(`<button class="mini ghost" title="remove — this kind will use a soft fade instead">🚫</button>`);
        clr.onclick = () => set({ transition_images: { [kind]: '' } });
        row.appendChild(clr);
      }
      box.appendChild(row);
    }

    // --- Reveal text auto-scroll speed ---
    box.appendChild(el(`<h4 style="margin:16px 0 4px">📜 Reveal text scroll speed</h4>`));
    box.appendChild(el(`<p class="muted small" style="margin:0 0 8px">How fast long reveal text crawls up the projector.</p>`));
    const spdRow = el(`<div class="btn-row" style="align-items:center"></div>`);
    spdRow.appendChild(el(`<span class="small" style="min-width:90px">Speed: <strong>${s.scroll_speed.toFixed(2)}×</strong></span>`));
    const spdIn = el(`<input type="range" min="0.3" max="3" step="0.1" value="${s.scroll_speed}" style="flex:1;min-width:120px">`);
    spdIn.oninput = () => { spdRow.querySelector('strong').textContent = `${Number(spdIn.value).toFixed(2)}×`; };
    spdIn.onchange = () => set({ scroll_speed: Number(spdIn.value) });
    spdRow.appendChild(spdIn);
    box.appendChild(spdRow);

    // --- Particle effects ---
    box.appendChild(el(`<h4 style="margin:16px 0 4px">✨ Particle effects</h4>`));
    box.appendChild(el(`<p class="muted small" style="margin:0 0 8px">Global on/off for the reveal's embers / snow / rain etc. Turn off to lighten the load on a slower projector.</p>`));
    const partRow = el(`<div class="btn-row" style="align-items:center"></div>`);
    const partBtn = el(`<button class="mini ${s.particles_enabled ? 'primary' : 'ghost'}">${s.particles_enabled ? '✓ Particles on' : 'Particles off'}</button>`);
    partBtn.onclick = () => set({ particles_enabled: !s.particles_enabled });
    partRow.appendChild(partBtn);
    box.appendChild(partRow);

    // --- Mushroom lamp (BLE campfire on the projector stand) ---
    box.appendChild(el(`<h4 style="margin:16px 0 4px">🍄 Mushroom lamp</h4>`));
    box.appendChild(el(`<p class="muted small" style="margin:0 0 8px">The projector stand glows like a campfire — nice ambiance when there's no real fire going. Keep the Pi within ~1m of it.</p>`));
    const m = Object.assign({ on: false, status: 'off', detail: '' }, snap.mushroom || {});
    const mLabel = !m.on ? '🔥 Light the flame'
      : m.status === 'on' ? '✓ Flame burning — tap to stop'
      : m.status === 'error' ? '⚠ No light found — tap to stop'
      : '… lighting';
    const mRow = el(`<div class="btn-row" style="align-items:center"></div>`);
    const mBtn = el(`<button class="mini ${m.on ? 'primary' : 'ghost'}">${mLabel}</button>`);
    mBtn.onclick = () => conn.action('mushroom.set', { on: !m.on });
    mRow.appendChild(mBtn);
    if (m.on && m.status === 'error' && m.detail) {
      mRow.appendChild(el(`<span class="small" style="color:var(--ember)">${esc(m.detail)}</span>`));
    }
    box.appendChild(mRow);

    return box;
  }

  // --- initiative board: characters AND anything the GM types in -------------
  function initiativeBoard() {
    const box = el(`<div class="card" id="gm-initiative"></div>`);
    const entries = snap.initiative.entries;
    const currentEntry = entries.find((e) => e.id === snap.initiative.turn_id);
    const currentC = currentEntry && currentEntry.char_id !== null ? snap.characters.find((x) => x.id === currentEntry.char_id) : null;
    const turnName = currentEntry ? (currentC ? currentC.name : currentEntry.label) : '';
    const toggle = el(`<div class="section-toggle">
      <span class="section-arrow" style="transform:rotate(${gmSections.initiative ? 90 : 0}deg)">▶</span>
      <h3 style="margin:0;flex:1">⚔ Initiative</h3>
      <span class="muted small">${entries.length > 0 ? entries.length + (turnName ? ' · ▶ ' + esc(turnName) : '') : ''}</span>
    </div>`);
    toggle.onclick = () => { gmSections.initiative = !gmSections.initiative; render(); };
    box.appendChild(toggle);
    if (!gmSections.initiative) return box;

    if (entries.length === 0) {
      box.appendChild(el(`<p class="muted small">Empty — add party members or type in monsters, hazards, lair actions…</p>`));
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const c = e.char_id === null ? null : snap.characters.find((x) => x.id === e.char_id);
      const name = c ? c.name : e.label;
      // characters show their portrait (no emoji clutter); custom entries show
      // their own portrait when they carry one (NPC/token-derived), else 👹
      const faceArt = c ? c.token_art : e.art;
      const face = faceArt
        ? `<span style="display:inline-block;width:30px;height:30px;border-radius:50%;background-image:url('${faceArt}');background-size:cover;background-position:center;border:2px solid var(--ember-deep);vertical-align:middle;margin-right:6px"></span>`
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
        const ren = el(`<button class="mini ghost" title="rename this entry">✎</button>`);
        ren.onclick = () => {
          const name = prompt('Rename initiative entry:', e.label);
          if (name && name.trim()) conn.action('initiative.set_label', { entry_id: e.id, label: name.trim() });
        };
        const flag = el(`<button class="mini ${condOpenEntry === e.id ? 'primary' : 'ghost'}" title="conditions / notes on this entry">⚑</button>`);
        flag.onclick = () => { condOpenEntry = condOpenEntry === e.id ? null : e.id; render(); };
        ctl.append(up, down, turn, ren, flag, eye, out);
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
    const box = el(`<div class="card" id="gm-clocks"></div>`);
    const toggle = el(`<div class="section-toggle">
      <span class="section-arrow" style="transform:rotate(${gmSections.clocks ? 90 : 0}deg)">▶</span>
      <h3 style="margin:0;flex:1">🕗 Clocks</h3>
      <span class="muted small">${snap.clocks.length > 0 ? snap.clocks.length + ' clock' + (snap.clocks.length !== 1 ? 's' : '') : ''}</span>
    </div>`);
    toggle.onclick = () => { gmSections.clocks = !gmSections.clocks; render(); };
    box.appendChild(toggle);
    if (!gmSections.clocks) return box;

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

    const form = el(`<div class="form-stack"></div>`);
    const nameRow = el(`<div class="btn-row" style="margin:4px 0"></div>`);
    const label = el(`<input type="text" placeholder="Collapse the bridge" style="flex:1;min-width:0" maxlength="60">`);
    const add = el(`<button class="mini primary">+ clock</button>`);
    nameRow.append(label, add);
    const optRow = el(`<div class="btn-row" style="margin:4px 0"></div>`);
    const segs = el(`<select style="max-width:80px">${snap.config.CLOCK_SEGMENT_CHOICES.map((n) => `<option ${n === 6 ? 'selected' : ''}>${n}</option>`).join('')}</select>`);
    const kind = el(`<select style="max-width:120px"><option value="progress">progress</option><option value="danger">danger</option></select>`);
    const vis = el(`<select style="max-width:110px"><option value="visible">visible</option><option value="dm_only">secret</option></select>`);
    add.onclick = () => {
      conn.action('clock.create', { label: label.value.trim(), segments: Number(segs.value), kind: kind.value, visibility: vis.value });
      label.value = '';
    };
    optRow.append(segs, kind, vis);
    form.append(nameRow, optRow);
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
    cameraLocked: false,     // 🔒 freeze the view against accidental taps
    recoloring: null,        // token id whose color picker is open
    resizing: null,          // token id whose size editor is open
    newLabel: '',            // create-form state that must survive re-renders
    newKind: 'monster',
    newColor: '#c43c34',
    newShape: 'circle',
    newW: 1,
    newH: 1,
  };

  // Which GM categories are expanded — persisted to localStorage so the screen
  // comes back the way you left it after a refresh. The Proxy saves on any change.
  const SECTION_DEFAULTS = { initiative: true, clocks: true, map: true, npc: false, location: false, story: false, party: true, devices: false, settings: false };
  let savedSections = {};
  try { savedSections = JSON.parse(localStorage.getItem('campfire_gm_sections') || '{}'); } catch (e) { savedSections = {}; }
  const gmSections = new Proxy({ ...SECTION_DEFAULTS, ...savedSections }, {
    set(target, key, val) {
      target[key] = val;
      try { localStorage.setItem('campfire_gm_sections', JSON.stringify(target)); } catch (e) { /* private mode */ }
      return true;
    },
  });

  // Reveal-card library UI state that must survive re-renders.
  // collapsedSecs (which sections are folded) + initedCards (cards we've already
  // opened the editor on) persist to localStorage so the GM picks up exactly
  // where they left off — and a freshly-opened card starts all-collapsed.
  const COLLAPSE_KEY = 'campfire_gm_card_collapse';
  function loadCollapse() {
    try {
      const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}');
      return { collapsedSecs: new Set(raw.collapsed || []), initedCards: new Set(raw.inited || []) };
    } catch (e) { return { collapsedSecs: new Set(), initedCards: new Set() }; }
  }
  function saveCollapse() {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify({ collapsed: [...cardUI.collapsedSecs], inited: [...cardUI.initedCards] })); } catch (e) { /* private mode */ }
  }
  const _collapse = loadCollapse();
  const cardUI = { editing: null, placingArt: null, collapsedSecs: _collapse.collapsedSecs, initedCards: _collapse.initedCards };

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
    const box = el(`<div class="card" id="gm-map"></div>`);
    const mapName = snap.map ? snap.map.name : '';
    const toggle = el(`<div class="section-toggle">
      <span class="section-arrow" style="transform:rotate(${gmSections.map ? 90 : 0}deg)">▶</span>
      <h3 style="margin:0;flex:1">🗺 Battle map</h3>
      <span class="muted small">${mapName ? esc(mapName) : ''}</span>
    </div>`);
    toggle.onclick = () => { gmSections.map = !gmSections.map; render(); };
    box.appendChild(toggle);
    if (!gmSections.map) return box;

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
      if (mapUI.cameraLocked) {
        conn.toast('🔒 camera is locked — unlock to move the view', false);
        return;
      }
      conn.action('camera.update', {
        center_x: Math.min(Math.max(next.center_x, 0), map.image_w),
        center_y: Math.min(Math.max(next.center_y, 0), map.image_h),
        zoom: Math.min(Math.max(next.zoom, 0.05), 20),
        rotation_deg: next.rotation_deg,
      });
    };

    // minimap: tap anywhere to point the camera there; shows every token so
    // the GM sees the whole board at a glance (the full render is /display)
    const mini = el(`<div class="cam-minimap"></div>`);
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
      mini.appendChild(vpBox);
    }

    // Minimap gestures (token placement lives in the 🕹 mover now):
    //   tap → jump the camera there · drag → pan · pinch → zoom the projector
    //   🔒 freezes the view against accidental taps — and, while locked, releases
    //   touch so the page scrolls normally even when the map fills the screen
    mini.style.touchAction = mapUI.cameraLocked ? 'auto' : 'none';
    let grabDX = 0, grabDY = 0, lastLiveSend = 0;
    let dragX = cam.center_x, dragY = cam.center_y;
    let gestureMode = null; // 'camera' | 'tap' | 'pinch'
    let downClient = null;
    const pinchPointers = new Map();
    let pinchStart = null, pinchZoom = cam.zoom;
    const toImage = (ev) => {
      const r = miniImg.getBoundingClientRect();
      return {
        x: Math.min(Math.max(((ev.clientX - r.left) / r.width) * map.image_w, 0), map.image_w),
        y: Math.min(Math.max(((ev.clientY - r.top) / r.height) * map.image_h, 0), map.image_h),
      };
    };
    const placeBox = (x, y) => {
      if (!vpBox) return;
      vpBox.style.left = `${(x / map.image_w) * 100}%`;
      vpBox.style.top = `${(y / map.image_h) * 100}%`;
    };
    mini.onpointerdown = (ev) => {
      // locked: don't capture or preventDefault, so the touch scrolls the page
      if (mapUI.cameraLocked) return;
      ev.preventDefault();
      pinchPointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      mini.setPointerCapture(ev.pointerId);
      if (pinchPointers.size === 2) {
        // second finger: whatever was happening becomes a zoom gesture
        const [a, b] = [...pinchPointers.values()];
        pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: cam.zoom };
        pinchZoom = cam.zoom;
        gestureMode = 'pinch';
        mapUI.draggingViewport = true; // reuse the mid-gesture render suppression
        return;
      }
      const p = toImage(ev);
      downClient = { x: ev.clientX, y: ev.clientY };
      const halfW = vp ? vp.width / cam.zoom / 2 : map.image_w * 0.04;
      const halfH = vp ? vp.height / cam.zoom / 2 : map.image_h * 0.04;
      if (Math.abs(p.x - dragX) <= halfW && Math.abs(p.y - dragY) <= halfH) {
        gestureMode = 'camera'; // grabbed the box — keep the grip point
        grabDX = dragX - p.x;
        grabDY = dragY - p.y;
        mapUI.draggingViewport = true;
      } else {
        gestureMode = 'tap';
        grabDX = 0;
        grabDY = 0;
      }
    };
    mini.onpointermove = (ev) => {
      if (pinchPointers.has(ev.pointerId)) {
        pinchPointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      }
      if (gestureMode === 'pinch') {
        if (pinchPointers.size === 2 && pinchStart) {
          const [a, b] = [...pinchPointers.values()];
          pinchZoom = Math.min(20, Math.max(0.05,
            pinchStart.zoom * (pinchStart.dist / Math.hypot(a.x - b.x, a.y - b.y))));
          if (vp) { // live-resize the projection box under the fingers
            vpBox.style.width = `${(vp.width / pinchZoom / map.image_w) * 100}%`;
            vpBox.style.height = `${(vp.height / pinchZoom / map.image_h) * 100}%`;
          }
          const now = Date.now();
          if (now - lastLiveSend > 120) { // projector follows the pinch live
            lastLiveSend = now;
            send({ ...cam, center_x: dragX, center_y: dragY, zoom: pinchZoom });
          }
        }
        return;
      }
      if (gestureMode === 'tap'
          && Math.hypot(ev.clientX - downClient.x, ev.clientY - downClient.y) > 10) {
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
    const liftPointer = (ev) => {
      pinchPointers.delete(ev.pointerId);
      if (gestureMode === 'pinch') {
        if (pinchPointers.size < 2) {
          gestureMode = null;
          pinchStart = null;
          mapUI.draggingViewport = false;
          snap.camera.zoom = pinchZoom; // optimistic
          send({ ...cam, center_x: dragX, center_y: dragY, zoom: pinchZoom });
        }
        return true;
      }
      return false;
    };
    mini.onpointerup = (ev) => {
      if (liftPointer(ev)) return;
      if (gestureMode === 'camera') {
        endDrag();
      } else if (gestureMode === 'tap') {
        const p = toImage(ev);
        dragX = p.x;
        dragY = p.y;
        snap.camera.center_x = p.x;
        snap.camera.center_y = p.y;
        send({ ...cam, center_x: p.x, center_y: p.y });
      }
      gestureMode = null;
    };
    mini.onpointercancel = (ev) => {
      if (liftPointer(ev)) return;
      if (gestureMode === 'camera') endDrag();
      gestureMode = null;
    };
    if (mapUI.cameraLocked) {
      mini.style.cursor = 'default';
      mini.appendChild(el(`<div style="position:absolute;top:6px;left:6px;z-index:3;font-size:1.2rem;text-shadow:0 1px 3px #000">🔒</div>`));
    }
    box.appendChild(mini);
    box.appendChild(el(`<p class="muted small" style="margin:4px 0">Tap = aim camera · drag = pan · pinch = zoom · move tokens with 🕹 in the list below.
      Dots = tokens · orange frame = what the <a href="/display" target="_blank">projector</a> shows.</p>`));

    const pan = map.cell_size * 2;
    const mk = (txt, fn, title) => {
      const b = el(`<button class="mini" title="${title}">${txt}</button>`);
      b.disabled = mapUI.cameraLocked;
      b.onclick = fn;
      return b;
    };
    const nudge = (sx, sy) => {
      const th = (cam.rotation_deg * Math.PI) / 180;
      send({
        ...cam,
        center_x: cam.center_x + (sx * Math.cos(th) + sy * Math.sin(th)) * pan,
        center_y: cam.center_y + (-sx * Math.sin(th) + sy * Math.cos(th)) * pan,
      });
    };

    const camCtl = el(`<div class="cam-controls"></div>`);
    const lock = el(`<button class="mini ${mapUI.cameraLocked ? 'primary' : 'ghost'}" title="${mapUI.cameraLocked ? 'unlock the camera' : 'lock — prevents stray taps'}">${mapUI.cameraLocked ? '🔒' : '🔓'}</button>`);
    lock.onclick = () => { mapUI.cameraLocked = !mapUI.cameraLocked; render(); };

    const camPad = el(`<div class="cam-pad"></div>`);
    camPad.append(
      el(`<span></span>`),
      mk('▲', () => nudge(0, -1), 'nudge up'),
      el(`<span></span>`),
      mk('◀', () => nudge(-1, 0), 'nudge left'),
      mk('🎯', () => send({ center_x: map.image_w / 2, center_y: map.image_h / 2, zoom: 1, rotation_deg: 0 }), 'reset view'),
      mk('▶', () => nudge(1, 0), 'nudge right'),
      el(`<span></span>`),
      mk('▼', () => nudge(0, 1), 'nudge down'),
      el(`<span></span>`),
    );

    const sideCol = el(`<div class="cam-side"></div>`);
    const zoomRow = el(`<div class="btn-row" style="margin:0;justify-content:center"></div>`);
    zoomRow.append(
      mk('+🔎', () => send({ ...cam, zoom: cam.zoom * 1.3 }), 'zoom in'),
      mk('−🔎', () => send({ ...cam, zoom: cam.zoom / 1.3 }), 'zoom out'),
    );
    const rotRow = el(`<div class="btn-row" style="margin:0;justify-content:center"></div>`);
    rotRow.append(
      mk('⟲', () => send({ ...cam, rotation_deg: cam.rotation_deg - 15 }), 'rotate left'),
      mk('⟳', () => send({ ...cam, rotation_deg: cam.rotation_deg + 15 }), 'rotate right'),
    );
    sideCol.append(zoomRow, rotRow);
    sideCol.appendChild(el(`<span class="muted small" style="text-align:center">${Math.round(cam.zoom * 100)}%${cam.rotation_deg ? ' · ' + cam.rotation_deg + '°' : ''}</span>`));

    const gridBtn = el(`<button class="mini ${map.grid_visible ? '' : 'ghost'}" title="overlay the calibrated grid on the projector">▦ grid ${map.grid_visible ? 'on' : 'off'}</button>`);
    gridBtn.onclick = () => conn.action('map.set_grid_visible', { map_id: map.id, visible: !map.grid_visible });

    camCtl.append(lock, camPad, sideCol, gridBtn);
    box.appendChild(camCtl);

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
        go.disabled = mapUI.cameraLocked;
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
    CampfireScrollLock.lock();
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
    CampfireScrollLock.unlock();
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
          const w = e.w || 1, h = e.h || 1;
          const at = atCamera();
          const col = Math.min(at.col, Math.max(0, dims.cols - w));
          const row = Math.min(at.row, Math.max(0, dims.rows - h));
          cardUI.placingArt = e.art || null; // carry the entry's portrait onto the token
          conn.action('token.create', {
            kind: 'monster', label: e.label, col, row,
            shape: e.shape || 'circle', w, h,
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
              else conn.action('initiative.add_custom', { label: t.label, art: t.art || '', w: t.w, h: t.h, shape: t.shape });
            };
            pad.appendChild(init);
          }
        }
        if (t.kind !== 'glow') {
          const artFile = el(`<input type="file" accept="image/png,image/jpeg,image/webp" style="display:none">`);
          const artBtn = el(`<button class="mini ghost" title="${t.art ? 'replace token image' : 'use an image for this token'}">🖼</button>`);
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
    if (snap.tokens.length === 0) box.appendChild(el(`<p class="muted small">No tokens yet — add one above, then open 🕹 to place it.</p>`));
    return box;
  }

  // =========================================================================
  // Reveal cards: NPCs, locations, and story beats share one prep mechanism —
  // images + toggleable text sections the GM reveals full-screen on the
  // projector + players. Per-kind config tweaks the labels and a few features.
  // =========================================================================
  const CARD_CFG = {
    npc: {
      icon: '🐲', title: 'Monsters & NPCs', sectionId: 'gm-npc', createLabel: 'NPC',
      namePh: 'Ogre King', subtitlePh: 'subtitle (e.g. Tyrant of the Crags)',
      sectionWord: 'section', entryWord: 'entry', sectionPh: 'section title (e.g. Lore, Tactics, Loot)',
      empty: 'No NPCs yet — create an Ogre King, a villain, a quest-giver… give it a token and notes, and it’s here for every session.',
      thumbEmoji: '👹', tokenSize: true, placeOnMap: true, addToInit: true, visited: false, seen: true, done: false,
    },
    location: {
      icon: '🌍', title: 'Locations', sectionId: 'gm-location', createLabel: 'location',
      namePh: 'The Sunken Keep', subtitlePh: 'subtitle (e.g. Drowned ruin on the moor)',
      sectionWord: 'section', entryWord: 'detail', sectionPh: 'section title (e.g. Description, Points of interest, Secrets)',
      empty: 'No locations yet — build a tavern, a dungeon, a haunted wood… add images and details to reveal on the screen.',
      thumbEmoji: '📍', tokenSize: false, placeOnMap: false, addToInit: false, visited: true, seen: false, done: false,
    },
    story: {
      icon: '📖', title: 'Story', sectionId: 'gm-story', createLabel: 'story arc',
      namePh: 'The Gathering Storm', subtitlePh: 'subtitle (e.g. Act I)',
      sectionWord: 'chapter', entryWord: 'scene', sectionPh: 'chapter title (e.g. Chapter 1 — The Road)',
      empty: 'No story yet — add a chapter, then scenes inside it. Mark scenes done as you play to track where you are.',
      thumbEmoji: '📖', tokenSize: false, placeOnMap: false, addToInit: false, visited: false, seen: false, done: true,
    },
  };

  async function cardUploadImage(file) {
    const res = await fetch('/upload/token', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
    if (!res.ok) throw new Error((await res.json()).error);
    return (await res.json()).art;
  }

  // Full-screen single-field text editor (free-text notes / entry bodies). Saves
  // on Done if the text changed. Mirrors the players' note editor.
  function openCardTextEditor(title, value, onSave) {
    const overlay = el(`<div class="note-editor"></div>`);
    const bar = el(`<div class="note-editor-bar"></div>`);
    bar.appendChild(el(`<span class="note-editor-title">${esc(title)}</span>`));
    const done = el(`<button class="primary">Done</button>`);
    bar.appendChild(done);
    const ta = el(`<textarea class="note-editor-area" placeholder="Type away — this is all free text…"></textarea>`);
    ta.value = value || '';
    overlay.append(bar, ta);
    CampfireScrollLock.lock();
    document.body.appendChild(overlay);
    ta.focus();
    done.onclick = () => {
      if (ta.value !== (value || '')) onSave(ta.value);
      overlay.remove();
      CampfireScrollLock.unlock();
    };
  }

  // Compact centered popup for a single short field (a chapter/section name),
  // with explicit Cancel / Save. Backdrop tap or Esc cancels; Enter saves.
  function openTitlePopup(label, current, onSave) {
    const overlay = el(`<div style="position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:20px"></div>`);
    const box = el(`<div style="background:var(--bg-card);border:1px solid var(--line);border-radius:12px;padding:16px;width:100%;max-width:460px;box-shadow:0 12px 44px rgba(0,0,0,.55)"></div>`);
    box.appendChild(el(`<label style="display:block;margin-bottom:6px">${esc(label)}</label>`));
    const input = el(`<input type="text" maxlength="80" style="width:100%">`);
    input.value = current || '';
    box.appendChild(input);
    const row = el(`<div class="btn-row" style="margin-top:12px;justify-content:flex-end"></div>`);
    const cancel = el(`<button class="ghost">Cancel</button>`);
    const save = el(`<button class="primary">Save</button>`);
    row.append(cancel, save);
    box.appendChild(row);
    overlay.appendChild(box);
    CampfireScrollLock.lock();
    document.body.appendChild(overlay);
    input.focus();
    input.select();
    const close = () => { overlay.remove(); CampfireScrollLock.unlock(); };
    const commit = () => { const v = input.value.trim(); close(); onSave(v); };
    cancel.onclick = close;
    save.onclick = commit;
    overlay.onclick = (ev) => { if (ev.target === overlay) close(); };
    input.onkeydown = (ev) => { if (ev.key === 'Enter') commit(); else if (ev.key === 'Escape') close(); };
  }

  function thumbStyle(path) { return path ? `background-image:url('${path}')` : ''; }

  // The reveal slideshow as the projector composes it: the card's own images,
  // then the images of every REVEALED chapter/scene in reading order. Mirrors
  // publicRevealedCard() on the server so the GM viewer shows the same panels.
  function composeRevealImages(card) {
    const imgs = [];
    if (card.images_slides !== false) imgs.push(...(card.images || []));
    for (const s of card.sections || []) {
      if (s.visible === false) continue;
      const vis = (s.entries || []).filter((e) => e.visible);
      if (vis.length === 0) continue;
      if (s.slides !== false && Array.isArray(s.images)) imgs.push(...s.images);
      for (const e of vis) if (e.slides !== false && Array.isArray(e.images)) imgs.push(...e.images);
    }
    return imgs;
  }

  // Where a chapter's (entryIdx === null) or scene's images START in the composed
  // slideshow — assuming that target is included — so we can jump the projector
  // straight to them on reveal. -1 if it isn't eligible (hidden / no images).
  function composedJumpIndex(card, si, ei) {
    let idx = (card.images_slides !== false) ? (card.images || []).length : 0;
    for (let s = 0; s < (card.sections || []).length; s++) {
      const sec = card.sections[s];
      if (sec.visible === false) { if (s === si) return -1; continue; }
      const hasVis = (sec.entries || []).some((e) => e.visible);
      if (!hasVis) { if (s === si) return -1; continue; }
      const secOn = (s === si && ei === null) ? true : (sec.slides !== false);
      if (Array.isArray(sec.images) && sec.images.length && secOn) {
        if (s === si && ei === null) return idx;
        idx += sec.images.length;
      } else if (s === si && ei === null) { return -1; }
      for (let e = 0; e < sec.entries.length; e++) {
        const en = sec.entries[e];
        if (!en.visible) continue;
        const enOn = (s === si && e === ei) ? true : (en.slides !== false);
        if (Array.isArray(en.images) && en.images.length && enOn) {
          if (s === si && e === ei) return idx;
          idx += en.images.length;
        } else if (s === si && e === ei) { return -1; }
      }
    }
    return -1;
  }

  // Reusable popup to manage an image list (card / chapter / scene): upload,
  // reorder, remove. Edits a local copy and commits on Save. Backdrop/Cancel
  // discards (uploaded files just stay on disk, same as elsewhere).
  function openImageManager(title, images, onSave) {
    let local = [...(images || [])];
    const overlay = el(`<div style="position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:20px"></div>`);
    const box = el(`<div style="background:var(--bg-card);border:1px solid var(--line);border-radius:12px;padding:16px;width:100%;max-width:520px;max-height:85vh;overflow:auto;box-shadow:0 12px 44px rgba(0,0,0,.55)"></div>`);
    box.appendChild(el(`<label style="display:block;margin-bottom:8px">${esc(title)}</label>`));
    const strip = el(`<div class="npc-img-strip"></div>`);
    box.appendChild(strip);
    const paint = () => {
      strip.innerHTML = '';
      local.forEach((path, idx) => {
        const chip = el(`<div class="npc-img-chip"></div>`);
        chip.appendChild(el(`<span class="npc-thumb" style="${thumbStyle(path)}"></span>`));
        const ctl = el(`<div class="btn-row" style="margin:2px 0;justify-content:center;gap:2px"></div>`);
        const left = el(`<button class="mini ghost" title="move earlier">◀</button>`); left.disabled = idx === 0;
        left.onclick = () => { [local[idx - 1], local[idx]] = [local[idx], local[idx - 1]]; paint(); };
        const right = el(`<button class="mini ghost" title="move later">▶</button>`); right.disabled = idx === local.length - 1;
        right.onclick = () => { [local[idx + 1], local[idx]] = [local[idx], local[idx + 1]]; paint(); };
        const rm = el(`<button class="mini danger ghost" title="remove">✕</button>`);
        rm.onclick = () => { local.splice(idx, 1); paint(); };
        ctl.append(left, right, rm);
        const w = el(`<div style="text-align:center"></div>`); w.append(chip, ctl); strip.appendChild(w);
      });
      const addWrap = el(`<div style="text-align:center"></div>`);
      const file = el(`<input type="file" accept="image/png,image/jpeg,image/webp" style="display:none">`);
      const addBtn = el(`<button class="mini" title="add an image">＋ image</button>`);
      addBtn.onclick = () => file.click();
      file.onchange = async () => {
        const f = file.files[0];
        if (!f) return;
        try { conn.toast('Uploading image…', true); const art = await cardUploadImage(f); local.push(art); paint(); }
        catch (err) { conn.toast(`upload failed: ${err.message}`, false); }
      };
      addWrap.append(addBtn, file);
      strip.appendChild(addWrap);
    };
    paint();
    const row = el(`<div class="btn-row" style="margin-top:12px;justify-content:flex-end"></div>`);
    const cancel = el(`<button class="ghost">Cancel</button>`);
    const save = el(`<button class="primary">Save</button>`);
    row.append(cancel, save);
    box.appendChild(row);
    overlay.appendChild(box);
    CampfireScrollLock.lock();
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); CampfireScrollLock.unlock(); };
    cancel.onclick = close;
    save.onclick = () => { close(); onSave(local); };
    overlay.onclick = (ev) => { if (ev.target === overlay) close(); };
  }

  function cardSection(kind) {
    const cfg = CARD_CFG[kind];
    const cards = (snap.cards || []).filter((c) => c.kind === kind);
    const open = gmSections[kind];
    // is one of THIS kind's cards currently on the projector?
    const liveCard = snap.revealed_card_id ? cards.find((c) => c.id === snap.revealed_card_id) : null;
    const liveBadge = liveCard ? ` <span class="live-badge" title="broadcasting to the projector now: ${esc(liveCard.name)}">● LIVE</span>` : '';
    const box = el(`<div class="card" id="${cfg.sectionId}"></div>`);
    const toggle = el(`<div class="section-toggle">
      <span class="section-arrow" style="transform:rotate(${open ? 90 : 0}deg)">▶</span>
      <h3 style="margin:0;flex:1">${cfg.icon} ${esc(cfg.title)}${liveBadge}</h3>
      <span class="muted small">${cards.length > 0 ? cards.length + ' saved' : ''}</span>
    </div>`);
    toggle.onclick = () => { gmSections[kind] = !gmSections[kind]; render(); };
    box.appendChild(toggle);
    if (!open) return box;

    // now-showing banner — one reveal at a time, so only the owning section shows it
    if (snap.revealed_card_id && cards.some((c) => c.id === snap.revealed_card_id)) {
      const showing = cards.find((c) => c.id === snap.revealed_card_id);
      const banner = el(`<div class="banner" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="flex:1">📽 Now showing on the projector &amp; players: <strong>${esc(showing.name)}</strong></span></div>`);
      const stop = el(`<button class="mini">⏹ Stop showing</button>`);
      stop.onclick = () => conn.action('card.reveal', { card_id: null });
      banner.appendChild(stop);
      box.appendChild(banner);
    }

    if (cards.length === 0) box.appendChild(el(`<p class="muted small">${esc(cfg.empty)}</p>`));

    for (const c of cards) {
      const editing = cardUI.editing === c.id;
      const isShowing = snap.revealed_card_id === c.id;
      const row = el(`<div class="attr-row" style="align-items:center"></div>`);
      row.appendChild(el(`<span class="npc-thumb ${c.images[0] ? '' : 'placeholder'}" style="${thumbStyle(c.images[0])}">${c.images[0] ? '' : cfg.thumbEmoji}</span>`));
      let badge = '';
      if (cfg.done) {
        const all = c.sections.reduce((a, s) => a + s.entries.length, 0);
        const doneN = c.sections.reduce((a, s) => a + s.entries.filter((e) => e.done).length, 0);
        if (all > 0) badge = ` <span class="muted small">· ${doneN}/${all} scenes done</span>`;
      } else if (cfg.visited && c.visited) {
        badge = ` <span class="small" style="color:var(--ok)">· ✓ visited</span>`;
      } else if (cfg.seen && c.seen) {
        badge = ` <span class="small" style="color:var(--ok)">· ✓ seen</span>`;
      }
      row.appendChild(el(`<span class="attr-name" style="width:auto;flex:1;margin-left:8px">${esc(c.name)}${c.subtitle ? ` <span class="muted small">— ${esc(c.subtitle)}</span>` : ''}${badge}</span>`));
      const ctl = el(`<span class="btn-row" style="margin:0"></span>`);
      if (cfg.addToInit) {
        // add to the initiative order (a custom entry by name); tap again for a
        // second copy when a scene has more than one of the same creature
        const inInit = snap.initiative.entries.some((e) => e.char_id === null && e.label.toLowerCase() === c.name.toLowerCase());
        const init = el(`<button class="mini ${inInit ? 'ghost' : ''}" title="${inInit ? 'already in initiative — tap to add another copy' : 'add to the initiative order'}">⚔${inInit ? ' +1' : ''}</button>`);
        init.onclick = () => { conn.action('initiative.add_custom', { label: c.name, art: c.images[0] || '', w: c.token_w, h: c.token_h, shape: c.token_shape }); conn.toast(`${c.name} added to initiative ⚔`, true); };
        ctl.appendChild(init);
      }
      const view = el(`<button class="mini ghost" title="open the GM reading view — all details, with quick show/hide">📖</button>`);
      view.onclick = () => openCardViewer(c.id);
      const reveal = el(`<button class="mini ${isShowing ? 'primary' : ''}" title="show full-screen on the projector + players">${isShowing ? '⏹ Stop' : '📽 Show'}</button>`);
      reveal.onclick = () => conn.action('card.reveal', { card_id: isShowing ? null : c.id });
      const edit = el(`<button class="mini ${editing ? 'primary' : 'ghost'}" title="edit">✎</button>`);
      edit.onclick = () => {
        if (editing) { cardUI.editing = null; render(); return; }
        cardUI.editing = c.id;
        // first time opening this card's editor: fold every section so a big
        // card (8+ sections) isn't a wall of scrolling. After that we honor
        // whatever the GM last left open.
        if (!cardUI.initedCards.has(c.id)) {
          c.sections.forEach((_, si) => cardUI.collapsedSecs.add(`${c.id}:${si}`));
          cardUI.initedCards.add(c.id);
          saveCollapse();
        }
        render();
      };
      const del = el(`<button class="mini danger ghost" title="delete">🗑</button>`);
      del.onclick = () => { if (confirm(`Delete "${c.name}"? This removes it for good.`)) conn.action('card.delete', { card_id: c.id }); };
      ctl.append(view, reveal, edit, del);
      row.appendChild(ctl);
      box.appendChild(row);
      if (editing) box.appendChild(cardEditor(c));
    }

    const add = el(`<div class="btn-row" style="margin-top:8px"></div>`);
    const nameIn = el(`<input type="text" placeholder="${esc(cfg.namePh)}" maxlength="60" style="max-width:240px">`);
    const addBtn = el(`<button class="mini primary">+ new ${esc(cfg.createLabel)}</button>`);
    const doAdd = () => {
      if (!nameIn.value.trim()) return;
      conn.action('card.create', { kind, name: nameIn.value.trim() });
      nameIn.value = '';
    };
    addBtn.onclick = doAdd;
    nameIn.onkeydown = (ev) => { if (ev.key === 'Enter') doAdd(); };
    add.append(nameIn, addBtn);
    box.appendChild(add);
    return box;
  }

  // The inline editor for one card. Everything commits live (no Save button), so
  // visibility/done toggles reflect instantly — the rest of the GM screen works
  // the same way. cfg (per kind) gates the token-size, place-on-map, visited and
  // done features and relabels "section/entry" as "chapter/scene" for story.
  function cardEditor(c) {
    const cfg = CARD_CFG[c.kind];
    const secEls = []; // per-section live state { titleRef, entryEls:[labelIn], collapsed }
    // Build the next sections array from the LIVE inputs (title held in titleRef,
    // scene labels from the DOM) merged with the model (text/visible/done) — so
    // clicking a button never discards text you typed but haven't committed yet.
    // A collapsed section isn't editable, so its scenes come straight from the model.
    const readSections = () => secEls.map((se, si) => {
      const ms = c.sections[si] || { entries: [] };
      const secImages = ms.images || [];
      if (se.collapsed) {
        return { title: se.titleRef.value, images: secImages, visible: ms.visible !== false, slides: ms.slides !== false, entries: ms.entries.map((e) => ({ label: e.label, text: e.text, visible: e.visible !== false, done: !!e.done, images: e.images || [], slides: e.slides !== false })) };
      }
      return {
        title: se.titleRef.value,
        images: secImages,
        visible: ms.visible !== false,
        slides: ms.slides !== false,
        entries: se.entryEls.map((labelIn, ei) => {
          const m = ms.entries[ei] || {};
          return { label: labelIn.value, text: m.text || '', visible: m.visible !== false, done: !!m.done, images: m.images || [], slides: m.slides !== false };
        }),
      };
    });
    const commitSections = (next) => conn.action('card.update', { card_id: c.id, sections: next });
    const upd = (patch) => conn.action('card.update', { card_id: c.id, ...patch });
    const box = el(`<div class="npc-edit-block"></div>`);

    // name + subtitle
    const idRow = el(`<div class="btn-row"></div>`);
    const nameIn = el(`<input type="text" maxlength="60" placeholder="name" style="flex:1;min-width:120px">`);
    nameIn.value = c.name;
    nameIn.onchange = () => { if (nameIn.value.trim()) upd({ name: nameIn.value.trim() }); };
    idRow.append(el(`<span class="small" style="align-self:center">name</span>`), nameIn);
    box.appendChild(idRow);
    const subRow = el(`<div class="btn-row"></div>`);
    const subIn = el(`<input type="text" maxlength="120" placeholder="${esc(cfg.subtitlePh)}" style="flex:1;min-width:120px">`);
    subIn.value = c.subtitle;
    subIn.onchange = () => upd({ subtitle: subIn.value });
    subRow.append(el(`<span class="small" style="align-self:center">subtitle</span>`), subIn);
    box.appendChild(subRow);

    // visited toggle (locations) / seen toggle (NPCs) — both gate whether the
    // card shows in the players' Knowledge section
    if (cfg.visited) {
      const vRow = el(`<div class="btn-row" style="margin-top:4px"></div>`);
      const vBtn = el(`<button class="mini ${c.visited ? 'primary' : 'ghost'}" title="${c.visited ? 'visited — players can revisit this in their Knowledge section' : 'mark visited — adds it to the players’ Knowledge section'}">${c.visited ? '✓ Visited' : '○ Mark visited'}</button>`);
      vBtn.onclick = () => upd({ visited: !c.visited });
      vRow.appendChild(vBtn);
      box.appendChild(vRow);
    }
    if (cfg.seen) {
      const sRow = el(`<div class="btn-row" style="margin-top:4px"></div>`);
      const sBtn = el(`<button class="mini ${c.seen ? 'primary' : 'ghost'}" title="${c.seen ? 'met — players can revisit this in their Knowledge section' : 'mark seen — adds it to the players’ Knowledge section'}">${c.seen ? '✓ Seen' : '○ Mark seen'}</button>`);
      sBtn.onclick = () => upd({ seen: !c.seen });
      sRow.appendChild(sBtn);
      box.appendChild(sRow);
    }

    // images / slideshow (for NPCs the first image doubles as the map token)
    box.appendChild(el(`<h4 style="margin:10px 0 4px">🖼 Images <span class="muted small">(${cfg.tokenSize ? 'first = map token; ' : ''}slideshow on the reveal)</span></h4>`));
    const strip = el(`<div class="npc-img-strip"></div>`);
    c.images.forEach((path, idx) => {
      const chip = el(`<div class="npc-img-chip"></div>`);
      chip.appendChild(el(`<span class="npc-thumb" style="${thumbStyle(path)}"></span>`));
      if (idx === 0 && cfg.tokenSize) chip.appendChild(el(`<span class="token-badge">TOKEN</span>`));
      const chCtl = el(`<div class="btn-row" style="margin:2px 0;justify-content:center;gap:2px"></div>`);
      const left = el(`<button class="mini ghost" title="move earlier">◀</button>`);
      left.disabled = idx === 0;
      left.onclick = () => { const a = [...c.images]; [a[idx - 1], a[idx]] = [a[idx], a[idx - 1]]; upd({ images: a }); };
      const right = el(`<button class="mini ghost" title="move later">▶</button>`);
      right.disabled = idx === c.images.length - 1;
      right.onclick = () => { const a = [...c.images]; [a[idx + 1], a[idx]] = [a[idx], a[idx + 1]]; upd({ images: a }); };
      const rm = el(`<button class="mini danger ghost" title="remove">✕</button>`);
      rm.onclick = () => upd({ images: c.images.filter((_, i) => i !== idx) });
      chCtl.append(left, right, rm);
      const colWrap = el(`<div style="text-align:center"></div>`);
      colWrap.append(chip, chCtl);
      strip.appendChild(colWrap);
    });
    const addImgWrap = el(`<div style="text-align:center"></div>`);
    const imgFile = el(`<input type="file" accept="image/png,image/jpeg,image/webp" style="display:none">`);
    const addImg = el(`<button class="mini" title="add an image">＋ image</button>`);
    addImg.onclick = () => imgFile.click();
    imgFile.onchange = async () => {
      const file = imgFile.files[0];
      if (!file) return;
      try {
        conn.toast('Uploading image…', true);
        const art = await cardUploadImage(file);
        upd({ images: [...c.images, art] });
      } catch (err) { conn.toast(`upload failed: ${err.message}`, false); }
    };
    addImgWrap.append(addImg, imgFile);
    strip.appendChild(addImgWrap);
    box.appendChild(strip);

    // default token footprint (NPCs only)
    if (cfg.tokenSize) {
      const sizeRow = el(`<div class="btn-row" style="align-items:center;margin-top:6px"></div>`);
      sizeRow.appendChild(el(`<span class="small">token size:</span>`));
      const shapeSel = el(`<select style="max-width:110px"><option value="circle">● round</option><option value="square">■ square</option></select>`);
      shapeSel.value = c.token_shape;
      shapeSel.onchange = () => upd({ token_shape: shapeSel.value });
      const wIn = el(`<input type="number" min="1" max="50" style="width:60px;text-align:center">`);
      const hIn = el(`<input type="number" min="1" max="50" style="width:60px;text-align:center">`);
      wIn.value = c.token_w;
      hIn.value = c.token_h;
      wIn.onchange = () => upd({ token_w: Math.max(1, Math.min(50, Number(wIn.value) || 1)) });
      hIn.onchange = () => upd({ token_h: Math.max(1, Math.min(50, Number(hIn.value) || 1)) });
      sizeRow.append(shapeSel, wIn, el(`<span class="small">×</span>`), hIn, el(`<span class="muted small">cells</span>`));
      box.appendChild(sizeRow);
    }

    // place on the active map (NPCs only)
    if (cfg.placeOnMap && snap.map && snap.camera) {
      const placeRow = el(`<div class="btn-row" style="margin-top:6px"></div>`);
      const place = el(`<button class="mini">♟ Place on map</button>`);
      place.onclick = () => {
        const dims = CampfireMap.gridDims(snap.map);
        const g = CampfireMap.imageToGrid(snap.map, snap.camera.center_x, snap.camera.center_y);
        const col = Math.min(Math.max(g.col, 0), Math.max(0, dims.cols - c.token_w));
        const rw = Math.min(Math.max(g.row, 0), Math.max(0, dims.rows - c.token_h));
        cardUI.placingArt = c.images[0] || null;
        conn.action('token.create', { kind: 'monster', label: c.name, col, row: rw, shape: c.token_shape, w: c.token_w, h: c.token_h });
      };
      placeRow.appendChild(place);
      placeRow.appendChild(el(`<span class="muted small" style="align-self:center">drops at the camera center — then steer it with 🕹 in the map section</span>`));
      box.appendChild(placeRow);
    }

    // GM-only notes (never leave the GM screen)
    box.appendChild(el(`<h4 style="margin:12px 0 4px">📝 GM notes <span class="muted small">(private — never shown on the reveal)</span></h4>`));
    const noteBody = el(`<div class="note-body${c.notes.trim() ? '' : ' empty'}"></div>`);
    noteBody.textContent = c.notes.trim() ? c.notes : 'Tap to add notes…';
    noteBody.onclick = () => openCardTextEditor(`GM notes — ${c.name}`, c.notes, (val) => upd({ notes: val }));
    box.appendChild(noteBody);

    // reveal ambience: a full-screen backdrop image + a particle effect
    box.appendChild(el(`<h4 style="margin:12px 0 4px">🎬 Reveal background &amp; effect <span class="muted small">(shown on the projector when revealed)</span></h4>`));
    const ambRow = el(`<div class="btn-row" style="align-items:center"></div>`);
    if (c.bg_image) ambRow.appendChild(el(`<span class="npc-thumb" style="background-image:url('${c.bg_image}')"></span>`));
    const bgFile = el(`<input type="file" accept="image/png,image/jpeg,image/webp" style="display:none">`);
    const bgBtn = el(`<button class="mini">🖼 ${c.bg_image ? 'change' : 'add'} background</button>`);
    bgBtn.onclick = () => bgFile.click();
    bgFile.onchange = async () => {
      const file = bgFile.files[0];
      if (!file) return;
      try {
        conn.toast('Uploading background…', true);
        const art = await cardUploadImage(file);
        upd({ bg_image: art });
      } catch (err) { conn.toast(`upload failed: ${err.message}`, false); }
    };
    ambRow.append(bgBtn, bgFile);
    if (c.bg_image) {
      const bgClear = el(`<button class="mini ghost" title="remove background (back to the dark gradient)">🚫</button>`);
      bgClear.onclick = () => upd({ bg_image: '' });
      ambRow.appendChild(bgClear);
    }
    box.appendChild(ambRow);

    const FX_LABELS = { none: 'None', embers: '🔥 Embers', snow: '❄ Snow', rain: '🌧 Rain', motes: '✦ Dust motes', arcane: '✨ Arcane sparks' };
    const fxRow = el(`<div class="btn-row" style="align-items:center;margin-top:4px"></div>`);
    fxRow.appendChild(el(`<span class="small">effect:</span>`));
    const fxSel = el(`<select style="max-width:170px"></select>`);
    for (const key of (snap.config.NPC_EFFECTS || ['none', 'embers'])) {
      fxSel.appendChild(el(`<option value="${key}">${FX_LABELS[key] || key}</option>`));
    }
    fxSel.value = c.bg_effect;
    fxSel.onchange = () => upd({ bg_effect: fxSel.value });
    fxRow.appendChild(fxSel);
    box.appendChild(fxRow);

    // reveal chapters/sections + scenes/entries. Each chapter is a collapsible
    // header (tap the title to rename via a popup); the per-chapter 👁/🙈 shows or
    // hides all its scenes on the reveal at once.
    box.appendChild(el(`<h4 style="margin:12px 0 4px">📺 Reveal ${esc(cfg.sectionWord)}s <span class="muted small">(👁 shown · 🙈 hidden${cfg.done ? ' · ✓ done' : ''})</span></h4>`));
    c.sections.forEach((sec, si) => {
      const collapsed = cardUI.collapsedSecs.has(`${c.id}:${si}`);
      const titleRef = { value: sec.title };
      const secBox = el(`<div class="npc-section-block"></div>`);

      const head = el(`<div class="card-chapter-head"></div>`);
      const caret = el(`<button class="mini ghost" title="${collapsed ? 'expand' : 'collapse'}" style="min-width:30px">${collapsed ? '▸' : '▾'}</button>`);
      caret.onclick = () => {
        const key = `${c.id}:${si}`;
        if (cardUI.collapsedSecs.has(key)) cardUI.collapsedSecs.delete(key); else cardUI.collapsedSecs.add(key);
        saveCollapse();
        render();
      };
      const count = sec.entries.length;
      const titleEl = el(`<span class="card-chapter-title" title="tap to rename">${sec.title ? esc(sec.title) : `<span class="muted">(untitled ${esc(cfg.sectionWord)})</span>`}${count ? ` <span class="muted small" style="font-weight:400">· ${count} ${esc(cfg.entryWord)}${count !== 1 ? 's' : ''}</span>` : ''}</span>`);
      titleEl.onclick = () => openTitlePopup(`Rename ${cfg.sectionWord}`, titleRef.value, (v) => { titleRef.value = v; commitSections(readSections()); });
      // chapter-level reveal gate — independent of each scene's own show/hide.
      // 👁 = chapter shown, 🙈 = chapter hidden; tapping flips just this flag.
      const secVis = sec.visible !== false;
      const secEye = el(`<button class="mini ${secVis ? 'primary' : 'ghost'}" title="${secVis ? `hide this whole ${cfg.sectionWord} (keeps each ${cfg.entryWord}'s own show/hide)` : `reveal this ${cfg.sectionWord}`}">${secVis ? '👁' : '🙈'}</button>`);
      secEye.onclick = () => { const next = readSections(); next[si].visible = !secVis; commitSections(next); };
      const secImgN = (sec.images || []).length;
      const secImg = el(`<button class="mini ghost" title="${esc(cfg.sectionWord)} images — join the slideshow when a ${esc(cfg.entryWord)} here is revealed">🖼${secImgN ? ' ' + secImgN : ''}</button>`);
      secImg.onclick = () => openImageManager(`${cfg.sectionWord} images — ${esc(sec.title || 'untitled')}`, sec.images || [], (imgs) => { const next = readSections(); next[si].images = imgs; commitSections(next); });
      const secUp = el(`<button class="mini ghost" title="move ${esc(cfg.sectionWord)} up">↑</button>`);
      secUp.disabled = si === 0;
      secUp.onclick = () => { const next = readSections(); [next[si - 1], next[si]] = [next[si], next[si - 1]]; commitSections(next); };
      const secDown = el(`<button class="mini ghost" title="move ${esc(cfg.sectionWord)} down">↓</button>`);
      secDown.disabled = si === c.sections.length - 1;
      secDown.onclick = () => { const next = readSections(); [next[si + 1], next[si]] = [next[si], next[si + 1]]; commitSections(next); };
      const secDel = el(`<button class="mini danger ghost" title="delete ${esc(cfg.sectionWord)}">🗑</button>`);
      secDel.onclick = () => { if (confirm(`Delete ${cfg.sectionWord} "${titleRef.value || 'untitled'}"?`)) { const next = readSections(); next.splice(si, 1); commitSections(next); } };
      head.append(caret, titleEl, secEye, secImg, secUp, secDown, secDel);
      secBox.appendChild(head);

      const entryEls = [];
      if (!collapsed) {
        sec.entries.forEach((entry, ei) => {
          const er = el(`<div class="npc-entry-row card-scene-row"></div>`);
          const eye = el(`<button class="mini ghost" title="${entry.visible ? 'shown — tap to hide' : 'hidden — tap to show'}">${entry.visible ? '👁' : '🙈'}</button>`);
          eye.onclick = () => conn.action('card.set_entry_visibility', { card_id: c.id, section: si, entry: ei, visible: !entry.visible });
          er.appendChild(eye);
          if (cfg.done) {
            const doneBtn = el(`<button class="mini ${entry.done ? 'primary' : 'ghost'}" title="${entry.done ? 'done — tap to unmark' : 'mark done'}">✓</button>`);
            doneBtn.onclick = () => conn.action('card.set_entry_done', { card_id: c.id, section: si, entry: ei, done: !entry.done });
            er.appendChild(doneBtn);
          }
          const labelIn = el(`<input type="text" maxlength="80" placeholder="${esc(cfg.entryWord)} label" style="max-width:150px">`);
          labelIn.value = entry.label;
          labelIn.onchange = () => commitSections(readSections());
          const preview = entry.text.trim() ? (entry.text.length > 40 ? entry.text.slice(0, 40) + '…' : entry.text) : 'tap to add text…';
          const textBtn = el(`<button class="mini ghost" style="flex:1;text-align:left;min-width:120px;${entry.text.trim() ? '' : 'color:var(--ink-dim)'}">${esc(preview)}</button>`);
          textBtn.onclick = () => openCardTextEditor(`${entry.label || cfg.entryWord} — ${c.name}`, entry.text, (val) => { const next = readSections(); next[si].entries[ei].text = val; commitSections(next); });
          const sImgN = (entry.images || []).length;
          const sImg = el(`<button class="mini ghost" title="${esc(cfg.entryWord)} images — shown on the reveal when this ${esc(cfg.entryWord)} is revealed">🖼${sImgN ? ' ' + sImgN : ''}</button>`);
          sImg.onclick = () => openImageManager(`${entry.label || cfg.entryWord} images`, entry.images || [], (imgs) => { const next = readSections(); next[si].entries[ei].images = imgs; commitSections(next); });
          const eDel = el(`<button class="mini danger ghost" title="delete ${esc(cfg.entryWord)}">✕</button>`);
          eDel.onclick = () => { const next = readSections(); next[si].entries.splice(ei, 1); commitSections(next); };
          er.append(labelIn, textBtn, sImg, eDel);
          secBox.appendChild(er);
          entryEls.push(labelIn);
        });
        const addEntry = el(`<button class="mini" style="margin-top:4px">＋ ${esc(cfg.entryWord)}</button>`);
        addEntry.onclick = () => { const next = readSections(); next[si].entries.push({ label: '', text: '', visible: true, done: false }); commitSections(next); };
        secBox.appendChild(addEntry);
      }
      secEls.push({ titleRef, entryEls, collapsed });
      box.appendChild(secBox);
    });
    const addSec = el(`<button class="mini">＋ ${esc(cfg.sectionWord)}</button>`);
    addSec.onclick = () => { const next = readSections(); next.push({ title: '', entries: [] }); commitSections(next); };
    box.appendChild(addSec);

    const closeRow = el(`<div class="btn-row" style="margin-top:10px;justify-content:flex-end"></div>`);
    const done = el(`<button class="mini" style="background:var(--die-green);color:#0e1f0f;border-color:var(--die-green);font-weight:700">✓ done editing</button>`);
    done.onclick = () => { cardUI.editing = null; render(); };
    closeRow.appendChild(done);
    box.appendChild(closeRow);
    return box;
  }

  // =========================================================================
  // GM reading view: a phone-shaped, vertical version of the projector splash.
  // Shows the token/images slideshow, name, subtitle, GM notes, and EVERY
  // section + entry (hidden ones included, dimmed) with a 👁/🙈 toggle on each
  // so the GM can read at the table and reveal things on the wall as they go.
  // Lives outside render() (like the token mover) so live toggles never flicker.
  // =========================================================================
  let cardViewer = null; // { overlay, cardId, imgwrap, headtext, infoHost, barHost, images }

  // Collapse state for the reading view, so the GM can fold sections/entries to
  // poke around a content-heavy card. Persisted across opens + reloads. Keys are
  // `${cardId}:${si}` for sections and `${cardId}:${si}:${ei}` for entries.
  const VIEWER_COLLAPSE_KEY = 'campfire_gm_viewer_collapse';
  function loadViewerCollapse() {
    try {
      const raw = JSON.parse(localStorage.getItem(VIEWER_COLLAPSE_KEY) || '{}');
      return { secs: new Set(raw.secs || []), entries: new Set(raw.entries || []) };
    } catch (e) { return { secs: new Set(), entries: new Set() }; }
  }
  const viewerCollapse = loadViewerCollapse();
  function saveViewerCollapse() {
    try { localStorage.setItem(VIEWER_COLLAPSE_KEY, JSON.stringify({ secs: [...viewerCollapse.secs], entries: [...viewerCollapse.entries] })); } catch (e) { /* private mode */ }
  }

  // A small, swipeable image carousel (native horizontal scroll-snap) — rebuilt
  // only when the image list changes so a swipe-in-progress is never yanked.
  // onIndex(i) fires whenever the visible image changes (drives the projector).
  function buildViewerCarousel(imgwrap, images, onIndex, initialIndex) {
    imgwrap.innerHTML = '';
    if (images.length === 0) {
      imgwrap.appendChild(el(`<div class="npc-viewer-noimg">👹</div>`));
      return;
    }
    const start = Math.min(Math.max(initialIndex || 0, 0), images.length - 1);
    const car = el(`<div class="npc-viewer-carousel"></div>`);
    const track = el(`<div class="npc-viewer-track"></div>`);
    for (const src of images) {
      const slide = el(`<div class="npc-viewer-slide"></div>`);
      slide.appendChild(el(`<img draggable="false" src="${src}" alt="">`));
      track.appendChild(slide);
    }
    car.appendChild(track);
    imgwrap.appendChild(car);
    // open on the held image (e.g. when reopening the viewer mid-reveal)
    if (start > 0) requestAnimationFrame(() => { track.scrollLeft = start * car.clientWidth; });
    if (images.length > 1) {
      const nav = el(`<div class="npc-carousel-nav"></div>`);
      const prev = el(`<button class="mini ghost" title="previous image">◀</button>`);
      const count = el(`<span class="muted small">${start + 1}/${images.length}</span>`);
      const next = el(`<button class="mini ghost" title="next image">▶</button>`);
      const go = (dir) => track.scrollBy({ left: dir * car.clientWidth, behavior: 'smooth' });
      prev.onclick = () => go(-1);
      next.onclick = () => go(1);
      let lastI = start;
      track.onscroll = () => {
        const i = Math.round(track.scrollLeft / Math.max(1, car.clientWidth));
        count.textContent = `${Math.min(i + 1, images.length)}/${images.length}`;
        if (i !== lastI) { lastI = i; if (onIndex) onIndex(i); }
      };
      nav.append(prev, count, next);
      imgwrap.appendChild(nav);
    }
  }

  // Push the GM's currently-selected image to the projector — but only while
  // this NPC is the one being projected. Sending only on a real change avoids
  // a feedback loop with the snapshot echo.
  function maybePushRevealImage() {
    if (!cardViewer || !snap || snap.revealed_card_id !== cardViewer.cardId) return;
    const serverIdx = snap.revealed_card && typeof snap.revealed_card.image_index === 'number'
      ? snap.revealed_card.image_index : null;
    // holdImage: pin the wall to the GM's selected image; otherwise release to
    // the auto slideshow (null) while the GM keeps reading the details.
    const want = cardViewer.holdImage ? cardViewer.imgIndex : null;
    if (serverIdx !== want) conn.action('card.set_reveal_image', { index: want });
  }

  function openCardViewer(cardId) {
    if (cardViewer) closeCardViewer();
    const overlay = el(`<div class="npc-viewer"></div>`);
    // ambience preview layers (behind the content), matching the projector
    const bgEl = el(`<div class="npc-viewer-bg"></div>`);
    const fxCanvas = el(`<canvas class="npc-viewer-fx"></canvas>`);
    overlay.append(bgEl, fxCanvas);
    const bar = el(`<div class="npc-viewer-bar"></div>`);
    const closeBtn = el(`<button class="mini ghost">✕ close</button>`);
    closeBtn.onclick = closeCardViewer;
    const barHost = el(`<span class="btn-row" style="margin:0;flex:1;justify-content:flex-end"></span>`);
    bar.append(closeBtn, barHost);
    overlay.appendChild(bar);

    const scroll = el(`<div class="npc-viewer-scroll"></div>`);
    // header row: small image (top-left) beside the name/subtitle
    const head = el(`<div class="npc-viewer-head"></div>`);
    const imgwrap = el(`<div class="npc-viewer-imgwrap"></div>`);
    const headtext = el(`<div class="npc-viewer-headtext"></div>`);
    head.append(imgwrap, headtext);
    // fold controls live between the header (image + name/subtitle/live) and the
    // sections list, so the master collapse/expand sit right above the content
    const foldHost = el(`<div class="npc-viewer-fold btn-row" style="margin:4px 0 0"></div>`);
    const infoHost = el(`<div class="npc-viewer-info"></div>`);
    scroll.append(head, foldHost, infoHost);
    overlay.appendChild(scroll);
    CampfireScrollLock.lock();
    document.body.appendChild(overlay);

    // Sync to whatever the projector is already doing for this card: if it's
    // holding an image, open on that image in hold mode; if it's slideshowing,
    // open in slideshow mode; if it isn't projecting, default to hold.
    const revealedHere = snap.revealed_card_id === cardId && snap.revealed_card;
    const heldIdx = (revealedHere && typeof snap.revealed_card.image_index === 'number') ? snap.revealed_card.image_index : null;
    cardViewer = {
      overlay, cardId, imgwrap, headtext, infoHost, foldHost, barHost, images: null,
      bgEl, fxCanvas, fxHandle: null, effect: null, bgImage: null,
      imgIndex: heldIdx !== null ? heldIdx : 0,
      holdImage: revealedHere ? (heldIdx !== null) : true,
    };
    updateCardViewer();
  }

  function closeCardViewer() {
    if (!cardViewer) return;
    if (cardViewer.fxHandle) cardViewer.fxHandle.stop();
    cardViewer.overlay.remove();
    cardViewer = null;
    CampfireScrollLock.unlock();
    // Deliberately DON'T release the held image — the projector keeps showing
    // whatever the GM set, so they can pin "the image we're on" and walk away.
  }

  function updateCardViewer() {
    if (!cardViewer) return;
    const n = (snap.cards || []).find((x) => x.id === cardViewer.cardId);
    if (!n) { closeCardViewer(); return; }
    const cfg = CARD_CFG[n.kind];

    // top bar: optional visited, slideshow toggle, and project on/off. No
    // show/hide-all here — too easy to fat-finger and spoil a reveal mid-scene;
    // bulk visibility lives in the editor instead.
    const isShowing = snap.revealed_card_id === n.id;
    // turning a chapter/scene's images ON while projecting → jump the wall to them
    // (a "reveal"). Pins the projector on the first of those images.
    const revealImagesNow = (on, seci, enti) => {
      if (!on || !isShowing) return;
      const idx = composedJumpIndex(n, seci, enti);
      if (idx >= 0) { cardViewer.holdImage = true; cardViewer.imgIndex = idx; conn.action('card.set_reveal_image', { index: idx }); }
    };
    cardViewer.barHost.innerHTML = '';
    const project = el(`<button class="mini ${isShowing ? 'primary' : ''}" title="show this on the projector + players">${isShowing ? '⏹ Projecting' : '📽 Project'}</button>`);
    project.onclick = () => conn.action('card.reveal', { card_id: isShowing ? null : n.id });
    if (cfg.visited) {
      const vBtn = el(`<button class="mini ${n.visited ? 'primary' : 'ghost'}" title="${n.visited ? 'visited — in the players’ Knowledge; tap to unmark' : 'mark visited — adds to the players’ Knowledge'}">${n.visited ? '✓ visited' : '○ visited'}</button>`);
      vBtn.onclick = () => conn.action('card.update', { card_id: n.id, visited: !n.visited });
      cardViewer.barHost.appendChild(vBtn);
    }
    if (cfg.seen) {
      const sBtn = el(`<button class="mini ${n.seen ? 'primary' : 'ghost'}" title="${n.seen ? 'seen — in the players’ Knowledge; tap to unmark' : 'mark seen — adds to the players’ Knowledge'}">${n.seen ? '✓ seen' : '○ seen'}</button>`);
      sBtn.onclick = () => conn.action('card.update', { card_id: n.id, seen: !n.seen });
      cardViewer.barHost.appendChild(sBtn);
    }
    // hold the wall on your selected image, or let the images slideshow while you
    // keep reading — only meaningful when the composed slideshow has >1 image
    if (composeRevealImages(n).length > 1) {
      const slideBtn = el(`<button class="mini" title="${cardViewer.holdImage ? 'projector is holding your selected image — tap to let it slideshow' : 'projector is running the slideshow — tap to hold your selected image'}">${cardViewer.holdImage ? '🖐 Holding image' : '🎞 Slideshow'}</button>`);
      slideBtn.onclick = () => { cardViewer.holdImage = !cardViewer.holdImage; updateCardViewer(); };
      cardViewer.barHost.appendChild(slideBtn);
    }
    cardViewer.barHost.appendChild(project);

    // connector line on/off — a per-card preference (helps on some cards, noise on
    // others), saved with the card. Drives the projector + player reveals.
    const linkOn = n.show_link !== false;
    const linkBtn = el(`<button class="mini ${linkOn ? 'primary' : 'ghost'}" title="${linkOn ? 'connector line is ON for this card — tap to hide the line from text to image' : 'connector line is OFF for this card — tap to draw a line from text to image'}">${linkOn ? '🔗 Line on' : '🔗 Line off'}</button>`);
    linkBtn.onclick = () => conn.action('card.set_show_link', { card_id: n.id, on: !linkOn });
    cardViewer.barHost.appendChild(linkBtn);

    // pause/resume the projector's slow text crawl so the table can dwell on a
    // section — only meaningful while actually projecting.
    if (isShowing) {
      const paused = !!snap.reveal_scroll_paused;
      const scrollBtn = el(`<button class="mini ${paused ? 'primary' : 'ghost'}" style="white-space:nowrap" title="${paused ? 'text scroll paused — tap to resume the auto-scroll' : 'text is auto-scrolling — tap to pause on what is on screen'}">${paused ? '⏸ Paused' : '⤓ Scroll'}</button>`);
      scrollBtn.onclick = () => conn.action('card.set_scroll_paused', { paused: !paused });
      cardViewer.barHost.appendChild(scrollBtn);
    }

    // master fold controls for the reading view (local only — never touches what's
    // revealed). Collapse folds every section; expand clears this card's folds.
    // They sit in their own row between the header and the sections list.
    cardViewer.foldHost.innerHTML = '';
    if (n.sections.some((s) => s.entries.length)) {
      const collapseAll = el(`<button class="mini ghost" title="collapse every ${esc(cfg.sectionWord)} and ${esc(cfg.entryWord)}">▸ Collapse all</button>`);
      collapseAll.onclick = () => {
        // cascade: fold every section AND every (foldable) entry, so expanding a
        // section still shows its entries folded
        n.sections.forEach((s, si) => {
          if (!s.entries.length) return;
          viewerCollapse.secs.add(`${n.id}:${si}`);
          s.entries.forEach((e, ei) => {
            if (e.text && e.text.trim()) viewerCollapse.entries.add(`${n.id}:${si}:${ei}`);
          });
        });
        saveViewerCollapse(); updateCardViewer();
      };
      const expandAll = el(`<button class="mini ghost" title="expand everything">▾ Expand all</button>`);
      expandAll.onclick = () => {
        const prefix = `${n.id}:`;
        [...viewerCollapse.secs].forEach((k) => { if (k.startsWith(prefix)) viewerCollapse.secs.delete(k); });
        [...viewerCollapse.entries].forEach((k) => { if (k.startsWith(prefix)) viewerCollapse.entries.delete(k); });
        saveViewerCollapse(); updateCardViewer();
      };
      cardViewer.foldHost.append(collapseAll, expandAll);
    }

    // header image carousel — the composed slideshow (card + revealed chapter/
    // scene panels), so the GM swipes the exact set the projector shows. Rebuilt
    // only when that list changes.
    const composed = composeRevealImages(n);
    if (JSON.stringify(composed) !== JSON.stringify(cardViewer.images)) {
      cardViewer.images = composed.slice();
      // keep the current/held index (clamped) so opening lands on the projector's image
      cardViewer.imgIndex = Math.min(Math.max(cardViewer.imgIndex || 0, 0), Math.max(0, composed.length - 1));
      buildViewerCarousel(cardViewer.imgwrap, composed, (i) => { cardViewer.imgIndex = i; maybePushRevealImage(); }, cardViewer.imgIndex);
    }

    // ambience preview (backdrop + particle effect) — mirrors the projector so
    // the GM sees exactly what it looks like; rebuilt only on change.
    if (n.bg_image !== cardViewer.bgImage) {
      cardViewer.bgImage = n.bg_image;
      cardViewer.bgEl.style.backgroundImage = n.bg_image ? `url('${n.bg_image}')` : '';
      cardViewer.bgEl.classList.toggle('has-image', !!n.bg_image);
    }
    if (n.bg_effect !== cardViewer.effect) {
      cardViewer.effect = n.bg_effect;
      if (cardViewer.fxHandle) { cardViewer.fxHandle.stop(); cardViewer.fxHandle = null; }
      const on = n.bg_effect && n.bg_effect !== 'none';
      cardViewer.fxCanvas.style.display = on ? 'block' : 'none';
      if (on) cardViewer.fxHandle = CampfireNpcFx.start(cardViewer.fxCanvas, n.bg_effect);
    }

    // header text: name + subtitle + live indicator
    const ht = cardViewer.headtext;
    ht.innerHTML = '';
    const nameRow = el(`<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"></div>`);
    nameRow.appendChild(el(`<h1 class="npc-viewer-name" style="margin:0">${esc(n.name)}</h1>`));
    // the card's own ("arc") images: a small toggle floating by the name, exactly
    // like the per-chapter 🖼 buttons (🖼 = in the slideshow, 🖼✕ = left out)
    if ((n.images || []).length) {
      const inA = n.images_slides !== false;
      const aBtn = el(`<button class="mini ${inA ? 'primary' : 'ghost'}" title="${n.images.length} card image${n.images.length !== 1 ? 's' : ''} — ${inA ? 'in the slideshow (tap to leave out)' : 'left out of the slideshow (tap to include + reveal)'}">🖼${inA ? '' : '✕'}</button>`);
      aBtn.onclick = () => {
        const on = !inA;
        conn.action('card.update', { card_id: n.id, images_slides: on });
        if (on && isShowing) { cardViewer.holdImage = true; cardViewer.imgIndex = 0; conn.action('card.set_reveal_image', { index: 0 }); }
      };
      nameRow.appendChild(aBtn);
    }
    ht.appendChild(nameRow);
    if (n.subtitle) ht.appendChild(el(`<div class="npc-viewer-sub">${esc(n.subtitle)}</div>`));
    if (isShowing) ht.appendChild(el(`<div class="npc-viewer-live">● live on the projector — your image selection is showing</div>`));

    // info column: notes + sections/entries
    const info = cardViewer.infoHost;
    info.innerHTML = '';
    if (n.notes.trim()) {
      info.appendChild(el(`<div class="npc-viewer-sec-title">📝 GM notes (private)</div>`));
      info.appendChild(el(`<div class="npc-viewer-notes">${esc(n.notes)}</div>`));
    }

    if (n.sections.length === 0 || n.sections.every((s) => s.entries.length === 0)) {
      info.appendChild(el(`<p class="muted small">No ${esc(cfg.entryWord)}s yet — add some with ✎ edit.</p>`));
    }
    // public section index — mirrors publicRevealedCard so a Focus button points
    // the projector at the right (visible-only) section. Only sections that are
    // visible AND have a visible entry actually reach the wall.
    let pubIdx = -1;
    n.sections.forEach((sec, si) => {
      if (sec.entries.length === 0) return;
      const secImgN = (sec.images || []).length;
      const secVis = sec.visible !== false;
      const sectionPublic = secVis && sec.entries.some((e) => e.visible);
      let myPub = -1;
      if (sectionPublic) { pubIdx += 1; myPub = pubIdx; }
      const secKey = `${n.id}:${si}`;
      const secCollapsed = viewerCollapse.secs.has(secKey);
      const sh = el(`<div class="npc-viewer-sec-title" style="display:flex;align-items:center;gap:8px${secVis ? '' : ';opacity:.5'}"></div>`);
      // fold this whole section (reading-view only; doesn't touch what's revealed)
      const secCaret = el(`<button class="mini ghost" title="${secCollapsed ? 'expand' : 'collapse'} this ${esc(cfg.sectionWord)}" style="min-width:30px">${secCollapsed ? '▸' : '▾'}</button>`);
      secCaret.onclick = () => { if (secCollapsed) viewerCollapse.secs.delete(secKey); else viewerCollapse.secs.add(secKey); saveViewerCollapse(); updateCardViewer(); };
      sh.appendChild(secCaret);
      // show/hide the whole chapter via its own gate (scene toggles stay as set)
      const chEye = el(`<button class="mini ${secVis ? 'primary' : 'ghost'}" title="${secVis ? `hide this whole ${cfg.sectionWord}` : `reveal this whole ${cfg.sectionWord}`}">${secVis ? '👁' : '🙈'}</button>`);
      chEye.onclick = () => conn.action('card.set_section_visible', { card_id: n.id, section: si, visible: !secVis });
      sh.appendChild(chEye);
      sh.appendChild(el(`<span style="flex:1;min-width:0">${sec.title ? esc(sec.title) : '<span style="opacity:.5">(untitled)</span>'}${secVis ? '' : ' <span class="muted small">· hidden</span>'}</span>`));
      if (secImgN) {
        const inS = sec.slides !== false;
        const b = el(`<button class="mini ${inS ? 'primary' : 'ghost'}" title="${secImgN} ${esc(cfg.sectionWord)} image${secImgN !== 1 ? 's' : ''} — ${inS ? 'in the slideshow (tap to leave out)' : 'left out of the slideshow (tap to include + reveal)'}">🖼${inS ? '' : '✕'}</button>`);
        b.onclick = () => { const on = !inS; conn.action('card.set_section_slides', { card_id: n.id, section: si, slides: on }); revealImagesNow(on, si, null); };
        sh.appendChild(b);
      }
      // jump the projector to this whole section and spotlight it (only while
      // projecting and only for sections actually on the wall)
      const focus = snap.reveal_focus;
      if (isShowing && sectionPublic) {
        const focused = !!focus && focus.section === myPub && (focus.entry === null || focus.entry === undefined);
        const focusBtn = el(`<button class="mini ${focused ? 'primary' : 'ghost'}" title="${focused ? 'whole section spotlighted — tap to clear' : 'scroll the projector here and spotlight this whole section'}">${focused ? '🎯 Focused' : '🎯 Focus'}</button>`);
        focusBtn.onclick = () => conn.action('card.set_focus', { section: focused ? null : myPub, entry: null });
        sh.appendChild(focusBtn);
      }
      info.appendChild(sh);
      if (secCollapsed) {
        const cnt = sec.entries.length;
        sh.appendChild(el(`<span class="muted small" style="flex:none">· ${cnt} ${esc(cfg.entryWord)}${cnt === 1 ? '' : 's'}</span>`));
        return; // folded — skip its entries
      }
      // public entry index — mirrors publicRevealedCard (visible entries only) so
      // a per-entry Focus button points the projector at the right entry
      let pubEnt = -1;
      sec.entries.forEach((entry, ei) => {
        const entryPublic = sectionPublic && entry.visible;
        let myEnt = -1;
        if (entryPublic) { pubEnt += 1; myEnt = pubEnt; }
        const entKey = `${n.id}:${si}:${ei}`;
        const collapsible = !!(entry.text && entry.text.trim());
        const entCollapsed = collapsible && viewerCollapse.entries.has(entKey);
        const row = el(`<div class="npc-viewer-entry ${entry.visible ? '' : 'is-hidden'}"></div>`);
        if (collapsible) {
          const entCaret = el(`<button class="mini ghost" title="${entCollapsed ? 'expand' : 'collapse'} this ${esc(cfg.entryWord)}" style="min-width:28px">${entCollapsed ? '▸' : '▾'}</button>`);
          entCaret.onclick = () => { if (entCollapsed) viewerCollapse.entries.delete(entKey); else viewerCollapse.entries.add(entKey); saveViewerCollapse(); updateCardViewer(); };
          row.appendChild(entCaret);
        }
        const eye = el(`<button class="mini ${entry.visible ? '' : 'ghost'}" title="${entry.visible ? 'shown on the reveal — tap to hide' : 'hidden — tap to reveal'}">${entry.visible ? '👁' : '🙈'}</button>`);
        eye.onclick = () => conn.action('card.set_entry_visibility', { card_id: n.id, section: si, entry: ei, visible: !entry.visible });
        row.appendChild(eye);
        // spotlight just this entry on the projector
        if (isShowing && entryPublic) {
          const efocused = !!focus && focus.section === myPub && focus.entry === myEnt;
          const efTitle = efocused
            ? `this ${esc(cfg.entryWord)} is spotlighted — tap to clear`
            : `scroll the projector here and spotlight just this ${esc(cfg.entryWord)}`;
          const efBtn = el(`<button class="mini ${efocused ? 'primary' : 'ghost'}" title="${efTitle}">🎯</button>`);
          efBtn.onclick = () => conn.action('card.set_focus', efocused ? { section: null } : { section: myPub, entry: myEnt });
          row.appendChild(efBtn);
        }
        if (cfg.done) {
          const doneBtn = el(`<button class="mini ${entry.done ? 'primary' : 'ghost'}" title="${entry.done ? 'done — tap to unmark' : 'mark done'}">✓</button>`);
          doneBtn.onclick = () => conn.action('card.set_entry_done', { card_id: n.id, section: si, entry: ei, done: !entry.done });
          row.appendChild(doneBtn);
        }
        const eImgN = (entry.images || []).length;
        if (eImgN) {
          const inS = entry.slides !== false;
          const sBtn = el(`<button class="mini ${inS ? 'primary' : 'ghost'}" title="${eImgN} ${esc(cfg.entryWord)} image${eImgN !== 1 ? 's' : ''} — ${inS ? 'in the slideshow (tap to leave out)' : 'left out of the slideshow (tap to include + reveal)'}">🖼${inS ? '' : '✕'}</button>`);
          sBtn.onclick = () => { const on = !inS; conn.action('card.set_entry_slides', { card_id: n.id, section: si, entry: ei, slides: on }); revealImagesNow(on, si, ei); };
          row.appendChild(sBtn);
        }
        const body = el(`<div class="npc-viewer-entry-body"${entry.done ? ' style="opacity:.55;text-decoration:line-through"' : ''}></div>`);
        if (entry.label) body.appendChild(el(`<div class="npc-viewer-label">${esc(entry.label)}</div>`));
        if (entCollapsed) {
          // folded — show the label only, or a short preview when unlabeled so the
          // row is still identifiable
          if (!entry.label) {
            const preview = entry.text.trim().slice(0, 60);
            body.appendChild(el(`<div class="npc-viewer-text muted">${esc(preview)}${entry.text.trim().length > 60 ? '…' : ''}</div>`));
          }
        } else {
          if (entry.text) body.appendChild(el(`<div class="npc-viewer-text">${esc(entry.text)}</div>`));
          if (!entry.label && !entry.text) body.appendChild(el(`<div class="npc-viewer-text muted">(empty)</div>`));
        }
        row.appendChild(body);
        info.appendChild(row);
      });
    });

    // if we're projecting this NPC, make sure the wall is on the GM's selected
    // image (also kicks in the moment they hit Project from this viewer)
    maybePushRevealImage();
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
